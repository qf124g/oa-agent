// 工具调用在前端视图中的呈现状态
export interface ToolCallView {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: unknown;
}

// 快捷操作：推送消息上的按钮，点击后代发预置指令进入正常 agent 循环
export interface QuickAction {
  label: string;
  sendText: string;
}

// 聊天消息视图模型
export interface AgentMessage {
  id: string;
  kind: 'message';
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallView[];
  createdAt: number;
  notify?: boolean; // 助手主动推送标记（业务事件触发）
  actions?: QuickAction[]; // 推送消息携带的快捷操作
}

// 助手主动推送（事件通道 GET /api/agent/events 的 notify 帧）
export interface AgentNotification {
  id: string;
  title: string;
  content: string;
  actions: QuickAction[];
  createdAt: number;
}

// 消息流中的写操作确认卡片：confirmation_request 事件推入，confirmation_result 事件定格状态
export interface ConfirmationItem {
  id: string;
  kind: 'confirmation';
  confirmId: string;
  toolName: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  severity: 'normal' | 'high' | 'dangerous';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

// 消息流条目：普通消息或确认卡片
export type ChatItem = AgentMessage | ConfirmationItem;

// 待确认的写操作（由 confirmation_request 事件驱动）
export interface ConfirmationRequest {
  sessionId: string;
  confirmId: string;
  toolName: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  severity: 'normal' | 'high' | 'dangerous';
}

// 日志面板中的单条执行日志（由服务端 log 事件驱动）
export interface LogEntry {
  id: string;
  time: number;
  step: number;
  title: string;
  detail?: string;
  data?: unknown;
}

// 请求鉴权头（由宿主应用注入，透传到大模型服务）
export interface AuthHeaders {
  Authorization: string;
}

// agent-server 下发的 SSE 事件类型（与服务端 sse.ts 协议保持一致）
export type SSEEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'message_start'; role: string }
  | { type: 'message_delta'; content: string }
  | { type: 'message_end'; finishReason: string }
  | { type: 'tool_call'; toolCallId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; result: unknown }
  | { type: 'log'; step: number; title: string; detail?: string; data?: unknown }
  | {
      type: 'confirmation_request';
      sessionId: string;
      confirmId: string;
      toolName: string;
      operationType: string;
      title: string;
      summary: string;
      payload: Record<string, unknown>;
      severity: 'normal' | 'high' | 'dangerous';
    }
  | { type: 'confirmation_result'; sessionId: string; confirmId: string; approved: boolean; rejectedReason?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };