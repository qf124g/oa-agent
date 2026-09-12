import type { ConfirmationItem } from '../types';
import './agent-chat.css';

// 流式对话中的写操作确认卡片：内联展示操作摘要与参数，用户在卡片上确认/取消
// 确认结果返回后卡片定格为对应状态，作为消息流的一部分保留在会话记录中
export function ConfirmCard(props: {
  item: ConfirmationItem;
  busy?: boolean;
  onConfirm: (approved: boolean) => void;
}) {
  const { item, busy, onConfirm } = props;
  const dangerous = item.severity === 'dangerous';

  return (
    <div className={`agent-confirm-card${dangerous ? ' agent-confirm-card-danger' : ''}`}>
      <div className="agent-confirm-title-bar">
        <span className={`agent-confirm-badge${dangerous ? ' agent-confirm-badge-danger' : ''}`}>
          {dangerous ? '危险操作' : '操作确认'}
        </span>
        <span className="agent-confirm-op-title">{item.title}</span>
        {item.status !== 'pending' && (
          <span className={`agent-confirm-status agent-confirm-status-${item.status}`}>
            {item.status === 'approved' ? '已确认' : '已取消'}
          </span>
        )}
      </div>

      {item.summary && <div className="agent-confirm-summary">{item.summary}</div>}

      <details className="agent-confirm-details">
        <summary>操作参数</summary>
        <pre className="agent-confirm-json">{JSON.stringify(item.payload, null, 2)}</pre>
      </details>

      {item.status === 'pending' && (
        <div className="agent-confirm-actions">
          <button
            type="button"
            className="agent-confirm-btn agent-confirm-btn-cancel"
            disabled={busy}
            onClick={() => onConfirm(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="agent-confirm-btn agent-confirm-btn-ok"
            disabled={busy}
            onClick={() => onConfirm(true)}
          >
            确认执行
          </button>
        </div>
      )}
    </div>
  );
}
