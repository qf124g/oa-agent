import type { AgentTask, AgentTaskSummary } from './types';
import { agentGet } from './agent-api';

// 任务列表（精简字段），可按状态过滤
export function listTasks(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return agentGet<{ list: AgentTaskSummary[]; total: number }>(`/api/tasks${qs}`);
}

// 任务详情（含执行时间线与最终答复）
export function getTask(id: string) {
  return agentGet<AgentTask>(`/api/tasks/${id}`);
}