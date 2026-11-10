import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { buildSystemPrompt } from './prompts';
import { TOOL_DEFINITIONS, isWriteTool, WRITE_TOOL_META, type WriteToolMeta } from './tools/definitions';
import { executeTool, stringifyToolResult } from './tools/executor';
import { formatHistoryForRewrite } from './rag/query-rewrite';
import type { SSEEvent } from './sse';
import { truncateIfNeeded, signatureOf, type PendingBatch, type PendingConfirmation, type Session } from './session';

// 单轮对话内允许的最大工具调用轮次，防止死循环
const MAX_ROUNDS = 8;

// 确认请求有效期（毫秒）
const CONFIRM_TTL = 5 * 60 * 1000;

// OpenAI 客户端（OpenAI 兼容协议，baseURL 可配置任意厂商）
const client = new OpenAI({
  baseURL: config.openaiBaseUrl,
  apiKey: config.openaiApiKey,
});

// 流式返回时 tool_calls 的分片累积结构（arguments 为分片字符串，需拼接后再解析）
interface ToolCallAccum {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// 事件输出回调：解耦 agent 循环与 SSE/HTTP 输出，在线走 SSE，离线评测走事件收集器
export type EventSink = (event: SSEEvent) => void;

export interface AgentLoopOptions {
  emit: EventSink;
  session: Session;
  sessionId: string;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// [修复] 并发与不变式防护
//
// 不变式：history 中任意一条 assistant(tool_calls) 消息，其每个 tool_call_id
// 都必须能在其后紧邻的位置找到一条 tool 消息，否则下一次模型请求必然 400。
// 下面这些辅助函数专门保证该不变式在任何异常路径下都不被破坏。
// ---------------------------------------------------------------------------

// 同一 session 的 resume 串行化，避免并发确认导致「重复回填 + 双重续跑」
const sessionLocks = new WeakMap<Session, Promise<unknown>>();

// 标记正在执行主循环的 session，避免同一会话并发跑两份 agent 循环
const runningSessions = new WeakSet<Session>();

// [修复] 写工具成功签名（模块级，与 session 生命周期一致）：
// 命中时直接回填「已执行过」提示，不再重复弹确认框。
const succeededSigs = new WeakMap<Session, Set<string>>();

function withSessionLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(session) ?? Promise.resolve();
  // 上一个任务无论成功或失败，都继续执行下一个，避免一次异常把锁永久卡死
  const run = prev.then(fn, fn);
  sessionLocks.set(session, run.then(() => undefined, () => undefined));
  return run;
}

function getSucceededSigs(session: Session): Set<string> {
  let set = succeededSigs.get(session);
  if (!set) {
    set = new Set<string>();
    succeededSigs.set(session, set);
  }
  return set;
}

function markSucceeded(session: Session, name: string, args: Record<string, unknown>): void {
  if (!isWriteTool(name)) return;
  getSucceededSigs(session).add(signatureOf(name, args));
}

function isAlreadySucceeded(session: Session, name: string, args: Record<string, unknown>): boolean {
  if (!isWriteTool(name)) return false;
  return getSucceededSigs(session).has(signatureOf(name, args));
}

const MISSING_RESULT_CONTENT = JSON.stringify({
  error: 'MISSING_TOOL_RESULT',
  detail: '该工具调用缺少结果（可能因异常中断），已自动补全为错误结果。禁止原样重试，请向用户说明情况。',
});

// [修复] 历史完整性修复：为所有缺少 tool 结果的 assistant(tool_calls) 就地补齐，
// 保持「assistant → 其 tool 消息组」的原始顺序，而不是简单追加到末尾。
function ensureHistoryIntegrity(session: Session): void {
  const src = session.history;
  const out: ChatCompletionMessageParam[] = [];
  let i = 0;
  while (i < src.length) {
    const m = src[i];
    out.push(m);
    i++;
    if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) continue;

    // 收集紧随其后的 tool 消息组
    const following: ChatCompletionMessageParam[] = [];
    while (i < src.length && src[i].role === 'tool') {
      following.push(src[i]);
      i++;
    }
    out.push(...following);

    const have = new Set<string>();
    for (const t of following) {
      if (t.role === 'tool') have.add(t.tool_call_id);
    }
    for (const tc of m.tool_calls) {
      if (have.has(tc.id)) continue;
      out.push({ role: 'tool', tool_call_id: tc.id, content: MISSING_RESULT_CONTENT });
      have.add(tc.id);
    }
  }
  if (out.length !== src.length) {
    src.length = 0;
    src.push(...out);
  }
}

// [修复] 幂等回填：待确认批处理完成后，按 toolCallIds 原始顺序补齐 tool 消息，
// 已存在的 tool_call_id 跳过，避免并发路径重复 push 同一 tool 消息。
function flushBatchResults(session: Session, batch: PendingBatch): void {
  const existing = new Set<string>();
  for (const m of session.history) {
    if (m.role === 'tool') existing.add(m.tool_call_id);
  }
  for (const id of batch.toolCallIds) {
    if (existing.has(id)) continue;
    session.history.push({
      role: 'tool',
      tool_call_id: id,
      content: batch.results[id] ?? MISSING_RESULT_CONTENT,
    });
    existing.add(id);
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

// [修复] 解析失败不再静默降级为 {}，而是显式返回错误，交由调用方回注给模型并登记失败。
type ParsedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

function parseArgs(raw: string): ParsedArgs {
  if (!raw) return { ok: true, args: {} };
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, raw, error: 'arguments 必须是 JSON 对象' };
    }
    return { ok: true, args: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, raw, error: (e as Error)?.message ?? String(e) };
  }
}

function argsOf(p: { parsed: ParsedArgs }): Record<string, unknown> {
  return p.parsed.ok ? p.parsed.args : {};
}

function invalidArgsToolResult(name: string, error: string): string {
  return JSON.stringify({
    error: 'INVALID_ARGUMENTS',
    tool: name,
    detail: `参数解析失败：${error}。本次未执行该工具。`,
    required_action: '禁止用相同原始参数重试，请修正 JSON 后重新调用。',
  });
}

// ---------------------------------------------------------------------------
// 工具执行封装（带异常兜底与取消检查）
// ---------------------------------------------------------------------------

// [修复] executeTool 统一兜底：内部抛出/网络异常一律转成 { ok:false }，
// 保证调用方始终能拿到可回填的结果；同时响应 AbortSignal。
async function executeToolSafely(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  idempotencyKey?: string
): Promise<{ ok: boolean; result: unknown; aborted: boolean; retried?: boolean }> {
  if (signal.aborted) {
    return { ok: false, aborted: true, result: { cancelled: true, message: '请求已取消，工具未执行' } };
  }
  try {
    const r = await executeTool(name, args, {
      token: session.token,
      history: formatHistoryForRewrite(session.history),
      idempotencyKey,
    });
    return { ok: r.ok, aborted: false, result: r.result, retried: r.retried };
  } catch (e) {
    return {
      ok: false,
      aborted: signal.aborted,
      result: { error: 'TOOL_EXECUTION_THREW', detail: (e as Error)?.message ?? String(e) },
    };
  }
}

// 执行单个工具并回传结果（事件输出）；不回写历史，由调用方决定回填时机
async function executeToolAndEmit(
  emit: EventSink,
  session: Session,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  step: number,
  signal: AbortSignal
): Promise<{ ok: boolean; content: string }> {
  emit({ type: 'tool_call', toolCallId, name, arguments: args });
  const { ok, result, aborted, retried } = await executeToolSafely(session, name, args, signal);
  emit({ type: 'tool_result', toolCallId, name, ok, result });
  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：工具返回 ${name}`,
    detail: aborted ? '已取消，未执行' : ok ? '执行成功' : '执行失败',
    data: result,
  });
  // 写工具首次请求超时后按同一幂等键重试成功：向用户提示，避免误判为失败
  if (retried && ok) {
    emit({
      type: 'log',
      step,
      title: '检测到服务响应超时，已自动重试',
      detail: `${name} 首次请求超时，已按同一幂等键重试并成功，未重复写入`,
    });
  }
  // 取消导致的未执行不算工具失败，不登记签名，避免误导模型
  if (!aborted) {
    if (!ok) recordFailure(session, name, args);
    else markSucceeded(session, name, args);
  }
  return { ok, content: stringifyToolResult(result) };
}

// 执行单个工具并把结果立即写入会话历史（全部只读的分支使用）
async function runAndEmit(
  emit: EventSink,
  session: Session,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  step: number,
  signal: AbortSignal
): Promise<void> {
  const { content } = await executeToolAndEmit(emit, session, toolCallId, name, args, step, signal);
  session.history.push({ role: 'tool', tool_call_id: toolCallId, content });
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

// 核心 Agent 循环入口：做入口守卫，保证同一会话不会并发跑两份循环
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { emit, session } = opts;

  // [修复] 挂起批未处理时禁止开启新循环，否则 history 中残留的 assistant(tool_calls)
  // 会因缺少 tool 回填而让下一次请求必然 400。
  if (session.pendingBatch) {
    emit({ type: 'error', message: '当前有未处理的待确认写操作，请先确认或取消后再继续对话' });
    return;
  }

  if (runningSessions.has(session)) {
    emit({ type: 'error', message: '当前会话正在处理中，请等待本轮结束后再发送' });
    return;
  }

  runningSessions.add(session);
  try {
    await runAgentLoopInner(opts);
  } finally {
    runningSessions.delete(session);
  }
}

async function runAgentLoopInner(opts: AgentLoopOptions): Promise<void> {
  const { emit, session, sessionId, signal } = opts;
  const history = session.history;
  truncateIfNeeded(history);
  // [修复] 截断可能把 assistant(tool_calls) 与其 tool 消息拆到两侧，这里就地补齐
  ensureHistoryIntegrity(session);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) {
      emit({ type: 'error', message: '请求已取消' });
      emit({ type: 'message_end', finishReason: 'stop' });
      return;
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(session.user.name) },
      ...history,
    ];

    emit({
      type: 'log',
      step: round,
      title: `第 ${round} 步：模型思考`,
      detail: '调用大模型，携带 OA 工具定义',
    });

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      stream = await client.chat.completions.create(
        {
          model: config.openaiModel,
          messages,
          tools: TOOL_DEFINITIONS,
          stream: true,
        },
        { signal }
      );
    } catch (e) {
      emit({
        type: 'error',
        message: signal.aborted ? '请求已取消' : `模型调用失败：${(e as Error)?.message ?? String(e)}`,
      });
      emit({ type: 'message_end', finishReason: 'stop' });
      return;
    }

    emit({ type: 'message_start', role: 'assistant' });

    let content = '';
    // [修复] 使用 (ToolCallAccum | undefined)[] 承载可能稀疏的 index，
    // 累积完成后统一过滤掉空洞与缺失 id/name 的残片。
    const rawToolCalls: (ToolCallAccum | undefined)[] = [];

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          emit({ type: 'message_delta', content: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!rawToolCalls[idx]) {
              rawToolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            const acc = rawToolCalls[idx]!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.function.name = tc.function.name;
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      // [修复] 流式中断：已下发 message_start，必须补 message_end，并回滚未完成的工具调用意图
      if (signal.aborted) {
        emit({ type: 'error', message: '请求已取消' });
      } else {
        emit({ type: 'error', message: `模型流式响应中断：${(e as Error)?.message ?? String(e)}` });
      }
      if (content) history.push({ role: 'assistant', content });
      emit({ type: 'message_end', finishReason: 'stop' });
      return;
    }

    const toolCalls = rawToolCalls.filter(
      (c): c is ToolCallAccum => Boolean(c) && Boolean(c.id) && Boolean(c.function?.name)
    );

    emit({
      type: 'log',
      step: round,
      title: `第 ${round} 步：模型回复（流式）`,
      detail: toolCalls.length === 0 ? '模型给出纯文本回答' : `模型决定调用 ${toolCalls.length} 个工具`,
      data: { content },
    });

    // 纯文本回答：写入会话历史并结束循环
    if (toolCalls.length === 0) {
      // [修复] 空 content 在部分厂商会触发 400，给一个占位文本
      history.push({ role: 'assistant', content: content || '（模型未返回内容）' });
      emit({ type: 'message_end', finishReason: 'stop' });
      return;
    }

    // 模型发起了工具调用：先记录 assistant 消息（含 tool_calls），随后按读写分流处理
    const assistantMsg: ChatCompletionMessageParam = {
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls as ChatCompletionMessageToolCall[],
    };
    history.push(assistantMsg);

    const parsed = toolCalls.map((call) => ({
      call,
      name: call.function.name,
      parsed: parseArgs(call.function.arguments),
    }));
    const writeIdx = parsed.findIndex((p) => isWriteTool(p.name));

    for (const p of parsed) {
      emit({
        type: 'log',
        step: round,
        title: `第 ${round} 步：决策工具 ${p.name}`,
        detail: !p.parsed.ok
          ? '参数解析失败，将回注错误结果'
          : isWriteTool(p.name)
            ? '写操作，需用户确认后执行'
            : '只读操作，直接执行',
        data: p.parsed.ok ? p.parsed.args : { __raw__: p.parsed.raw },
      });
    }

    emit({ type: 'message_end', finishReason: writeIdx === -1 ? 'tool_calls' : 'confirmation_required' });

    // 全部只读：顺序执行后进入下一轮
    if (writeIdx === -1) {
      for (const p of parsed) {
        // [修复] 参数解析失败：回注错误 + 登记失败，不再用空参数执行
        if (!p.parsed.ok) {
          const content = invalidArgsToolResult(p.name, p.parsed.error);
          recordFailure(session, p.name, { __raw__: p.parsed.raw });
          emit({
            type: 'log',
            step: round,
            title: `第 ${round} 步：参数无效 ${p.name}`,
            detail: p.parsed.error,
            data: { __raw__: p.parsed.raw },
          });
          history.push({ role: 'tool', tool_call_id: p.call.id, content });
          continue;
        }
        const args = p.parsed.args;
        const blocked = shortCircuitIfRepeated(session, p.name, args, emit, round);
        if (blocked !== null) {
          // [修复] 短路时必须同样回填 tool 消息并补发 tool_result，否则 history 缺项 → 400
          emit({ type: 'tool_result', toolCallId: p.call.id, name: p.name, ok: false, result: JSON.parse(blocked) });
          history.push({ role: 'tool', tool_call_id: p.call.id, content: blocked });
          continue;
        }
        await runAndEmit(emit, session, p.call.id, p.name, args, round, signal);
      }
      continue;
    }

    // 存在写工具：建待处理批（含原始顺序），只读立即执行并缓存结果，写工具逐个入确认队列
    const batch: PendingBatch = {
      toolCallIds: parsed.map((p) => p.call.id),
      results: {},
      pending: [],
    };

    // 先处理只读工具 + 参数非法的写工具（非法参数不弹确认，直接回注错误）
    for (const p of parsed) {
      if (isWriteTool(p.name)) continue;
      if (!p.parsed.ok) {
        const content = invalidArgsToolResult(p.name, p.parsed.error);
        recordFailure(session, p.name, { __raw__: p.parsed.raw });
        emit({
          type: 'log',
          step: round,
          title: `第 ${round} 步：参数无效 ${p.name}`,
          detail: p.parsed.error,
          data: { __raw__: p.parsed.raw },
        });
        batch.results[p.call.id] = content;
        continue;
      }
      const args = p.parsed.args;
      const blocked = shortCircuitIfRepeated(session, p.name, args, emit, round);
      if (blocked !== null) {
        batch.results[p.call.id] = blocked;
        continue;
      }
      const { content } = await executeToolAndEmit(emit, session, p.call.id, p.name, args, round, signal);
      batch.results[p.call.id] = content;
    }

    for (const p of parsed) {
      if (!isWriteTool(p.name)) continue;

      if (!p.parsed.ok) {
        const content = invalidArgsToolResult(p.name, p.parsed.error);
        recordFailure(session, p.name, { __raw__: p.parsed.raw });
        emit({
          type: 'log',
          step: round,
          title: `第 ${round} 步：参数无效 ${p.name}`,
          detail: p.parsed.error,
          data: { __raw__: p.parsed.raw },
        });
        batch.results[p.call.id] = content;
        continue;
      }

      const args = p.parsed.args;

      // L2：同签名写调用已失败过则短路——不执行、不入确认队列（避免重复弹窗骚扰用户）
      const blocked = shortCircuitIfRepeated(session, p.name, args, emit, round);
      if (blocked !== null) {
        batch.results[p.call.id] = blocked;
        continue;
      }

      // [修复] 同签名写操作已成功执行过：直接回填「已执行」提示，不再重复弹确认框
      if (isAlreadySucceeded(session, p.name, args)) {
        emit({
          type: 'log',
          step: round,
          title: `第 ${round} 步：跳过重复写操作 ${p.name}`,
          detail: '相同工具、相同参数的写操作此前已成功执行，本次跳过',
          data: args,
        });
        batch.results[p.call.id] = JSON.stringify({
          skipped: true,
          reason: 'DUPLICATE_WRITE_SKIPPED',
          detail: '相同工具、相同参数的写操作此前已成功执行，本次已跳过，未重复执行。若确需再次执行，请修改参数或联系用户确认。',
        });
        continue;
      }

      const meta = WRITE_TOOL_META[p.name];
      const pending: PendingConfirmation = {
        confirmId: randomUUID(),
        toolName: p.name,
        args,
        toolCallId: p.call.id,
        step: round,
        title: meta.title,
        summary: buildSummary(meta, args),
        severity: meta.severity,
        expiresAt: Date.now() + CONFIRM_TTL,
      };
      batch.pending.push(pending);

      emit({
        type: 'log',
        step: round,
        title: `第 ${round} 步：等待用户确认`,
        detail: `${meta.title}：${pending.summary}`,
        data: args,
      });

      emit({
        type: 'confirmation_request',
        sessionId,
        confirmId: pending.confirmId,
        toolName: p.name,
        operationType: 'write',
        title: meta.title,
        summary: pending.summary,
        payload: args,
        severity: meta.severity,
      });
    }

    // 整批调用全部被短路/跳过/非法：无待确认项，直接按原始顺序回填并续跑，
    // 让模型基于「禁止重复执行」指令重新规划（否则会挂起等待不存在的确认）
    if (batch.pending.length === 0) {
      flushBatchResults(session, batch);
      continue;
    }

    session.pendingBatch = batch;
    return;
  }

  emit({ type: 'error', message: '工具调用轮次超过上限，请换个更具体的问题试试' });
  // [修复] 超限路径补发 message_end，避免前端一直等待本轮结束
  emit({ type: 'message_end', finishReason: 'stop' });
}

// ---------------------------------------------------------------------------
// 确认续传
// ---------------------------------------------------------------------------

// 续传入口：[修复] 用 session 级互斥串行化，杜绝并发确认导致的「重复回填 + 双重续跑」
export async function resumeAfterConfirmation(opts: {
  emit: EventSink;
  session: Session;
  sessionId: string;
  confirmId: string;
  approved: boolean;
  signal: AbortSignal;
}): Promise<void> {
  await withSessionLock(opts.session, () => resumeAfterConfirmationInner(opts));
}

async function resumeAfterConfirmationInner(opts: {
  emit: EventSink;
  session: Session;
  sessionId: string;
  confirmId: string;
  approved: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { emit, session, sessionId, confirmId, approved, signal } = opts;
  const batch = session.pendingBatch;
  if (!batch) {
    emit({ type: 'error', message: '当前没有待确认的操作' });
    return;
  }
  const pending = batch.pending.find((p) => p.confirmId === confirmId);
  if (!pending) {
    emit({ type: 'error', message: '确认请求不存在或已被处理' });
    return;
  }

  // [修复] 过期路径：移除该项 + 回填为「未执行」+ 若批次已空则正常续跑，
  // 不再直接 return 把 pendingBatch 永久卡住。
  if (pending.expiresAt < Date.now()) {
    batch.pending = batch.pending.filter((p) => p.confirmId !== confirmId);
    emit({
      type: 'confirmation_result',
      sessionId,
      confirmId,
      approved: false,
      rejectedReason: '确认请求已过期',
    });
    emit({
      type: 'log',
      step: pending.step,
      title: `第 ${pending.step} 步：确认已过期`,
      detail: `${pending.toolName} 未执行`,
    });
    batch.results[pending.toolCallId] = JSON.stringify({
      cancelled: true,
      message: '确认请求已过期，该操作未执行',
    });
    if (batch.pending.length === 0) {
      session.pendingBatch = null;
      flushBatchResults(session, batch);
      await runAgentLoop({ emit, session, sessionId, signal });
    }
    return;
  }

  const step = pending.step;
  // 从待确认队列移除该项（confirmId 一次性消费，防重放）
  batch.pending = batch.pending.filter((p) => p.confirmId !== confirmId);

  emit({
    type: 'confirmation_result',
    sessionId,
    confirmId,
    approved,
    rejectedReason: approved ? '' : '用户取消',
  });
  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：${approved ? '用户已确认' : '用户已取消'}`,
    detail: pending.toolName,
  });

  let result: unknown;
  let ok = approved;
  let aborted = false;
  let retried = false;
  if (approved) {
    // [修复] 走带兜底的执行封装，异常/取消不会让 pendingBatch 残留
    // confirmId 作为幂等键：超时重试时后端按同一 key 去重，保证该次写只落库一次
    const executed = await executeToolSafely(session, pending.toolName, pending.args, signal, pending.confirmId);
    ok = executed.ok;
    result = executed.result;
    aborted = executed.aborted;
    retried = executed.retried ?? false;
    if (!aborted) {
      // 确认执行的写操作失败也登记签名：模型若原样重试将被短路，不再重复弹确认框
      if (!ok) recordFailure(session, pending.toolName, pending.args);
      else markSucceeded(session, pending.toolName, pending.args);
    }
  } else {
    result = { cancelled: true, message: '用户已取消该操作' };
  }

  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：工具返回 ${pending.toolName}`,
    detail: aborted ? '已取消，未执行' : approved ? (ok ? '执行成功' : '执行失败') : '已取消，未执行',
    data: result,
  });

  // 写工具首次请求超时后按同一幂等键重试成功：向用户提示，避免误判为失败
  if (retried && ok) {
    emit({
      type: 'log',
      step,
      title: '检测到服务响应超时，已自动重试',
      detail: `${pending.toolName} 首次请求超时，已按同一幂等键重试并成功，未重复写入`,
    });
  }

  // 缓存该写工具结果，待本轮全部写操作确认后按原始顺序回填
  batch.results[pending.toolCallId] = stringifyToolResult(result);

  // 若本轮还有未确认的写操作，等待用户逐项确认，暂不回填、不续跑
  if (batch.pending.length > 0) {
    return;
  }

  // 本轮全部写操作已处理：按 tool_calls 原始顺序幂等回填 tool 消息，再续跑主循环
  session.pendingBatch = null;
  flushBatchResults(session, batch);

  await runAgentLoop({ emit, session, sessionId, signal });
}

// ---------------------------------------------------------------------------
// 重复调用检测
// ---------------------------------------------------------------------------

// L2 同签名短路：该调用签名已失败过则拦截——不真正执行（写工具也不弹确认框），
// 直接构造「禁止重复执行 + 三选一」纠偏指令作为 tool 结果回注，打破模型重复调用循环。
// 返回短路结果字符串；未命中短路返回 null
function shortCircuitIfRepeated(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  emit: EventSink,
  step: number
): string | null {
  const sig = signatureOf(name, args);
  const failedTimes = session.failedSigs.get(sig) ?? 0;
  if (failedTimes < 1) return null;

  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：拦截重复调用 ${name}`,
    detail: `相同工具相同参数已失败 ${failedTimes} 次，本次短路，未真正执行`,
    data: args,
  });

  return JSON.stringify({
    error: 'DUPLICATE_CALL_BLOCKED',
    tool: name,
    detail: `该调用（相同工具、相同参数）此前已执行并失败 ${failedTimes} 次，已被拦截，本次未真正执行。`,
    required_action: '禁止原样重试。你必须三选一：1. 修改参数后重试；2. 更换其他工具达成目标；3. 向用户说明卡点并请求补充信息。',
  });
}

// L1 失败登记：工具执行失败时累计该签名的失败次数，供后续同签名调用短路判定
function recordFailure(session: Session, name: string, args: Record<string, unknown>): void {
  const sig = signatureOf(name, args);
  session.failedSigs.set(sig, (session.failedSigs.get(sig) ?? 0) + 1);
}

// 根据写工具元信息拼装确认摘要，如「标题: 提交周报，优先级: HIGH」
export function buildSummary(meta: WriteToolMeta, args: Record<string, unknown>): string {
  const parts = meta.summaryFields
    .map((f) => {
      const v = args[f.key];
      if (v === undefined || v === null || v === '') return null;
      return `${f.label}: ${String(v)}`;
    })
    .filter((s): s is string => s !== null);
  return parts.join('，');
}