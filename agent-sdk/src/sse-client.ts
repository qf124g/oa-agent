import type { SSEEvent } from './types';

// 发送聊天消息并以 SSE 方式接收事件流
// 通过 fetch POST + ReadableStream 手动解析 SSE 帧（data: {...}\n\n）
export async function streamChat(opts: {
  url: string; // agent-server 根地址，如 http://localhost:3002
  sessionId: string;
  message: string;
  onEvent: (event: SSEEvent) => void;
  headers?: Record<string, string>; // 鉴权头（Bearer token 等）
  signal?: AbortSignal;
}): Promise<void> {
  const { url, sessionId, message, onEvent, headers, signal } = opts;
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });
  await consumeSSE(res, onEvent);
}

// 确认/取消写操作：POST /api/chat/confirm，以 SSE 返回续传结果
export async function confirmChat(opts: {
  url: string;
  sessionId: string;
  confirmId: string;
  approved: boolean;
  onEvent: (event: SSEEvent) => void;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  const { url, sessionId, confirmId, approved, onEvent, headers, signal } = opts;
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ sessionId, confirmId, approved }),
    signal,
  });
  await consumeSSE(res, onEvent);
}

// 消费 SSE 响应流
async function consumeSSE(res: Response, onEvent: (event: SSEEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行（\n\n）分帧，可能一次读到多帧
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as SSEEvent);
      } catch {
        // 忽略无法解析的帧
      }
    }
  }
}