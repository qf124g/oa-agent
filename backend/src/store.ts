import { plusDays } from './common';
import type {
  Announcement,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalType,
  Department,
  Employee,
  KnowledgeDocument,
  Role,
  TodoPriority,
  TodoStatus,
  TodoTask,
} from './types';

// 提取 id 末尾的数字部分，如 "E004" -> 4
function numericSuffix(id: string): number {
  const match = /\d+$/.exec(id);
  return match ? Number(match[0]) : 0;
}

// 内存数据存储：各实体 Map + 种子数据 + id 生成
export class InMemoryStore {
  departments = new Map<string, Department>();
  employees = new Map<string, Employee>();
  todos = new Map<string, TodoTask>();
  approvals = new Map<string, ApprovalRequest>();
  announcements = new Map<string, Announcement>();
  knowledgeDocs = new Map<string, KnowledgeDocument>();

  private idSeq = 0;

  constructor() {
    this.initSeedData();
    // 让自增 id 从现有种子数据最大编号之后开始，避免新建记录覆盖已有数据
    this.idSeq = this.maxExistingNumber();
  }

  // 生成带前缀的自增 id，如 T005
  nextId(prefix: string): string {
    this.idSeq += 1;
    return prefix + String(this.idSeq).padStart(3, '0');
  }

  private maxExistingNumber(): number {
    const allIds = [
      ...this.departments.keys(),
      ...this.employees.keys(),
      ...this.todos.keys(),
      ...this.approvals.keys(),
      ...this.announcements.keys(),
      ...this.knowledgeDocs.keys(),
    ];
    return allIds.reduce((max, id) => Math.max(max, numericSuffix(id)), 0);
  }

  // 按员工 id 取姓名
  employeeName(id: string): string {
    return this.employees.get(id)?.name ?? '';
  }

  // 按部门 id 取部门名
  departmentName(id: string): string {
    return this.departments.get(id)?.name ?? '';
  }

  private initSeedData(): void {
    const now = Date.now();

    // 部门
    this.departments.set('D001', { id: 'D001', name: '技术部', parentId: null, managerEmployeeId: 'E001', orderNo: 1, managerName: '' });
    this.departments.set('D002', { id: 'D002', name: '产品部', parentId: null, managerEmployeeId: 'E002', orderNo: 2, managerName: '' });
    this.departments.set('D003', { id: 'D003', name: '人事部', parentId: null, managerEmployeeId: 'E003', orderNo: 3, managerName: '' });
    this.departments.set('D004', { id: 'D004', name: '财务部', parentId: null, managerEmployeeId: 'E004', orderNo: 4, managerName: '' });

    // 员工（密码统一 123456）
    this.employees.set('E001', this.employee('E001', 'admin', '陈昊', 'D001', '技术总监', '13800000001', 'ADMIN'));
    this.employees.set('E002', this.employee('E002', 'zhangwei', '张伟', 'D002', '产品经理', '13800000002', 'EMPLOYEE'));
    this.employees.set('E003', this.employee('E003', 'lina', '李娜', 'D003', '人事专员', '13800000003', 'EMPLOYEE'));
    this.employees.set('E004', this.employee('E004', 'wangfang', '王芳', 'D004', '财务主管', '13800000004', 'ADMIN'));

    // 待办
    this.todos.set('T001', this.todo('T001', 'E001', '完成季度 OKR 复盘', '整理本季度目标达成情况并输出复盘报告', 'HIGH', 'PENDING', plusDays(1), 'E001'));
    this.todos.set('T002', this.todo('T002', 'E001', '审核第三季度报销', '审批财务部提交的差旅报销申请', 'MEDIUM', 'PENDING', plusDays(3), 'E004'));
    this.todos.set('T003', this.todo('T003', 'E002', '更新员工手册', '补充远程办公相关条款', 'MEDIUM', 'DONE', plusDays(-2), 'E001'));

    // 审批
    this.approvals.set('A001', this.approval('A001', 'LEAVE', 'E002', '年假申请', null, 'PENDING'));
    this.approvals.set('A002', this.approval('A002', 'EXPENSE', 'E003', '差旅报销', 1280.5, 'PENDING'));
    this.approvals.set('A003', this.approval('A003', 'PURCHASE', 'E002', '笔记本电脑采购', 8999.0, 'APPROVED'));
    const a3 = this.approvals.get('A003');
    if (a3) {
      a3.approverId = 'E001';
      a3.comment = '同意，走固定资产采购流程';
      a3.decidedAt = now;
    }

    // 公告
    this.announcements.set('N001', this.announcement('N001', '中秋放假通知', '根据国家法定节假日安排，中秋节放假三天，请各部门提前做好工作安排。', 'E001', true, now));
    this.announcements.set('N002', this.announcement('N002', '新员工入职指引', '欢迎加入公司，请在入职当日完成设备领取、账号开通及入职培训。', 'E003', false, now));

    // 知识库文档（作为 RAG 的知识源）
    this.knowledgeDocs.set('K001', this.knowledge('K001', '考勤管理制度', '制度',
      '公司实行标准工时制，工作时间 09:00 至 18:00，午休 12:00 至 13:30。' +
      '员工迟到 30 分钟以内记一次迟到，每月迟到三次及以上将影响当月绩效。' +
      '请假需提前一天在系统提交申请，审批通过后方可休假。' +
      '加班需提前报备并记录，加班工时可用于调休。', 'E003', now));
    this.knowledgeDocs.set('K002', this.knowledge('K002', '报销流程说明', '流程',
      '报销申请需在费用发生后 30 天内提交。发票抬头为公司全称，金额需与申请一致。' +
      '差旅报销需附行程单和住宿发票，餐饮招待费需注明事由和参与人员。' +
      '报销审批由部门负责人和财务主管两级审批，金额超过 5000 元需总经理审批。' +
      '审批通过后财务在 5 个工作日内打款。', 'E004', now));
    this.knowledgeDocs.set('K003', this.knowledge('K003', '办公环境 FAQ', 'FAQ',
      '办公区 Wi-Fi 账号为 OA-Guest，密码前台领取。打印机位于每层茶水间旁。' +
      '会议室通过系统在线预约，单次会议不超过 2 小时。访客需前台登记并领取临时门禁卡。', 'E003', now));
  }

  private employee(id: string, userNo: string, name: string, departmentId: string, title: string, phone: string, role: Role): Employee {
    return { id, userNo, name, departmentId, title, phone, email: `${userNo}@oa.local`, role, password: '123456', departmentName: '' };
  }

  private todo(id: string, ownerId: string, title: string, description: string, priority: TodoPriority, status: TodoStatus, dueDate: string, assignerId: string): TodoTask {
    const now = Date.now();
    return { id, ownerId, title, description, priority, status, dueDate, assignerId, createdAt: now, updatedAt: now, ownerName: '' };
  }

  private approval(id: string, type: ApprovalType, applicantId: string, title: string, amount: number | null, status: ApprovalStatus): ApprovalRequest {
    return { id, type, applicantId, title, detail: {}, amount, status, approverId: null, comment: null, createdAt: Date.now(), decidedAt: 0, applicantName: '', approverName: null };
  }

  private announcement(id: string, title: string, content: string, authorId: string, pinned: boolean, publishedAt: number): Announcement {
    return { id, title, content, authorId, pinned, publishedAt, authorName: '' };
  }

  private knowledge(id: string, title: string, category: string, content: string, uploadedBy: string, createdAt: number): KnowledgeDocument {
    return { id, title, content, category, uploadedBy, createdAt, updatedAt: createdAt, uploadedByName: '' };
  }
}

// 单例存储，供各处共享同一份内存数据
export const store = new InMemoryStore();