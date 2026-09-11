// 与平台后端 API 对应的数据类型定义

export type Role = 'EMPLOYEE' | 'ADMIN';
export type TodoPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type TodoStatus = 'PENDING' | 'DONE';
export type ApprovalType = 'LEAVE' | 'EXPENSE' | 'PURCHASE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

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
  userNo: string;
  name: string;
  departmentId: string;
  title: string;
  phone: string;
  email: string;
  role: Role;
  departmentName: string;
}

export interface TodoTask {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  priority: TodoPriority;
  status: TodoStatus;
  dueDate: string;
  assignerId: string;
  createdAt: number;
  updatedAt: number;
  ownerName: string;
}

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  applicantId: string;
  title: string;
  detail: Record<string, unknown>;
  amount: number | null;
  status: ApprovalStatus;
  approverId: string | null;
  comment: string;
  createdAt: number;
  decidedAt: number;
  applicantName: string;
  approverName: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  authorId: string;
  pinned: boolean;
  publishedAt: number;
  authorName: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  category: string;
  uploadedBy: string;
  createdAt: number;
  updatedAt: number;
  uploadedByName: string;
}

export interface Paged<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardStats {
  todoCount: number;
  pendingApprovalCount: number;
  announcementCount: number;
  employeeCount: number;
  departmentCount: number;
  knowledgeCount: number;
  myTodos: TodoTask[];
  myApprovals: ApprovalRequest[];
}

// 当前登录用户信息
export interface AuthUser {
  userId: string;
  userNo: string;
  name: string;
  role: Role;
  departmentId: string;
  departmentName: string;
  title: string;
}