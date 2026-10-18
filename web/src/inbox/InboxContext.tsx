import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { listInbox } from '../inbox-api';

export interface InboxContextValue {
  unreadCount: number;
  refreshUnread: () => Promise<void>;
  setUnreadCount: (n: number) => void;
}

const InboxContext = createContext<InboxContextValue | null>(null);

// 收件箱上下文：维护未读数角标，登录后拉取并定时刷新
export function InboxProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnread = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listInbox();
      setUnreadCount(data.unreadCount);
    } catch {
      // 未读角标拉取失败静默处理，不影响主流程
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 10000);
    return () => window.clearInterval(timer);
  }, [user, refreshUnread]);

  const value = useMemo(
    () => ({ unreadCount, refreshUnread, setUnreadCount }),
    [unreadCount, refreshUnread],
  );

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxContextValue {
  const ctx = useContext(InboxContext);
  if (!ctx) {
    throw new Error('useInbox 必须在 <InboxProvider> 内使用');
  }
  return ctx;
}