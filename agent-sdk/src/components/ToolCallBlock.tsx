import React, { useState } from 'react';
import type { ToolCallView } from '../types';

// 单个工具调用过程块：默认折叠，展示工具名、参数摘要与状态，可展开查看完整参数与结果
export function ToolCallBlock({ toolCall }: { toolCall: ToolCallView }) {
  const [expanded, setExpanded] = useState(false);
  const statusText =
    toolCall.status === 'running' ? '执行中' : toolCall.status === 'success' ? '完成' : '失败';
  // 参数摘要：仅展示值部分，如 张伟 / E001
  const argSummary = Object.values(toolCall.arguments)
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => String(v))
    .join(' / ');

  return (
    <div className={`agent-chat-tool agent-chat-tool-${toolCall.status}`}>
      <button type="button" className="agent-chat-tool-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`agent-chat-tool-dot agent-chat-tool-dot-${toolCall.status}`} />
        <span className="agent-chat-tool-name">{toolCall.name}</span>
        {argSummary && <span className="agent-chat-tool-args">{argSummary}</span>}
        <span className="agent-chat-tool-status">{statusText}</span>
        <span className="agent-chat-tool-arrow">{expanded ? '收起' : '详情'}</span>
      </button>
      {expanded && (
        <div className="agent-chat-tool-detail">
          <div className="agent-chat-tool-section">参数</div>
          <pre className="agent-chat-tool-json">{JSON.stringify(toolCall.arguments, null, 2)}</pre>
          {toolCall.result !== undefined && (
            <>
              <div className="agent-chat-tool-section">结果</div>
              <pre className="agent-chat-tool-json">{JSON.stringify(toolCall.result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
