import { useAgent } from '../useAgent';
import { ChatPanel } from './ChatPanel';
import './agent-chat.css';

export interface FloatingAssistantProps {
  title?: string;
  placeholder?: string;
  welcomeText?: string;
}

// 悬浮助手：右下角悬浮球（带蓝点提示）+ 可展开会话面板
export function FloatingAssistant(props: FloatingAssistantProps) {
  const { title, placeholder, welcomeText } = props;
  const { open, unreadCount, togglePanel, closePanel } = useAgent();

  return (
    <div className="agent-chat-root">
      {open ? (
        <ChatPanel
          title={title}
          placeholder={placeholder}
          welcomeText={welcomeText}
          onClose={closePanel}
        />
      ) : (
        <button type="button" className="agent-chat-fab" onClick={togglePanel} title="智能助手" aria-label="智能助手">
          <svg
            className="agent-chat-fab-icon"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {unreadCount > 0 && <span className="agent-chat-badge" />}
        </button>
      )}
    </div>
  );
}