import { config } from '../config';
import { getSkill, runSkillScript } from '../skills';
import { searchKnowledge, invalidateIndex } from '../rag/knowledge-sync';

// 工具执行上下文：透传前端 Bearer token，调用平台后端时附加鉴权头
export interface ToolContext {
  token: string;
}

// 工具执行结果
export interface ToolExecution {
  ok: boolean;
  result: unknown;
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

// 执行工具：调用平台后端 API 并解析统一响应结构；知识库写操作后同步失效向量索引
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  // 本地向量检索，不调平台后端
  if (name === 'search_knowledge') {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { ok: false, result: { error: '检索问题不能为空' } };
    }
    try {
      const hits = await searchKnowledge(query, ctx.token);
      return { ok: true, result: { hits } };
    } catch (err) {
      return { ok: false, result: { error: `知识库检索失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  // 加载技能步骤（本地只读）
  if (name === 'use_skill') {
    const skillId = String(args.skillId ?? '').trim();
    if (!skillId) return { ok: false, result: { error: '技能 ID 不能为空' } };
    const skill = getSkill(skillId);
    if (!skill) return { ok: false, result: { error: `未找到技能: ${skillId}` } };
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
    return { ok: false, result: { error: `未知工具: ${name}` } };
  }

  try {
    const { method, path, body } = route(args);
    const res = await fetch(config.platformApiBase + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.token}`,
        // 标记来源为助手代办：后端领域事件据此避免「助手代办 → 又回推助手」的自循环
        'X-Source': 'agent',
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => null)) as { code: number; message: string; data: unknown } | null;
    if (!json) {
      return { ok: false, result: { error: `平台接口返回异常（HTTP ${res.status}）` } };
    }
    if (json.code !== 0) {
      return { ok: false, result: { error: json.message || '平台接口返回错误' } };
    }
    // 知识库写操作命中后，使向量索引失效，下次检索前重新同步
    if (name === 'add_knowledge_document' || name === 'delete_knowledge_document') {
      invalidateIndex();
    }
    return { ok: true, result: json.data };
  } catch (err) {
    return { ok: false, result: { error: `工具执行失败: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

// 工具结果序列化为字符串供回传大模型，超长时截断防止上下文膨胀
export function stringifyToolResult(result: unknown): string {
  let text = JSON.stringify(result);
  if (text.length > 16 * 1024) {
    text = text.slice(0, 16 * 1024) + '...[结果已截断]';
  }
  return text;
}