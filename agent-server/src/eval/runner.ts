import { randomUUID } from 'node:crypto';
import { runAgentLoop, resumeAfterConfirmation, type EventSink } from '../agent-loop';
import type { SSEEvent } from '../sse';
import type { CurrentUser } from '../auth';
import type { Session } from '../session';
import type { EvalCase } from './cases';

// 单条用例的运行参数：token 用于真实调用平台后端/向量检索，user 用于构造会话上下文
export interface RunOptions {
  token: string;
  user: CurrentUser;
  /** 遇到写工具确认请求时是否自动同意；false 则自动取消，避免写用例污染数据 */
  autoApprove: boolean;
}

export interface EvalResult {
  caseId: string;
  name: string;
  passed: boolean;
  expectedTools: string[];
  toolsCalled: string[];
  keywordsHit: string[];
  keywordsMiss: string[];
  finalAnswer: string;
  error?: string;
}

// 运行单条用例：直接驱动 agent 循环（离线，不经 HTTP/SSE），收集事件后按规则判定
export async function runEvalCase(caseDef: EvalCase, opts: RunOptions): Promise<EvalResult> {
  const session: Session = { history: [], token: opts.token, user: opts.user, pendingConfirmation: null };
  session.history.push({ role: 'user', content: caseDef.question });

  const events: SSEEvent[] = [];
  const emit: EventSink = (event) => {
    events.push(event);
  };
  const sessionId = randomUUID();

  try {
    await runAgentLoop({ emit, session, sessionId, signal: AbortSignal.timeout(180000) });
    // 写工具会以 confirmation_request 结束本轮；按 autoApprove 自动确认/取消后继续，直至产出最终答复
    while (session.pendingConfirmation) {
      const confirmId = session.pendingConfirmation.confirmId;
      await resumeAfterConfirmation({
        emit,
        session,
        sessionId,
        confirmId,
        approved: opts.autoApprove,
        signal: AbortSignal.timeout(180000),
      });
    }
  } catch (err) {
    return {
      ...buildBase(caseDef, events, session),
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return judge(caseDef, events, session);
}

// 规则判定：工具命中 + 关键词，任一不满足即不通过
function judge(caseDef: EvalCase, events: SSEEvent[], session: Session): EvalResult {
  const result = buildBase(caseDef, events, session);

  const toolMatch = caseDef.expectTools.every((t) => result.toolsCalled.includes(t));
  const keywordsMiss = result.keywordsMiss.length === 0;
  const forbidHit = (caseDef.forbidKeywords ?? []).filter((k) => result.finalAnswer.includes(k)).length === 0;
  result.passed = toolMatch && keywordsMiss && forbidHit;

  return result;
}

function buildBase(caseDef: EvalCase, events: SSEEvent[], session: Session): EvalResult {
  const toolsCalled: string[] = [];
  for (const e of events) {
    if (e.type === 'tool_call' && typeof e.name === 'string') toolsCalled.push(e.name);
    if (e.type === 'confirmation_request' && typeof e.toolName === 'string') toolsCalled.push(e.toolName);
  }

  const finalAnswer = extractFinalAnswer(session);
  const keywords = caseDef.expectKeywords ?? [];

  return {
    caseId: caseDef.id,
    name: caseDef.name,
    passed: false,
    expectedTools: caseDef.expectTools,
    toolsCalled: [...new Set(toolsCalled)],
    keywordsHit: keywords.filter((k) => finalAnswer.includes(k)),
    keywordsMiss: keywords.filter((k) => !finalAnswer.includes(k)),
    finalAnswer,
  };
}

// 取会话历史中最后一条 assistant 文本作为最终回答
function extractFinalAnswer(session: Session): string {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const m = session.history[i];
    if (m.role === 'assistant' && typeof m.content === 'string') return m.content;
  }
  return '';
}