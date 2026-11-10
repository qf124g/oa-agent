import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from './types';

// 数据目录：backend/data（相对源码目录上跳一级）
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
// SQLite 数据库文件；旧版 JSON 快照仅用于首次迁移
const DB_FILE = join(DATA_DIR, 'store.db');
const LEGACY_FILE = join(DATA_DIR, 'store.json');

// 实体表清单：每个表以 id 为主键、data 列存整条实体的 JSON 文本
const TABLES = [
  'departments',
  'employees',
  'todos',
  'approvals',
  'announcements',
  'knowledge_docs',
  'workflows',
] as const;
type TableName = (typeof TABLES)[number];

// 旧 JSON 快照结构（仅迁移时读取）
interface LegacySnapshot {
  idSeq: number;
  departments: Record<string, Department>;
  employees: Record<string, Employee>;
  todos: Record<string, TodoTask>;
  approvals: Record<string, ApprovalRequest>;
  announcements: Record<string, Announcement>;
  knowledgeDocs: Record<string, KnowledgeDocument>;
  workflows: Record<string, WorkflowDefinition>;
}

// 提取 id 末尾数字，如 "E004" -> 4
function numericSuffix(id: string): number {
  const match = /\d+$/.exec(id);
  return match ? Number(match[0]) : 0;
}

// 幂等执行结果：result 为业务返回体；replayed 表示本次是否为「命中缓存的回放」
export interface IdempotentOutcome<T> {
  result: T;
  replayed: boolean;
}

// 实体集合：对业务层暴露 Map 风格接口，底层走 SQLite 单表（id + JSON）
class Collection<V extends { id: string }> {
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  private delStmt: Database.Statement;
  private allStmt: Database.Statement;
  private countStmt: Database.Statement;

  constructor(db: Database.Database, table: TableName) {
    this.getStmt = db.prepare(`SELECT data FROM "${table}" WHERE id = ?`);
    this.setStmt = db.prepare(
      `INSERT INTO "${table}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`
    );
    this.delStmt = db.prepare(`DELETE FROM "${table}" WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT data FROM "${table}"`);
    this.countStmt = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`);
  }

  get(id: string): V | undefined {
    const row = this.getStmt.get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as V) : undefined;
  }

  set(id: string, value: V): void {
    this.setStmt.run(id, JSON.stringify(value));
  }

  delete(id: string): boolean {
    return this.delStmt.run(id).changes > 0;
  }

  has(id: string): boolean {
    return this.getStmt.get(id) !== undefined;
  }

  values(): V[] {
    return (this.allStmt.all() as { data: string }[]).map((r) => JSON.parse(r.data) as V);
  }

  get size(): number {
    return (this.countStmt.get() as { c: number }).c;
  }
}

// SQLite 数据存储：替代原「内存 Map + JSON 文件」实现，业务数据与幂等记录同库同事务
export class Store {
  private db: Database.Database;

  departments: Collection<Department>;
  employees: Collection<Employee>;
  todos: Collection<TodoTask>;
  approvals: Collection<ApprovalRequest>;
  announcements: Collection<Announcement>;
  knowledgeDocs: Collection<KnowledgeDocument>;
  workflows: Collection<WorkflowDefinition>;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    const fresh = !existsSync(DB_FILE);
    this.db = new Database(DB_FILE);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();

    this.departments = new Collection<Department>(this.db, 'departments');
    this.employees = new Collection<Employee>(this.db, 'employees');
    this.todos = new Collection<TodoTask>(this.db, 'todos');
    this.approvals = new Collection<ApprovalRequest>(this.db, 'approvals');
    this.announcements = new Collection<Announcement>(this.db, 'announcements');
    this.knowledgeDocs = new Collection<KnowledgeDocument>(this.db, 'knowledge_docs');
    this.workflows = new Collection<WorkflowDefinition>(this.db, 'workflows');

    if (fresh) {
      if (!this.migrateFromLegacy()) {
        this.seed();
      }
      this.syncIdSeq();
    }
  }

  // 建表：实体表 + 自增序列 + 幂等记录表
  private initSchema(): void {
    for (const t of TABLES) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
    // 自增序列初始值
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('id_seq', '0') ON CONFLICT(key) DO NOTHING`)
      .run();
  }

  // 生成带前缀的自增 id，如 T005；单条原子 UPDATE，可安全地在幂等事务内调用
  nextId(prefix: string): string {
    const row = this.db
      .prepare(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'id_seq' RETURNING value`)
      .get() as { value: string } | undefined;
    const seq = Number(row?.value ?? 1);
    return prefix + String(seq).padStart(3, '0');
  }

  // 幂等执行：key 存在则返回缓存结果（replayed=true），否则执行 write 并缓存其结果。
  // write 抛错时事务回滚，不会写入幂等记录，异常向上传播。
  runIdempotent<T>(key: string | undefined, write: () => T): IdempotentOutcome<T> {
    if (!key) return { result: write(), replayed: false };
    const tx = this.db.transaction((k: string): IdempotentOutcome<T> => {
      const existing = this.db.prepare(`SELECT result FROM idempotency WHERE key = ?`).get(k) as
        | { result: string }
        | undefined;
      if (existing) return { result: JSON.parse(existing.result) as T, replayed: true };
      const result = write();
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO idempotency (key, result, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(k, JSON.stringify(result), now, now);
      return { result, replayed: false };
    });
    return tx(key);
  }

  // 对账查询：按幂等键取回首次执行结果；key 不存在返回 undefined。
  // 供 agent 写工具重试耗尽后确认「这笔写是否已落库」，避免「已写成功却报失败」的脑裂。
  getIdempotentResult(key: string): unknown | undefined {
    const row = this.db.prepare(`SELECT result FROM idempotency WHERE key = ?`).get(key) as
      | { result: string }
      | undefined;
    return row ? JSON.parse(row.result) : undefined;
  }

  // 将 idSeq 提升到当前所有实体最大编号之上，避免 nextId 与外部注入的固定 id（如知识库 seed）冲突
  syncIdSeq(): void {
    const max = this.maxExistingNumber();
    this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'id_seq'`).run(String(max));
  }

  private maxExistingNumber(): number {
    let max = 0;
    for (const t of TABLES) {
      const rows = this.db.prepare(`SELECT id FROM "${t}"`).all() as { id: string }[];
      for (const r of rows) max = Math.max(max, numericSuffix(r.id));
    }
    return max;
  }

  // 首次启动时从旧 store.json 迁移数据；文件不存在或损坏返回 false
  private migrateFromLegacy(): boolean {
    try {
      if (!existsSync(LEGACY_FILE)) return false;
      const raw = readFileSync(LEGACY_FILE, 'utf8');
      const s = JSON.parse(raw) as LegacySnapshot;
      const tx = this.db.transaction(() => {
        for (const [id, v] of Object.entries(s.departments ?? {})) this.departments.set(id, v);
        for (const [id, v] of Object.entries(s.employees ?? {})) this.employees.set(id, v);
        for (const [id, v] of Object.entries(s.todos ?? {})) this.todos.set(id, v);
        for (const [id, v] of Object.entries(s.approvals ?? {})) this.approvals.set(id, v);
        for (const [id, v] of Object.entries(s.announcements ?? {})) this.announcements.set(id, v);
        for (const [id, v] of Object.entries(s.knowledgeDocs ?? {})) this.knowledgeDocs.set(id, v);
        for (const [id, v] of Object.entries(s.workflows ?? {})) this.workflows.set(id, v);
      });
      tx();
      return true;
    } catch {
      return false;
    }
  }

  // 按员工 id 取姓名
  employeeName(id: string): string {
    return this.employees.get(id)?.name ?? '';
  }

  // 按部门 id 取部门名
  departmentName(id: string): string {
    return this.departments.get(id)?.name ?? '';
  }

  private seed(): void {
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
      this.approvals.set('A003', a3);
    }

    // 公告
    this.announcements.set('N001', this.announcement('N001', '中秋放假通知', '根据国家法定节假日安排，中秋节放假三天，请各部门提前做好工作安排。', 'E001', true, now));
    this.announcements.set('N002', this.announcement('N002', '新员工入职指引', '欢迎加入公司，请在入职当日完成设备领取、账号开通及入职培训。', 'E003', false, now));

    // 知识库文档不再写死在代码里：由启动时扫描 backend/seed/knowledge/ 下的 PDF/MD 加载（见 seed-knowledge.ts）

    // 审批流程：默认「请假审批流程」示例（自研 SVG 画布可加载编辑）
    this.workflows.set('W001', this.workflow('W001', '请假审批流程', 'LEAVE', [
      { id: 'n-start', type: 'START', title: '发起请假', x: 60, y: 80 },
      { id: 'n-manager', type: 'APPROVAL', title: '直属主管审批', x: 300, y: 80 },
      { id: 'n-cond', type: 'CONDITION', title: '请假天数 > 3 天', x: 540, y: 80 },
      { id: 'n-hr', type: 'APPROVAL', title: '人力资源审批', x: 540, y: 240 },
      { id: 'n-end', type: 'END', title: '结束', x: 800, y: 140 },
    ], [
      { id: 'e1', from: 'n-start', to: 'n-manager' },
      { id: 'e2', from: 'n-manager', to: 'n-cond' },
      { id: 'e3', from: 'n-cond', to: 'n-hr', label: '是' },
      { id: 'e4', from: 'n-cond', to: 'n-end', label: '否' },
      { id: 'e5', from: 'n-hr', to: 'n-end' },
    ]));
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

  private workflow(id: string, name: string, approvalType: ApprovalType | null, nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
    const now = Date.now();
    return { id, name, approvalType, nodes, edges, createdBy: 'E001', createdByName: '陈昊', createdAt: now, updatedAt: now };
  }
}

// 单例存储，供各处共享同一份数据
export const store = new Store();
