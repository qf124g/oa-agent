// 平台后端地址（Node.js 后端）；生产构建时为空串，走同源 nginx 反代
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

// agent-server 地址（SDK 接入配置）；生产构建时为空串，走同源 nginx 反代
export const AGENT_SERVER_URL = import.meta.env.VITE_AGENT_SERVER_URL ?? 'http://localhost:3002';

// 本地存储键
export const TOKEN_KEY = 'oa_token';
export const USER_KEY = 'oa_user';

// 状态文案与 antd Tag 颜色映射
export const TODO_PRIORITY: Record<string, { label: string; color: string }> = {
  HIGH: { label: '高', color: 'red' },
  MEDIUM: { label: '中', color: 'blue' },
  LOW: { label: '低', color: 'default' },
};

export const TODO_STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: '待处理', color: 'orange' },
  DONE: { label: '已完成', color: 'green' },
};

export const APPROVAL_TYPE: Record<string, { label: string; color: string }> = {
  LEAVE: { label: '请假', color: 'blue' },
  EXPENSE: { label: '报销', color: 'purple' },
  PURCHASE: { label: '采购', color: 'cyan' },
};

export const APPROVAL_STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: '待审批', color: 'orange' },
  APPROVED: { label: '已通过', color: 'green' },
  REJECTED: { label: '已驳回', color: 'red' },
};

export const ROLE_LABEL: Record<string, string> = {
  EMPLOYEE: '员工',
  ADMIN: '管理员',
};