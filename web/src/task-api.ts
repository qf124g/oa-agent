import { AGENT_SERVER_URL, TOKEN_KEY } from './constants';
import type { AgentTask, AgentTaskSummary } from './types';

// agent-server 统一响应结构（与 backend 的 ok/fail 同构）
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

// 任务接口走 agent-server（与 backend 的 API_BASE 不是同一服务）
async function taskGet<T>(path: string): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(AGENT_SERVER_URL + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
  }
  if (json.code !== 0) {
    throw new Error(json.message || '请求失败');
  }
  return json.data;
}

// 任务列表（精简字段），可按状态过滤
export function listTasks(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return taskGet<{ list: AgentTaskSummary[]; total: number }>(`/api/tasks${qs}`);
}

// 任务详情（含执行时间线与最终答复）
export function getTask(id: string) {
  return taskGet<AgentTask>(`/api/tasks/${id}`);
}

// 时间戳格式化为 YYYY-MM-DD HH:mm:ss
export function formatDateTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}