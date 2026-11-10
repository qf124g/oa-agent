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

// 核心 Agent 循环：
// 1. 携带工具定义流式请求大模型
// 2. 文本增量通过 message_delta 实时下发给前端
// 3. 模型发起工具调用时，只读工具直接执行（HTTP 调平台后端），写工具被拦截发确认请求
// 4. 模型给出纯文本回答时结束循环
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { emit, session, sessionId, signal } = opts;
  const history = session.history;
  truncateIfNeeded(history);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
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

    const stream = await client.chat.completions.create(
      {
        model: config.openaiModel,
        messages,
        tools: TOOL_DEFINITIONS,
        stream: true,
      },
      { signal }
    );

    emit({ type: 'message_start', role: 'assistant' });

    let content = '';
    const toolCalls: ToolCallAccum[] = [];

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
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }

    emit({
      type: 'log',
      step: round,
      title: `第 ${round} 步：模型回复（流式）`,
      detail: toolCalls.length === 0 ? '模型给出纯文本回答' : `模型决定调用 ${toolCalls.length} 个工具`,
      data: { content },
    });

    // 纯文本回答：写入会话历史并结束循环
    if (toolCalls.length === 0) {
      history.push({ role: 'assistant', content });
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
      args: parseArgs(call.function.arguments),
    }));
    const writeIdx = parsed.findIndex((p) => isWriteTool(p.name));

    for (const p of parsed) {
      emit({
        type: 'log',
        step: round,
        title: `第 ${round} 步：决策工具 ${p.name}`,
        detail: isWriteTool(p.name) ? '写操作，需用户确认后执行' : '只读操作，直接执行',
        data: p.args,
      });
    }

    emit({ type: 'message_end', finishReason: writeIdx === -1 ? 'tool_calls' : 'confirmation_required' });

    // 全部只读：顺序执行后进入下一轮（同签名重试由 L2 短路，不真正执行）
    if (writeIdx === -1) {
      for (const p of parsed) {
        if (shortCircuitIfRepeated(session, p.name, p.args, emit, round) !== null) continue;
        await runAndEmit(emit, session, p.call.id, p.name, p.args, round);
      }
      continue;
    }

    // 存在写工具：建待处理批（含原始顺序），只读立即执行并缓存结果，写工具逐个入确认队列
    const batch: PendingBatch = {
      toolCallIds: parsed.map((p) => p.call.id),
      results: {},
      pending: [],
    };

    for (const p of parsed) {
      if (isWriteTool(p.name)) continue;
      const blocked = shortCircuitIfRepeated(session, p.name, p.args, emit, round);
      if (blocked !== null) {
        batch.results[p.call.id] = blocked;
        continue;
      }
      const { content } = await executeToolAndEmit(emit, session, p.call.id, p.name, p.args, round);
      batch.results[p.call.id] = content;
    }

    for (const p of parsed) {
      if (!isWriteTool(p.name)) continue;
      // L2：同签名写调用已失败过则短路——不执行、不入确认队列（避免重复弹窗骚扰用户）
      const blocked = shortCircuitIfRepeated(session, p.name, p.args, emit, round);
      if (blocked !== null) {
        batch.results[p.call.id] = blocked;
        continue;
      }
      const meta = WRITE_TOOL_META[p.name];
      const pending: PendingConfirmation = {
        confirmId: randomUUID(),
        toolName: p.name,
        args: p.args,
        toolCallId: p.call.id,
        step: round,
        title: meta.title,
        summary: buildSummary(meta, p.args),
        severity: meta.severity,
        expiresAt: Date.now() + CONFIRM_TTL,
      };
      batch.pending.push(pending);

      emit({
        type: 'log',
        step: round,
        title: `第 ${round} 步：等待用户确认`,
        detail: `${meta.title}：${pending.summary}`,
        data: p.args,
      });

      emit({
        type: 'confirmation_request',
        sessionId,
        confirmId: pending.confirmId,
        toolName: p.name,
        operationType: 'write',
        title: meta.title,
        summary: pending.summary,
        payload: p.args,
        severity: meta.severity,
      });
    }
    // 整批调用全部被短路：无待确认项，直接按原始顺序回填短路结果并续跑，
    // 让模型基于「禁止重复执行」指令重新规划（否则会挂起等待不存在的确认）
    if (batch.pending.length === 0) {
      for (const toolCallId of batch.toolCallIds) {
        history.push({ role: 'tool', tool_call_id: toolCallId, content: batch.results[toolCallId] ?? '{}' });
      }
      continue;
    }

    session.pendingBatch = batch;
    return;
  }

  emit({ type: 'error', message: '工具调用轮次超过上限，请换个更具体的问题试试' });
}

// 续传：用户确认（或取消）后执行真正落库 / 构造取消结果，再续跑主循环产出最终答复
export async function resumeAfterConfirmation(opts: {
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
  if (!pending || pending.expiresAt < Date.now()) {
    emit({ type: 'error', message: '确认请求不存在或已过期' });
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
  if (approved) {
    const executed = await executeTool(pending.toolName, pending.args, { token: session.token, history: formatHistoryForRewrite(session.history) });
    ok = executed.ok;
    result = executed.result;
    // 确认执行的写操作失败也登记签名：模型若原样重试将被短路，不再重复弹确认框
    if (!ok) recordFailure(session, pending.toolName, pending.args);
  } else {
    result = { cancelled: true, message: '用户已取消该操作' };
  }

  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：工具返回 ${pending.toolName}`,
    detail: approved ? (ok ? '执行成功' : '执行失败') : '已取消，未执行',
    data: result,
  });

  // 缓存该写工具结果，待本轮全部写操作确认后按原始顺序回填
  batch.results[pending.toolCallId] = stringifyToolResult(result);

  // 若本轮还有未确认的写操作，等待用户逐项确认，暂不回填、不续跑
  if (batch.pending.length > 0) {
    return;
  }

  // 本轮全部写操作已处理：按 tool_calls 原始顺序回填 tool 消息（一个不能少），再续跑主循环
  session.pendingBatch = null;
  for (const toolCallId of batch.toolCallIds) {
    session.history.push({ role: 'tool', tool_call_id: toolCallId, content: batch.results[toolCallId] ?? '{}' });
  }

  await runAgentLoop({ emit, session, sessionId, signal });
}

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

// 执行单个工具并回传结果（事件输出），返回执行是否成功与序列化结果；不回写历史，由调用方决定回填时机
async function executeToolAndEmit(
  emit: EventSink,
  session: Session,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  step: number
): Promise<{ ok: boolean; content: string }> {
  emit({ type: 'tool_call', toolCallId, name, arguments: args });
  const { ok, result } = await executeTool(name, args, { token: session.token, history: formatHistoryForRewrite(session.history) });
  emit({ type: 'tool_result', toolCallId, name, ok, result });
  emit({
    type: 'log',
    step,
    title: `第 ${step} 步：工具返回 ${name}`,
    detail: ok ? '执行成功' : '执行失败',
    data: result,
  });
  if (!ok) recordFailure(session, name, args);
  return { ok, content: stringifyToolResult(result) };
}

// 执行单个工具并把结果立即写入会话历史（全部只读的分支使用）
async function runAndEmit(
  emit: EventSink,
  session: Session,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  step: number
): Promise<void> {
  const { content } = await executeToolAndEmit(emit, session, toolCallId, name, args, step);
  session.history.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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