import { useEffect, useRef, useState } from 'react';
import { useAgent } from '../useAgent';
import type { LogEntry } from '../types';
import { ToolCallBlock } from './ToolCallBlock';
import { ConfirmCard } from './ConfirmCard';
import './agent-chat.css';

export interface ChatPanelProps {
  title?: string;
  placeholder?: string;
  welcomeText?: string;
  height?: number;
  onClose: () => void;
}

const DEFAULT_WELCOME =
  '你好，我是企业协同办公助手，可以帮你查询待办、审批、公告、通讯录、知识库等，也可以帮你新建待办、发起审批等。例如问我：我的待办有哪些？';

// 会话面板：标题栏 + 消息列表（含内联确认卡片）+ 输入区
export function ChatPanel(props: ChatPanelProps) {
  const {
    title = '智能助手',
    placeholder = '请输入问题，如：我的待办有哪些',
    welcomeText = DEFAULT_WELCOME,
    height = 460,
    onClose,
  } = props;
  const { messages, logs, isStreaming, error, sendMessage, clear, confirm } = useAgent();
  const [input, setInput] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 新内容到达时自动滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, logs, showLogs, error]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    await sendMessage(text);
  };

  return (
    <div className="agent-chat-panel">
      <div className="agent-chat-header">
        <span className="agent-chat-title">{title}</span>
        <div className="agent-chat-header-actions">
          <button type="button" className="agent-chat-header-btn" onClick={clear}>
            新会话
          </button>
          <button type="button" className="agent-chat-header-btn" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? '对话' : '日志'}
          </button>
          <button type="button" className="agent-chat-header-btn" onClick={onClose}>
            收起
          </button>
        </div>
      </div>

      <div className="agent-chat-list" ref={listRef} style={{ height }}>
        {showLogs ? (
          <div className="agent-log-panel">
            {logs.length === 0 && <div className="agent-log-empty">暂无执行日志，发一条消息试试</div>}
            {logs.map((entry) => (
              <LogEntryItem key={entry.id} entry={entry} />
            ))}
          </div>
        ) : (
          <>
            {messages.length === 0 && <div className="agent-chat-welcome">{welcomeText}</div>}
            {messages.map((item) =>
              item.kind === 'confirmation' ? (
                <ConfirmCard key={item.id} item={item} busy={isStreaming} onConfirm={confirm} />
              ) : (
                <div key={item.id} className={`agent-chat-msg agent-chat-msg-${item.role}`}>
                  {item.role === 'assistant' &&
                    item.toolCalls.map((tc) => <ToolCallBlock key={tc.toolCallId} toolCall={tc} />)}
                  {item.content ? <div className="agent-chat-bubble">{item.content}</div> : null}
                  {item.role === 'assistant' && isStreaming && !item.content && item.toolCalls.length === 0 && (
                    <div className="agent-chat-typing">思考中...</div>
                  )}
                </div>
              )
            )}
            {error && <div className="agent-chat-error">{error}</div>}
          </>
        )}
      </div>

      <div className="agent-chat-inputrow">
        <input
          className="agent-chat-input"
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend();
          }}
          disabled={isStreaming}
        />
        <button
          type="button"
          className="agent-chat-send"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
        >
          发送
        </button>
      </div>
    </div>
  );
}

// 时间格式化为 HH:MM:SS
function formatTime(time: number): string {
  const d = new Date(time);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 单条执行日志：步骤徽标 + 标题 + 说明 + 可展开的原始数据
function LogEntryItem({ entry }: { entry: LogEntry }) {
  return (
    <div className="agent-log-item">
      <div className="agent-log-head">
        <span className="agent-log-step">{entry.step > 0 ? `第 ${entry.step} 步` : '请求'}</span>
        <span className="agent-log-title">{entry.title}</span>
        <span className="agent-log-time">{formatTime(entry.time)}</span>
      </div>
      {entry.detail && <div className="agent-log-detail">{entry.detail}</div>}
      {entry.data !== undefined && (
        <details className="agent-log-details">
          <summary>详情</summary>
          <pre className="agent-log-pre">{JSON.stringify(entry.data, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}