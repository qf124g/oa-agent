import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CurrentUser } from './auth';

// 待确认的写操作：写工具被拦截后暂存，等待用户确认或取消
export interface PendingConfirmation {
  confirmId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  step: number; // 该写操作所在的推理轮次（第几步）
  // 操作标题/摘要/严重级别，供前端确认框展示
  title: string;
  summary: string;
  severity: 'normal' | 'high' | 'dangerous';
  expiresAt: number; // 过期时间戳，超时失效
}

// 单个会话的状态：消息历史 + 鉴权上下文 + 待确认写操作
export interface Session {
  history: ChatCompletionMessageParam[];
  token: string;
  user: CurrentUser;
  pendingConfirmation: PendingConfirmation | null;
}

const sessions = new Map<string, Session>();

// 会话历史上限，超出后从头部截断
const MAX_HISTORY = 40;

export function getOrCreateSession(sessionId: string, token: string, user: CurrentUser): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { history: [], token, user, pendingConfirmation: null };
    sessions.set(sessionId, session);
    return session;
  }
  // 同会话续传时刷新鉴权上下文（token 可能更新）
  session.token = token;
  session.user = user;
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

// 截断历史：从头部删到某个 user 消息之后，保证不会把 tool 消息拆成开头（tool 消息必须紧跟对应的 assistant 消息）
export function truncateIfNeeded(history: ChatCompletionMessageParam[]): void {
  while (history.length > MAX_HISTORY) {
    const firstUserIdx = history.findIndex((m) => m.role === 'user');
    if (firstUserIdx === -1 || firstUserIdx >= history.length - 1) break;
    history.splice(0, firstUserIdx + 1);
  }
}