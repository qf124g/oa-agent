import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { writeSSE } from './sse';
import { syncFromEvent, type KnowledgeDocument } from './rag/knowledge-sync';

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
  type: 'todo.created' | 'employee.created' | 'approval.submitted' | 'approval.decided' | 'knowledge.updated';
  actorId: string;
  source: 'web' | 'agent';
  targetUserIds?: string[]; // 推送目标；缺省时推给 actorId 自己
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
const APPROVAL_TYPE_LABEL: Record<string, string> = { LEAVE: '请假', EXPENSE: '报销', PURCHASE: '采购' };

// 领域事件处理：转模板消息并按目标推送
export function handleDomainEvent(event: DomainEvent): void {
  // 知识库变更：实时重建向量索引（异步），不推送用户消息
  if (event.type === 'knowledge.updated') {
    const docs = (event.data.docs as KnowledgeDocument[]) ?? [];
    syncFromEvent(docs)
      .then(() => console.log(`[agent-server][notify] 知识库向量索引已更新（${docs.length} 篇）`))
      .catch((err) => console.warn(`[agent-server][notify] 知识库向量更新失败: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  // 推送目标：显式列表优先，否则推给操作人自己
  const targets = event.targetUserIds && event.targetUserIds.length > 0 ? event.targetUserIds : [event.actorId];
  // 防自循环：助手代办的写操作，若推送目标就是操作人自己，回推毫无价值，跳过；
  // 目标为他人（如审批通知管理员/申请人）时，即使 agent 来源也照常推送
  const selfOnly = targets.length === 1 && targets[0] === event.actorId;
  if (event.source === 'agent' && selfOnly) return;

  const notification = buildNotification(event);
  if (!notification) return;
  console.log(`[agent-server][notify] 事件 ${event.type} → 用户 ${targets.join(',')}`);
  for (const uid of targets) {
    pushToUser(uid, notification);
  }
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
    case 'approval.submitted': {
      const title = String(event.data.title ?? '');
      const type = APPROVAL_TYPE_LABEL[String(event.data.type)] ?? '审批';
      const applicant = String(event.data.applicantName ?? '');
      const amount = event.data.amount != null ? `（金额 ¥${event.data.amount}）` : '';
      return {
        id: randomUUID(),
        title: '待审批提醒',
        content: `${applicant} 提交了${type}申请「${title}」${amount}，请及时处理。`,
        actions: [
          { label: '查看待审批', sendText: '我有哪些待审批的申请' },
          { label: '查看并处理', sendText: `帮我看看申请人「${applicant}」的「${title}」这条审批，然后处理` },
        ],
        createdAt: Date.now(),
      };
    }
    case 'approval.decided': {
      const title = String(event.data.title ?? '');
      const type = APPROVAL_TYPE_LABEL[String(event.data.type)] ?? '审批';
      const approved = event.data.status === 'APPROVED';
      const approver = String(event.data.approverName ?? '');
      const comment = event.data.comment ? `审批意见：${event.data.comment}` : '';
      return {
        id: randomUUID(),
        title: approved ? '审批已通过' : '审批已驳回',
        content: `你提交的${type}申请「${title}」已被${approver}${approved ? '通过' : '驳回'}。${comment}`,
        actions: [
          { label: '查看我的申请', sendText: '我发起的审批有哪些' },
        ],
        createdAt: Date.now(),
      };
    }
    default:
      return null;
  }
}
