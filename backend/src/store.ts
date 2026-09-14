import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// 磁盘快照路径：backend/data/store.json（相对源码目录上跳一级）
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'store.json');

// 磁盘快照结构：Map -> 对象映射（key 为实体 id）
interface SnapshotData {
  idSeq: number;
  departments: Record<string, Department>;
  employees: Record<string, Employee>;
  todos: Record<string, TodoTask>;
  approvals: Record<string, ApprovalRequest>;
  announcements: Record<string, Announcement>;
  knowledgeDocs: Record<string, KnowledgeDocument>;
}

// 变更后自动落盘的 Map 封装
class PersistentMap<K, V> extends Map<K, V> {
  private onMutate: (() => void) | null = null;

  arm(fn: () => void): void {
    this.onMutate = fn;
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    this.onMutate?.();
    return this;
  }

  override delete(key: K): boolean {
    const removed = super.delete(key);
    if (removed) this.onMutate?.();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.onMutate?.();
  }
}

// 提取 id 末尾的数字部分，如 "E004" -> 4
function numericSuffix(id: string): number {
  const match = /\d+$/.exec(id);
  return match ? Number(match[0]) : 0;
}

// 内存数据存储：各实体 Map + 种子数据 + id 生成
export class InMemoryStore {
  departments = new PersistentMap<string, Department>();
  employees = new PersistentMap<string, Employee>();
  todos = new PersistentMap<string, TodoTask>();
  approvals = new PersistentMap<string, ApprovalRequest>();
  announcements = new PersistentMap<string, Announcement>();
  knowledgeDocs = new PersistentMap<string, KnowledgeDocument>();

  private idSeq = 0;

  constructor() {
    const restored = this.load();
    if (!restored) {
      this.initSeedData();
      // 让自增 id 从现有种子数据最大编号之后开始，避免新建记录覆盖已有数据
      this.idSeq = this.maxExistingNumber();
    }
    this.arm();
    if (!restored) this.persist();
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

  // 开启所有 Map 的变更自动落盘
  private arm(): void {
    const save = () => this.persist();
    this.departments.arm(save);
    this.employees.arm(save);
    this.todos.arm(save);
    this.approvals.arm(save);
    this.announcements.arm(save);
    this.knowledgeDocs.arm(save);
  }

  // 从磁盘加载快照；文件不存在或损坏时返回 false（走种子初始化）
  private load(): boolean {
    try {
      const raw = readFileSync(DATA_FILE, 'utf8');
      const s = JSON.parse(raw) as SnapshotData;
      this.idSeq = typeof s.idSeq === 'number' ? s.idSeq : 0;
      this.hydrate(this.departments, s.departments);
      this.hydrate(this.employees, s.employees);
      this.hydrate(this.todos, s.todos);
      this.hydrate(this.approvals, s.approvals);
      this.hydrate(this.announcements, s.announcements);
      this.hydrate(this.knowledgeDocs, s.knowledgeDocs);
      return true;
    } catch {
      return false;
    }
  }

  // 将对象映射回填进 Map
  private hydrate<V>(map: PersistentMap<string, V>, obj: Record<string, V> | undefined): void {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      map.set(k, v);
    }
  }

  // 落盘：先写临时文件再原子重命名，避免中途崩溃损坏快照
  private persist(): void {
    const snapshot: SnapshotData = {
      idSeq: this.idSeq,
      departments: Object.fromEntries(this.departments),
      employees: Object.fromEntries(this.employees),
      todos: Object.fromEntries(this.todos),
      approvals: Object.fromEntries(this.approvals),
      announcements: Object.fromEntries(this.announcements),
      knowledgeDocs: Object.fromEntries(this.knowledgeDocs),
    };
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, DATA_FILE);
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

    // 知识库文档不再写死在代码里：由启动时扫描 backend/seed/knowledge/ 下的 PDF/MD 加载（见 seed-knowledge.ts）
  }

  // 将 idSeq 提升到当前所有实体最大编号之上，避免后续 nextId 与外部注入的固定 id（如知识库 seed）冲突
  syncIdSeq(): void {
    this.idSeq = Math.max(this.idSeq, this.maxExistingNumber());
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
}

// 单例存储，供各处共享同一份内存数据
export const store = new InMemoryStore();