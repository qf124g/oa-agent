import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { config } from './config';
import { runAgentLoop, resumeAfterConfirmation } from './agent-loop';
import { writeSSE } from './sse';
import { getOrCreateSession, getSession } from './session';
import { extractToken, resolveUser } from './auth';
import { registerEventConnection, handleDomainEvent } from './events';
import type { DomainEvent } from './events';

// 启动时校验大模型 API Key，缺失则快速失败并给出中文提示
if (!config.openaiApiKey) {
  console.error('[agent-server] 启动失败：未配置 OPENAI_API_KEY。请复制 agent-server/.env.example 为 agent-server/.env 并填入真实 Key。');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { status: 'up' } });
});

// 助手主动推送通道：常驻 SSE 连接，业务事件触发时向用户推送模板消息
app.get('/api/agent/events', async (req, res) => {
  const token = extractToken(req.headers.authorization);
  const user = token ? await resolveUser(token) : null;
  if (!user) {
    res.status(401).json({ code: 401, message: '未登录或令牌已失效', data: null });
    return;
  }
  initSSE(res);
  const unregister = registerEventConnection(user.userId, res);
  console.log(`[agent-server][events] 用户 ${user.name} 建立事件连接`);
  // 心跳保活，防止代理/网关空闲断连（冒号注释帧，客户端解析时自动忽略）
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unregister();
  });
});

// 领域事件上报：backend 内部回调，共享密钥鉴权，不对外暴露
app.post('/internal/events', (req, res) => {
  if (req.headers['x-internal-secret'] !== config.internalSecret) {
    res.status(403).json({ code: 403, message: '无效的内部密钥', data: null });
    return;
  }
  handleDomainEvent(req.body as DomainEvent);
  res.json({ code: 0, message: 'ok', data: null });
});

// 设置 SSE 响应头
function initSSE(res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

// 聊天接口：接收用户消息，以 SSE 流式返回助手回答与工具调用过程
app.post('/api/chat', async (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ code: 401, message: '未登录或令牌缺失', data: null });
    return;
  }
  const user = await resolveUser(token);
  if (!user) {
    res.status(401).json({ code: 401, message: '未登录或令牌已失效', data: null });
    return;
  }

  const { sessionId, message } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ code: 1, message: '参数错误：message 不能为空', data: null });
    return;
  }

  const finalSessionId = typeof sessionId === 'string' && sessionId ? sessionId : randomUUID();
  const session = getOrCreateSession(finalSessionId, token, user);

  initSSE(res);
  writeSSE(res, { type: 'session', sessionId: finalSessionId });
  console.log(`[agent-server][chat] user=${user.name} session=${finalSessionId} message=${message}`);
  writeSSE(res, {
    type: 'log',
    step: 0,
    title: '收到请求',
    detail: 'POST /api/chat',
    data: { sessionId: finalSessionId, user: user.name, message },
  });

  // 写入用户消息到会话历史
  session.history.push({ role: 'user', content: message });

  // 客户端提前断开时中断 LLM 流式请求
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    await runAgentLoop({ emit: (e) => writeSSE(res, e), session, sessionId: finalSessionId, signal: abortController.signal });
  } catch (err) {
    if (!abortController.signal.aborted) {
      writeSSE(res, { type: 'error', message: `服务异常: ${err instanceof Error ? err.message : String(err)}` });
    }
  } finally {
    writeSSE(res, { type: 'done' });
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

// 确认接口：用户对写操作确认/取消后，执行真正落库并续传对话
app.post('/api/chat/confirm', async (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ code: 401, message: '未登录或令牌缺失', data: null });
    return;
  }
  const user = await resolveUser(token);
  if (!user) {
    res.status(401).json({ code: 401, message: '未登录或令牌已失效', data: null });
    return;
  }

  const { sessionId, confirmId, approved } = req.body || {};
  if (typeof sessionId !== 'string' || typeof confirmId !== 'string') {
    res.status(400).json({ code: 1, message: '参数错误：sessionId/confirmId 不能为空', data: null });
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    res.status(400).json({ code: 1, message: '会话不存在', data: null });
    return;
  }
  // 刷新鉴权上下文为当前请求的 token
  session.token = token;
  session.user = user;

  initSSE(res);
  writeSSE(res, { type: 'session', sessionId });
  console.log(`[agent-server][confirm] user=${user.name} session=${sessionId} confirmId=${confirmId} approved=${approved === true}`);
  writeSSE(res, {
    type: 'log',
    step: 0,
    title: '收到确认请求',
    detail: 'POST /api/chat/confirm',
    data: { sessionId, confirmId, approved: approved === true },
  });

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    await resumeAfterConfirmation({
      emit: (e) => writeSSE(res, e),
      session,
      sessionId,
      confirmId,
      approved: approved === true,
      signal: abortController.signal,
    });
  } catch (err) {
    if (!abortController.signal.aborted) {
      writeSSE(res, { type: 'error', message: `服务异常: ${err instanceof Error ? err.message : String(err)}` });
    }
  } finally {
    writeSSE(res, { type: 'done' });
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

app.listen(config.port, () => {
  console.log(`[agent-server] Agent 服务已启动: http://localhost:${config.port} (模型: ${config.openaiModel})`);
});