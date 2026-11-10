import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../prompts';
import type { SSEEvent } from '../sse';
import type { Session } from '../session';
import type { EvalCase } from './cases';
import type { EvalResult } from './runner';

// 评测 trace 记录：把一次用例运行中「大模型每轮调用的输入与返回」完整落盘，
// 作为错误场景案例的原始证据与后续迭代/新项目参考（见 documents/Agent错误场景案例与消息序列记录.md）。
//
// 记录内容：
//   - 每轮发给模型的 messages（system 仅首轮全量，后续折叠为占位符避免文件膨胀）
//   - 模型每轮返回的内容：文本 / tool_calls（名称 + 参数）
//   - 每次工具执行的返回（含 L0 结构化错误、L2 短路指令的原文）
//   - 最终会话历史与判定结果

// trace 文件输出目录：agent-server/eval-traces
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = path.resolve(currentDir, '../../eval-traces');

// 单轮 trace：一次模型调用的输入与输出
interface RoundTrace {
  round: number;
  // 该轮发给模型的 messages（system 仅首轮保留全文）
  inputMessages: unknown[];
  // 模型返回的文本内容（纯文本回答轮即最终答案）
  assistantText: string;
  // 模型返回的工具调用决策
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  // 本轮工具执行结果（含失败时的 L0 结构化错误 / L2 短路指令原文）
  toolResults: { name: string; ok: boolean; result: unknown }[];
  // 本轮运行日志（含「拦截重复调用」等防护机制触发记录）
  logs: { title: string; detail: string }[];
}

// 把一条消息折叠为 trace 友好的精简结构（tool_calls 保留名称与解析后的参数）
function summarizeMessage(msg: Record<string, unknown>, keepSystemFull: boolean): unknown {
  const role = msg.role;
  if (role === 'system') {
    const content = String(msg.content ?? '');
    return keepSystemFull ? { role, content } : { role, content: `[system 提示词已折叠，共 ${content.length} 字]` };
  }
  if (role === 'tool') {
    return { role, tool_call_id: msg.tool_call_id, content: msg.content };
  }
  const out: Record<string, unknown> = { role, content: msg.content ?? '' };
  if (Array.isArray(msg.tool_calls)) {
    out.tool_calls = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
      id: tc.id,
      name: (tc.function as Record<string, unknown> | undefined)?.name,
      arguments: tryParse((tc.function as Record<string, unknown> | undefined)?.arguments),
    }));
  }
  return out;
}

function tryParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// 从事件流重建各轮 trace：
//   1. message_start/message_delta/message_end/tool_call/tool_result/log 事件按序切出轮次；
//   2. 每轮输入 messages 通过 toolCallId 在 session.history 中定位该轮 assistant 消息，
//      取其之前的历史 + system 提示词还原（与 agent-loop 实际拼装逻辑一致）。
export function buildTrace(events: SSEEvent[], session: Session): { rounds: RoundTrace[] } {
  const rounds: RoundTrace[] = [];
  let current: RoundTrace | null = null;
  let roundNo = 0;

  for (const e of events) {
    if (e.type === 'message_start') {
      roundNo += 1;
      current = { round: roundNo, inputMessages: [], assistantText: '', toolCalls: [], toolResults: [], logs: [] };
      rounds.push(current);
      continue;
    }
    if (!current) continue;
    if (e.type === 'message_delta' && typeof e.content === 'string') {
      current.assistantText += e.content;
    } else if (e.type === 'tool_call') {
      current.toolCalls.push({
        id: String(e.toolCallId ?? ''),
        name: String(e.name ?? ''),
        arguments: (e.arguments as Record<string, unknown>) ?? {},
      });
    } else if (e.type === 'tool_result') {
      current.toolResults.push({ name: String(e.name ?? ''), ok: Boolean(e.ok), result: e.result });
    } else if (e.type === 'log' && typeof e.title === 'string') {
      current.logs.push({ title: e.title, detail: String(e.detail ?? '') });
    }
  }

  const history = session.history as unknown as Array<Record<string, unknown>>;
  const systemPrompt = buildSystemPrompt(session.user.name);

  for (const r of rounds) {
    let cutAt = history.length;
    if (r.toolCalls.length > 0) {
      // 工具调用轮：输入 = 该轮 assistant 消息之前的历史
      const ids = new Set(r.toolCalls.map((tc) => tc.id));
      const idx = history.findIndex(
        (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as Array<Record<string, unknown>>).some((t) => ids.has(String(t.id)))
      );
      if (idx >= 0) cutAt = idx;
    } else {
      // 纯文本回答轮：输入 = 末尾 assistant 文本消息之前的历史
      const last = history[history.length - 1];
      if (last && last.role === 'assistant' && typeof last.content === 'string' && !Array.isArray(last.tool_calls)) {
        cutAt = history.length - 1;
      }
    }
    const system = { role: 'system', content: systemPrompt };
    r.inputMessages = [summarizeMessage(system, r.round === 1), ...history.slice(0, cutAt).map((m) => summarizeMessage(m, false))];
  }

  return { rounds };
}

// 写盘：每条用例一个 JSON 文件，文件名含用例 id 与时间戳，返回文件路径
export function writeTrace(caseDef: EvalCase, events: SSEEvent[], session: Session, result: EvalResult): string {
  mkdirSync(TRACE_DIR, { recursive: true });
  const trace = buildTrace(events, session);
  const payload = {
    case: { id: caseDef.id, name: caseDef.name, question: caseDef.question },
    result: {
      passed: result.passed,
      expectedTools: result.expectedTools,
      toolsCalled: result.toolsCalled,
      finalAnswer: result.finalAnswer,
      error: result.error ?? null,
    },
    rounds: trace.rounds,
    // 完整最终历史（含全部 tool 消息原文），便于逐条复盘上下文演化
    finalHistory: (session.history as unknown as Array<Record<string, unknown>>).map((m) => summarizeMessage(m, false)),
    recordedAt: new Date().toISOString(),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(TRACE_DIR, `${caseDef.id}_${stamp}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}
