import type { Response } from 'express';

// SSE 事件协议：统一为 data: {单行 JSON}\n\n 格式，客户端按 type 字段分发
export interface SSEEvent {
  type:
    | 'session'
    | 'message_start'
    | 'message_delta'
    | 'message_end'
    | 'tool_call'
    | 'tool_result'
    | 'log'
    | 'confirmation_request'
    | 'confirmation_result'
    | 'error'
    | 'done';
  [key: string]: unknown;
}

// 写出一个 SSE 事件（连接已断开时静默跳过）
export function writeSSE(res: Response, event: SSEEvent): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}