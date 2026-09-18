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
import { truncateIfNeeded, type Session } from './session';

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

    // 全部只读：顺序执行后进入下一轮
    if (writeIdx === -1) {
      for (const p of parsed) {
        await runAndEmit(emit, session, p.call.id, p.name, p.args, round);
      }
      continue;
    }

    // 存在写工具：先执行只读工具（无副作用），再拦截写工具发确认请求
    for (let i = 0; i < parsed.length; i++) {
      if (isWriteTool(parsed[i].name)) continue;
      await runAndEmit(emit, session, parsed[i].call.id, parsed[i].name, parsed[i].args, round);
    }

    const write = parsed[writeIdx];
    const meta = WRITE_TOOL_META[write.name];
    const pending = {
      confirmId: randomUUID(),
      toolName: write.name,
      args: write.args,
      toolCallId: write.call.id,
      step: round,
      title: meta.title,
      summary: buildSummary(meta, write.args),
      severity: meta.severity,
      expiresAt: Date.now() + CONFIRM_TTL,
    };
    session.pendingConfirmation = pending;

    emit({
      type: 'log',
      step: round,
      title: `第 ${round} 步：等待用户确认`,
      detail: `${meta.title}：${pending.summary}`,
      data: write.args,
    });

    emit({
      type: 'confirmation_request',
      sessionId,
      confirmId: pending.confirmId,
      toolName: write.name,
      operationType: 'write',
      title: meta.title,
      summary: pending.summary,
      payload: write.args,
      severity: meta.severity,
    });
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
  const pending = session.pendingConfirmation;
  if (!pending || pending.confirmId !== confirmId || pending.expiresAt < Date.now()) {
    emit({ type: 'error', message: '确认请求不存在或已过期' });
    return;
  }
  const step = pending.step;
  session.pendingConfirmation = null;

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

  // 追加 tool 结果，与先前未完成的 assistant tool_call 消息对应
  session.history.push({
    role: 'tool',
    tool_call_id: pending.toolCallId,
    content: stringifyToolResult(result),
  });

  await runAgentLoop({ emit, session, sessionId, signal });
}

// 执行单个工具并回传结果，同时把 tool 结果写入会话历史
async function runAndEmit(
  emit: EventSink,
  session: Session,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  step: number
): Promise<void> {
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
  session.history.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: stringifyToolResult(result),
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