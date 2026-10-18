import type { InboxNotification } from './types';
import { agentGet, agentPost } from './agent-api';

// 收件箱数据：消息列表 + 未读数
export interface InboxData {
  list: InboxNotification[];
  unreadCount: number;
}

// 收件箱列表（最新在前）
export function listInbox() {
  return agentGet<InboxData>('/api/inbox');
}

// 标记已读：缺省 id 全部已读，带 id 标记单条；返回最新未读数
export function markInboxRead(id?: string) {
  return agentPost<{ unreadCount: number }>('/api/inbox/read', id ? { id } : undefined);
}