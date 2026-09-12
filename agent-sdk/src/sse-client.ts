import type { AgentNotification, SSEEvent } from './types';

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

// 常驻事件通道：连接 GET /api/agent/events，接收助手主动推送；断线指数退避重连，直至 signal 中断
// getHeaders 每次重连时重新求值：Provider 挂载时用户可能尚未登录，token 登录后才能拿到
export async function connectEvents(opts: {
  url: string; // agent-server 根地址
  getHeaders?: () => Record<string, string>;
  onNotify: (notification: AgentNotification) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { url, getHeaders, onNotify, signal } = opts;
  let retry = 0;
  while (!signal.aborted) {
    let unauthorized = false;
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/agent/events`, { headers: getHeaders?.(), signal });
      if (res.status === 401) unauthorized = true; // 未登录/token 失效：短间隔重试等待登录
      if (!res.ok || !res.body) throw new Error(`请求失败（HTTP ${res.status}）`);
      retry = 0; // 连接成功后重置退避
      await readSSEFrames(res.body, (data) => {
        const frame = data as { type?: string; notification?: AgentNotification };
        if (frame.type === 'notify' && frame.notification) onNotify(frame.notification);
      });
    } catch {
      // 中断或网络异常：进入退避重连
    }
    if (signal.aborted) break;
    const wait = unauthorized ? 3000 : Math.min(1000 * 2 ** retry, 15000);
    retry += 1;
    await new Promise((r) => setTimeout(r, wait));
  }
}

// 消费 SSE 响应流
async function consumeSSE(res: Response, onEvent: (event: SSEEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
  }
  await readSSEFrames(res.body, (data) => onEvent(data as SSEEvent));
}

// 读取 SSE 帧：以空行（\n\n）分帧，提取 data: 行解析 JSON（心跳等注释帧自动忽略）
async function readSSEFrames(body: ReadableStream<Uint8Array>, onData: (data: unknown) => void): Promise<void> {
  const reader = body.getReader();
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
        onData(JSON.parse(line.slice(5).trim()));
      } catch {
        // 忽略无法解析的帧
      }
    }
  }
}