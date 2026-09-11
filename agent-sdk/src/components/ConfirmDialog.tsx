import type { ConfirmationRequest } from '../types';
import './agent-chat.css';

// 写操作确认框：展示操作标题、摘要与参数，DANGEROUS 级别红标提示
export function ConfirmDialog(props: {
  confirmation: ConfirmationRequest;
  busy?: boolean;
  onConfirm: (approved: boolean) => void;
}) {
  const { confirmation, busy, onConfirm } = props;
  const dangerous = confirmation.severity === 'dangerous';

  return (
    <div className="agent-confirm-mask">
      <div className="agent-confirm-dialog">
        <div className="agent-confirm-title-bar">
          <span className={`agent-confirm-badge${dangerous ? ' agent-confirm-badge-danger' : ''}`}>
            {dangerous ? '危险操作' : '操作确认'}
          </span>
          <span className="agent-confirm-op-title">{confirmation.title}</span>
        </div>

        {confirmation.summary && <div className="agent-confirm-summary">{confirmation.summary}</div>}

        <div className="agent-confirm-section">操作参数</div>
        <pre className="agent-confirm-json">{JSON.stringify(confirmation.payload, null, 2)}</pre>

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
      </div>
    </div>
  );
}