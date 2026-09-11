// 企业协同办公平台后端：领域类型定义

// ---- 枚举（字符串联合类型，序列化为枚举名）----

export type Role = 'EMPLOYEE' | 'ADMIN';
export type TodoPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type TodoStatus = 'PENDING' | 'DONE';
export type ApprovalType = 'LEAVE' | 'EXPENSE' | 'PURCHASE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

// ---- 鉴权上下文 ----

export interface AuthUser {
  userId: string;
  userNo: string;
  name: string;
  role: Role;
}

// ---- 领域实体 ----

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  managerEmployeeId: string;
  orderNo: number;
  managerName: string;
}

export interface Employee {
  id: string;
  userNo: string; // 工号（登录账号）
  name: string;
  departmentId: string;
  title: string; // 职位
  phone: string;
  email: string;
  role: Role;
  password: string | null; // 登录密码（demo 明文，列表/详情返回 null）
  departmentName: string;
}

export interface TodoTask {
  id: string;
  ownerId: string; // 所属员工 id
  title: string;
  description: string;
  priority: TodoPriority;
  status: TodoStatus;
  dueDate: string; // 截止日期，格式 YYYY-MM-DD
  assignerId: string; // 指派发起人 id
  createdAt: number;
  updatedAt: number;
  ownerName: string; // 所属人姓名（展示字段）
}

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  applicantId: string; // 申请人员工 id
  title: string;
  detail: Record<string, unknown>; // 详情（结构随类型变化）
  amount: number | null; // 金额（报销/采购用，请假为 null）
  status: ApprovalStatus;
  approverId: string | null; // 审批人员工 id
  comment: string | null; // 审批意见
  createdAt: number;
  decidedAt: number;
  applicantName: string; // 申请人姓名（展示字段）
  approverName: string | null; // 审批人姓名（展示字段）
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  authorId: string;
  pinned: boolean;
  publishedAt: number;
  authorName: string; // 发布人姓名（展示字段）
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string | null; // 列表接口不含正文，返回 null
  category: string; // 分类，如 制度/FAQ/操作手册
  uploadedBy: string; // 上传人员工 id
  createdAt: number;
  updatedAt: number;
  uploadedByName: string; // 上传人姓名（展示字段）
}

// ---- 通用结构 ----

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}