import { randomUUID } from 'node:crypto';
import type { SSEEvent } from './sse';

// 异步任务状态：一次「用户请求 → 多步执行 → 结果」的生命周期
export type AgentTaskStatus = 'RUNNING' | 'WAITING_CONFIRM' | 'DONE' | 'FAILED' | 'INTERRUPTED';

// 任务时间线单步
export interface TaskStep {
  id: string;
  kind: 'log' | 'tool' | 'result' | 'confirm' | 'error';
  title: string;
  detail: string;
  data?: unknown;
  at: number;
}

// 单个 Agent 任务：一次用户请求的完整执行记录
export interface AgentTask {
  id: string;
  userId: string;
  sessionId: string;
  title: string; // 意图摘要（首条消息截断）
  status: AgentTaskStatus;
  steps: TaskStep[]; // 执行时间线
  result: string; // 最终答复文本（流式增量累积）
  toolNames: string[]; // 用到的工具名（去重）
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, AgentTask>();
// sessionId -> 最近一次任务 id，用于 confirm 续传时定位所属任务
const sessionTask = new Map<string, string>();

// 标题截断长度
const TITLE_MAX = 40;

// 创建任务并建立 session 关联；每次 /api/chat 都是一个新任务
export function createTask(userId: string, sessionId: string, message: string): AgentTask {
  const now = Date.now();
  const trimmed = message.trim();
  const title = trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) + '…' : trimmed;
  const task: AgentTask = {
    id: randomUUID(),
    userId,
    sessionId,
    title,
    status: 'RUNNING',
    steps: [],
    result: '',
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);
  sessionTask.set(sessionId, task.id);
  return task;
}

export function getTask(id: string): AgentTask | undefined {
  return tasks.get(id);
}

// 根据 sessionId 找到最近一次任务（confirm 续传追加时间线用）
export function getTaskBySession(sessionId: string): AgentTask | undefined {
  const id = sessionTask.get(sessionId);
  return id ? tasks.get(id) : undefined;
}

// 当前用户任务列表，按创建时间倒序，可选项：按状态过滤
export function listTasks(userId: string, status?: string): AgentTask[] {
  let list = [...tasks.values()].filter((t) => t.userId === userId);
  if (status) list = list.filter((t) => t.status === status);
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

// 将 agent 执行过程的 SSE 事件翻译为任务时间线节点，并推进任务状态
export function recordEvent(task: AgentTask, event: SSEEvent): void {
  task.updatedAt = Date.now();
  switch (event.type) {
    case 'log': {
      task.steps.push({
        id: randomUUID(),
        kind: 'log',
        title: typeof event.title === 'string' ? event.title : '处理中',
        detail: typeof event.detail === 'string' ? event.detail : '',
        data: event.data,
        at: Date.now(),
      });
      break;
    }
    case 'tool_call': {
      const name = typeof event.name === 'string' ? event.name : '';
      if (name && !task.toolNames.includes(name)) task.toolNames.push(name);
      task.steps.push({
        id: randomUUID(),
        kind: 'tool',
        title: `调用工具 ${name}`,
        detail: '解析参数并执行',
        data: event.arguments,
        at: Date.now(),
      });
      break;
    }
    case 'tool_result': {
      const name = typeof event.name === 'string' ? event.name : '';
      const ok = event.ok === true;
      task.steps.push({
        id: randomUUID(),
        kind: 'result',
        title: `${name} ${ok ? '执行成功' : '执行失败'}`,
        detail: ok ? '返回结果已回注模型' : '失败信息已回注模型',
        data: event.result,
        at: Date.now(),
      });
      break;
    }
    case 'confirmation_request': {
      task.status = 'WAITING_CONFIRM';
      task.steps.push({
        id: randomUUID(),
        kind: 'confirm',
        title: typeof event.title === 'string' ? event.title : '等待确认',
        detail: typeof event.summary === 'string' ? event.summary : '',
        data: event.payload,
        at: Date.now(),
      });
      break;
    }
    case 'confirmation_result': {
      task.status = 'RUNNING';
      task.steps.push({
        id: randomUUID(),
        kind: 'confirm',
        title: event.approved === true ? '用户已确认执行' : '用户已取消',
        detail: '',
        at: Date.now(),
      });
      break;
    }
    case 'message_delta': {
      if (typeof event.content === 'string') task.result += event.content;
      break;
    }
    case 'error': {
      task.status = 'FAILED';
      task.steps.push({
        id: randomUUID(),
        kind: 'error',
        title: '执行失败',
        detail: typeof event.message === 'string' ? event.message : '',
        at: Date.now(),
      });
      break;
    }
    case 'done': {
      // 连接收尾：仅「执行中」视为完成；「待确认」保持不变，等用户确认后再由 confirm 请求推进
      if (task.status === 'RUNNING') {
        task.status = 'DONE';
      }
      break;
    }
    default:
      // session / message_start / message_end / notify 不产生时间线节点
      break;
  }
}

// 客户端提前断开连接时，将未完成任务标记为「已中断」
export function markInterrupted(task: AgentTask | undefined): void {
  if (!task) return;
  if (task.status !== 'RUNNING' && task.status !== 'WAITING_CONFIRM') return;
  task.status = 'INTERRUPTED';
  task.updatedAt = Date.now();
  task.steps.push({
    id: randomUUID(),
    kind: 'error',
    title: '任务已中断',
    detail: '客户端断开连接，执行提前终止',
    at: Date.now(),
  });
}