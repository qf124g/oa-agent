// 领域事件推送：业务操作落库后通知 agent-server，驱动助手主动触达用户
// fire-and-forget：推送失败不影响主流程，仅记录日志

const AGENT_EVENT_URL = process.env.AGENT_EVENT_URL || 'http://localhost:3002/internal/events';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'dev-internal-secret';

// 领域事件：待办创建 / 新员工入职，后续可扩展 approval.submitted 等
export interface DomainEvent {
  type: 'todo.created' | 'employee.created';
  actorId: string; // 操作人，即推送目标用户
  source: 'web' | 'agent'; // 事件来源，agent-server 据此避免「助手代办 → 又回推助手」的自循环
  data: Record<string, unknown>;
}

export function emitDomainEvent(event: DomainEvent): void {
  fetch(AGENT_EVENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(3000),
  }).catch((err) => {
    console.warn(`[backend] 领域事件推送失败（${event.type}）: ${err instanceof Error ? err.message : String(err)}`);
  });
}
