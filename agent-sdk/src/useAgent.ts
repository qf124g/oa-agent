import { useContext } from 'react';
import { AgentContext, type AgentContextValue } from './context';

// 在 <AgentProvider> 内的任意子组件中获取 agent 会话状态与操作
export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error('useAgent 必须在 <AgentProvider> 内使用');
  }
  return ctx;
}
