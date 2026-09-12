import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { writeSSE } from './sse';

// 助手主动触达：常驻事件通道（SSE）连接管理 + 领域事件转模板推送
// 连接注册表按用户维度维护（同一用户可能开多个标签页，全部推送）

// 推送消息：模板文案 + 快捷操作（按钮点击代发预置指令，走正常 agent 循环）
export interface AgentNotification {
  id: string;
  title: string; // 推送标题（如「待办提醒」）
  content: string;
  actions: Array<{ label: string; sendText: string }>;
  createdAt: number;
}

// 领域事件（由 backend 通过 POST /internal/events 上报）
export interface DomainEvent {
  type: 'todo.created' | 'employee.created';
  actorId: string;
  source: 'web' | 'agent';
  data: Record<string, unknown>;
}

const connections = new Map<string, Set<Response>>();

// 离线收件箱：用户无在线连接时暂存，连接建立后补发；每用户上限 20 条防内存膨胀
const offlineInbox = new Map<string, AgentNotification[]>();
const OFFLINE_INBOX_CAP = 20;

// 注册事件连接，返回注销函数；注册后立即补发离线消息
export function registerEventConnection(userId: string, res: Response): () => void {
  let set = connections.get(userId);
  if (!set) {
    set = new Set();
    connections.set(userId, set);
  }
  set.add(res);

  const inbox = offlineInbox.get(userId);
  if (inbox && inbox.length > 0) {
    offlineInbox.delete(userId);
    for (const n of inbox) {
      writeSSE(res, { type: 'notify', notification: n as unknown as Record<string, unknown> });
    }
  }

  return () => {
    set.delete(res);
    if (set.size === 0) connections.delete(userId);
  };
}

// 推送目标用户：在线则实时下发，离线则入收件箱
function pushToUser(userId: string, notification: AgentNotification): void {
  const set = connections.get(userId);
  if (!set || set.size === 0) {
    const inbox = offlineInbox.get(userId) ?? [];
    inbox.push(notification);
    if (inbox.length > OFFLINE_INBOX_CAP) inbox.shift();
    offlineInbox.set(userId, inbox);
    return;
  }
  for (const res of set) {
    writeSSE(res, { type: 'notify', notification: notification as unknown as Record<string, unknown> });
  }
}

const PRIORITY_LABEL: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低' };

// 领域事件处理：转模板消息并推送（agent 来源不回推，避免自循环）
export function handleDomainEvent(event: DomainEvent): void {
  if (event.source === 'agent') return;
  const notification = buildNotification(event);
  if (!notification) return;
  console.log(`[agent-server][notify] 事件 ${event.type} → 用户 ${event.actorId}`);
  pushToUser(event.actorId, notification);
}

// 领域事件 → 模板推送文案与快捷操作
function buildNotification(event: DomainEvent): AgentNotification | null {
  switch (event.type) {
    case 'todo.created': {
      const title = String(event.data.title ?? '');
      const priority = PRIORITY_LABEL[String(event.data.priority)] ?? '中';
      const dueDate = String(event.data.dueDate ?? '');
      return {
        id: randomUUID(),
        title: '待办提醒',
        content: `你刚创建了待办「${title}」（优先级：${priority}，截止：${dueDate}）。需要我继续处理吗？`,
        actions: [
          { label: '补充描述', sendText: `帮我补充待办「${title}」的描述` },
          { label: '查看我的待办', sendText: '我的待办有哪些' },
        ],
        createdAt: Date.now(),
      };
    }
    case 'employee.created': {
      const name = String(event.data.name ?? '');
      const dept = String(event.data.departmentName ?? '');
      const title = String(event.data.title ?? '');
      return {
        id: randomUUID(),
        title: '新员工入职',
        content: `新员工「${name}」（${dept} · ${title}）已加入。需要我安排后续事项吗？`,
        actions: [
          { label: '生成入职待办', sendText: `帮我创建一条高优先级待办：为新员工「${name}」安排入职手续与账号开通` },
          { label: '发欢迎公告', sendText: `帮我发布一条公告，欢迎新员工「${name}」加入${dept}` },
        ],
        createdAt: Date.now(),
      };
    }
    default:
      return null;
  }
}
