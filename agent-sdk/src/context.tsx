import React, { createContext, useCallback, useMemo, useRef, useState } from 'react';
import type { AgentMessage, ConfirmationRequest, LogEntry, SSEEvent } from './types';
import { streamChat, confirmChat } from './sse-client';

// 通过 context 暴露给子组件的 agent 会话能力
export interface AgentContextValue {
  messages: AgentMessage[]; // 含工具调用过程的完整消息视图
  logs: LogEntry[]; // 服务端逐步执行日志
  isStreaming: boolean; // 一次 sendMessage / confirm 请求进行中
  sessionId: string; // 当前会话 ID（服务端多轮上下文的标识）
  error: string | null; // 最近一次错误
  open: boolean; // 会话面板是否展开
  unreadCount: number; // 面板关闭期间产生的新事件计数（蓝点依据）
  pendingConfirmation: ConfirmationRequest | null; // 待确认的写操作
  sendMessage: (text: string) => Promise<void>;
  confirm: (approved: boolean) => Promise<void>; // 确认/取消写操作
  clear: () => void; // 清空消息并开启新会话
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export interface AgentProviderProps {
  url: string; // agent-server 根地址
  getAuthHeaders: () => Record<string, string>; // 请求鉴权头（Bearer token）
  children: React.ReactNode;
}

// 生成本地唯一 ID
function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

// Agent 助手全局 Provider：接入时包裹在应用外层
export function AgentProvider({ url, getAuthHeaders, children }: AgentProviderProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string>(createId);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const openRef = useRef(false);
  const finalContentRef = useRef('');

  // 展开/收起面板：展开时清零蓝点
  const setPanelOpen = useCallback((value: boolean) => {
    openRef.current = value;
    setOpen(value);
    if (value) setUnreadCount(0);
  }, []);

  const openPanel = useCallback(() => setPanelOpen(true), [setPanelOpen]);
  const closePanel = useCallback(() => setPanelOpen(false), [setPanelOpen]);
  const togglePanel = useCallback(() => setPanelOpen(!openRef.current), [setPanelOpen]);

  // SSE 事件归约：把服务端事件流映射为消息视图与确认状态的更新
  const handleEvent = useCallback((event: SSEEvent) => {
    if (event.type === 'session') {
      setSessionId(event.sessionId);
      return;
    }
    if (event.type === 'error') {
      setError(event.message);
      return;
    }
    if (event.type === 'log') {
      setLogs((prev) => [
        ...prev,
        { id: createId(), time: Date.now(), step: event.step, title: event.title, detail: event.detail, data: event.data },
      ]);
      return;
    }
    if (event.type === 'confirmation_request') {
      setPendingConfirmation({
        sessionId: event.sessionId,
        confirmId: event.confirmId,
        toolName: event.toolName,
        title: event.title,
        summary: event.summary,
        payload: event.payload,
        severity: event.severity,
      });
      if (!openRef.current) setUnreadCount((c) => c + 1);
      return;
    }
    if (event.type === 'confirmation_result') {
      setPendingConfirmation(null);
      return;
    }
    if (event.type === 'message_start') {
      finalContentRef.current = '';
      if (!openRef.current) setUnreadCount((c) => c + 1);
    }
    if (event.type === 'message_delta') {
      finalContentRef.current += event.content;
    }
    if (event.type === 'done') {
      console.log('[agent] 助手最终返回：', finalContentRef.current);
    }
    setMessages((prev) => {
      switch (event.type) {
        // 新建一条助手消息
        case 'message_start':
          return [
            ...prev,
            { id: createId(), role: 'assistant', content: '', toolCalls: [], createdAt: Date.now() },
          ];
        // 文本增量追加到最后一条助手消息
        case 'message_delta': {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== 'assistant') return prev;
          const next = [...prev];
          next[next.length - 1] = { ...last, content: last.content + event.content };
          return next;
        }
        // 新增一个运行中的工具调用块
        case 'tool_call': {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== 'assistant') return prev;
          const next = [...prev];
          next[next.length - 1] = {
            ...last,
            toolCalls: [
              ...last.toolCalls,
              { toolCallId: event.toolCallId, name: event.name, arguments: event.arguments, status: 'running' },
            ],
          };
          return next;
        }
        // 更新对应工具调用块的状态与结果
        case 'tool_result': {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== 'assistant') return prev;
          const next = [...prev];
          next[next.length - 1] = {
            ...last,
            toolCalls: last.toolCalls.map((tc) =>
              tc.toolCallId === event.toolCallId
                ? { ...tc, status: event.ok ? 'success' : 'error', result: event.result }
                : tc
            ),
          };
          return next;
        }
        default:
          return prev;
      }
    });
  }, []);

  // 发送用户消息：本地立即上屏，随后消费 SSE 事件流
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setError(null);
      setMessages((prev) => [
        ...prev,
        { id: createId(), role: 'user', content: trimmed, toolCalls: [], createdAt: Date.now() },
      ]);
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamChat({ url, sessionId, message: trimmed, onEvent: handleEvent, headers: getAuthHeaders(), signal: controller.signal });
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          setError(`连接 agent 服务失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [url, sessionId, isStreaming, handleEvent, getAuthHeaders]
  );

  // 确认/取消写操作：先收起确认框，随后以 SSE 消费续传结果
  const confirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirmation) return;
      const { sessionId: confirmSessionId, confirmId } = pendingConfirmation;
      setPendingConfirmation(null);
      setError(null);
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await confirmChat({
          url,
          sessionId: confirmSessionId,
          confirmId,
          approved,
          onEvent: handleEvent,
          headers: getAuthHeaders(),
          signal: controller.signal,
        });
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          setError(`确认操作失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [pendingConfirmation, url, handleEvent, getAuthHeaders]
  );

  // 清空消息并开启新会话
  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setLogs([]);
    setError(null);
    setPendingConfirmation(null);
    setSessionId(createId());
  }, []);

  const value = useMemo(
    () => ({
      messages,
      logs,
      isStreaming,
      sessionId,
      error,
      open,
      unreadCount,
      pendingConfirmation,
      sendMessage,
      confirm,
      clear,
      openPanel,
      closePanel,
      togglePanel,
    }),
    [messages, logs, isStreaming, sessionId, error, open, unreadCount, pendingConfirmation, sendMessage, confirm, clear, openPanel, closePanel, togglePanel]
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export { AgentContext };