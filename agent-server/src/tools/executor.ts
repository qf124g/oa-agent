import { config } from '../config';
import { getSkill, runSkillScript } from '../skills';
import { buildErrorFeedback, buildTransientError, buildMalformedResponseError } from './error-feedback';
import { searchKnowledge, invalidateIndex } from '../rag/knowledge-sync';
import { rewriteQueryForSearch, splitMultiIntentQuery } from '../rag/query-rewrite';
import type { SearchHit } from '../rag/vector-index';

// 工具执行上下文：透传前端 Bearer token，调用平台后端时附加鉴权头
export interface ToolContext {
  token: string;
  // 对话历史文本（用于 search_knowledge 检索前的 query 改写）
  history: string;
  // 幂等键：写工具透传，后端按此去重（超时重试时保证同一逻辑写只落库一次）
  idempotencyKey?: string;
}

// 工具执行结果
export interface ToolExecution {
  ok: boolean;
  result: unknown;
  // 写工具首次请求超时后按同一幂等键重试成功时标记，供上层向用户提示「已自动重试」
  retried?: boolean;
}

// 拼接查询串：仅保留允许的参数键且值有效
function withQuery(path: string, args: Record<string, unknown>, allowedKeys: string[]): string {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

// 工具名 -> 平台后端 REST 请求映射（search_knowledge 为本地向量检索，单独处理）
const TOOL_ROUTES: Record<string, (args: Record<string, unknown>) => Route> = {
  get_workbench_stats: () => ({ method: 'GET', path: '/api/dashboard/stats' }),
  get_my_todos: (a) => ({ method: 'GET', path: withQuery('/api/todos', a, ['ownerId', 'status', 'page', 'pageSize']) }),
  get_my_approvals: (a) => ({ method: 'GET', path: withQuery('/api/approvals/mine', a, ['type', 'status', 'page', 'pageSize']) }),
  get_pending_approvals: (a) => ({ method: 'GET', path: withQuery('/api/approvals/pending', a, ['page', 'pageSize']) }),
  list_announcements: (a) => ({ method: 'GET', path: withQuery('/api/announcements', a, ['page', 'pageSize']) }),
  get_announcement_detail: (a) => ({ method: 'GET', path: `/api/announcements/${a.id}` }),
  list_departments: () => ({ method: 'GET', path: '/api/departments' }),
  list_employees: (a) => ({ method: 'GET', path: withQuery('/api/employees', a, ['departmentId', 'name', 'page', 'pageSize']) }),
  get_employee_detail: (a) => ({ method: 'GET', path: `/api/employees/${a.employeeId}` }),
  list_knowledge_documents: (a) => ({ method: 'GET', path: withQuery('/api/knowledge', a, ['category', 'page', 'pageSize']) }),
  create_todo: (a) => ({ method: 'POST', path: '/api/todos', body: { title: a.title, description: a.description, priority: a.priority, dueDate: a.dueDate, ownerId: a.ownerId } }),
  complete_todo: (a) => ({ method: 'PATCH', path: `/api/todos/${a.id}/complete` }),
  create_approval: (a) => ({ method: 'POST', path: '/api/approvals', body: { type: a.type, title: a.title, detail: a.detail, amount: a.amount } }),
  approve_approval: (a) => ({ method: 'POST', path: `/api/approvals/${a.id}/approve`, body: { comment: a.comment } }),
  reject_approval: (a) => ({ method: 'POST', path: `/api/approvals/${a.id}/reject`, body: { comment: a.comment } }),
  create_announcement: (a) => ({ method: 'POST', path: '/api/announcements', body: { title: a.title, content: a.content, pinned: a.pinned } }),
  add_knowledge_document: (a) => ({ method: 'POST', path: '/api/knowledge', body: { title: a.title, content: a.content, category: a.category } }),
  delete_knowledge_document: (a) => ({ method: 'DELETE', path: `/api/knowledge/${a.id}` }),
};

// 合并多个子查询的检索结果：按（docId + 文本）去重，按相似度降序，截断到 limit
function mergeHits(groups: SearchHit[][], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const group of groups) {
    for (const hit of group) {
      const key = `${hit.docId}\u0000${hit.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

// 对账查询：写工具重试耗尽后，用同一幂等键查后端是否已写入。
// 命中返回首次执行结果（视为成功）；未命中或查询失败返回 undefined（上层再报服务不可用）。
async function reconcileByIdempotencyKey(key: string, token: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(`${config.platformApiBase}/api/idempotency/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => null)) as { code: number; data: { found: boolean; result: unknown } } | null;
    if (json && json.code === 0 && json.data?.found) {
      return json.data.result;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// 执行工具：调用平台后端 API 并解析统一响应结构；知识库写操作后同步失效向量索引
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  // 本地向量检索，不调平台后端
  if (name === 'search_knowledge') {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { ok: false, result: { error: 'MISSING_PARAM', tool: name, field: 'query', hint: '检索问题不能为空，请传入具体的检索关键词' } };
    }
    try {
      const rewritten = await rewriteQueryForSearch(query, ctx.history);
      const subQueries = await splitMultiIntentQuery(rewritten);
      // 多意图：拆分为多个子问题分别检索，再合并去重
      if (subQueries.length > 1) {
        const groups = await Promise.all(subQueries.map((q) => searchKnowledge(q, ctx.token)));
        const hits = mergeHits(groups, subQueries.length * config.knowledgeTopK);
        return {
          ok: true,
          result: {
            hits,
            rewritten: rewritten === query ? undefined : { original: query, rewritten },
            subQueries,
          },
        };
      }
      const hits = await searchKnowledge(rewritten, ctx.token);
      return {
        ok: true,
        result: { hits, rewritten: rewritten === query ? undefined : { original: query, rewritten } },
      };
    } catch (err) {
      return { ok: false, result: { error: `知识库检索失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  // 加载技能步骤（本地只读）
  if (name === 'use_skill') {
    const skillId = String(args.skillId ?? '').trim();
    if (!skillId) return { ok: false, result: { error: 'MISSING_PARAM', tool: name, field: 'skillId', hint: '技能 ID 不能为空' } };
    const skill = getSkill(skillId);
    if (!skill) {
      return { ok: false, result: { error: 'NOT_FOUND', tool: name, field: 'skillId', received: skillId, hint: `未找到技能 ${skillId}。可用技能见系统提示中的技能概览，请勿猜测技能 ID` } };
    }
    return { ok: true, result: { id: skill.id, name: skill.name, description: skill.description, steps: skill.body } };
  }

  // 执行技能本地脚本（只读，不发后端请求）
  if (name === 'run_skill_script') {
    const skillId = String(args.skillId ?? '').trim();
    const script = String(args.script ?? '').trim();
    const scriptArgs = (args.args ?? {}) as Record<string, unknown>;
    const r = await runSkillScript(skillId, script, scriptArgs);
    return r.ok ? { ok: true, result: r.result } : { ok: false, result: { error: r.error } };
  }

  const route = TOOL_ROUTES[name];
  if (!route) {
    return { ok: false, result: { error: 'UNKNOWN_TOOL', tool: name, hint: `工具 ${name} 不存在，请从工具定义列表中选择正确的工具名` } };
  }

  const { method, path, body } = route(args);
  const isWrite = method !== 'GET';
  // 写工具带幂等键时：超时/网络故障后按同一 key 有限重试，后端按 key 去重，重试不会重复落库
  const maxAttempts = isWrite && ctx.idempotencyKey ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.token}`,
        // 标记来源为助手代办：后端领域事件据此避免「助手代办 → 又回推助手」的自循环
        'X-Source': 'agent',
      };
      // 写请求透传幂等键：后端以 key 为主键缓存首次执行结果，重试命中则直接返回
      if (isWrite && ctx.idempotencyKey) headers['Idempotency-Key'] = ctx.idempotencyKey;

      const res = await fetch(config.platformApiBase + path, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10000),
      });
      const json = (await res.json().catch(() => null)) as { code: number; message: string; data: unknown } | null;
      if (!json) {
        return { ok: false, result: buildMalformedResponseError(name, res.status) };
      }
      if (json.code !== 0) {
        // L0：把面向人的错误文案转成结构化修复指令回注给模型，打破同参重试循环
        return { ok: false, result: buildErrorFeedback(name, args, json.message || '平台接口返回错误') };
      }
      // 知识库写操作命中后，使向量索引失效，下次检索前重新同步
      if (name === 'add_knowledge_document' || name === 'delete_knowledge_document') {
        invalidateIndex();
      }
      return { ok: true, result: json.data, retried: attempt > 0 };
    } catch (err) {
      // 拿到真实 HTTP 响应后的业务/解析失败已在上方 return，走到这里仅可能是 fetch 抛出的网络/超时故障
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const isLast = attempt === maxAttempts - 1;
      if (isLast) {
        // 重试耗尽后对账：后端可能已写成功只是响应丢失，用同一幂等键取回结果，避免误报失败
        if (isWrite && ctx.idempotencyKey) {
          const reconciled = await reconcileByIdempotencyKey(ctx.idempotencyKey, ctx.token);
          if (reconciled !== undefined) {
            console.log(`[executor] ${name} 重试耗尽后按幂等键对账命中，取回已写入结果`);
            return { ok: true, result: reconciled, retried: true };
          }
        }
        console.log(`[executor] ${name} 第 ${attempt + 1} 次调用失败（${reason}），已达重试上限且对账未命中，返回 SERVICE_UNAVAILABLE`);
        return { ok: false, result: buildTransientError(name, err) };
      }
      // 非最后一次：短暂退避后按同一幂等键重试（幂等保证安全）
      console.log(`[executor] ${name} 第 ${attempt + 1} 次调用失败（${reason}），${300 * (attempt + 1)}ms 后以同一 Idempotency-Key 重试`);
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  // 理论不可达：循环内必 return，此处兜底
  return { ok: false, result: buildTransientError(name, new Error('unreachable')) };
}

// 工具结果序列化为字符串供回传大模型，超长时截断防止上下文膨胀
export function stringifyToolResult(result: unknown): string {
  let text = JSON.stringify(result);
  if (text.length > 16 * 1024) {
    text = text.slice(0, 16 * 1024) + '...[结果已截断]';
  }
  return text;
}