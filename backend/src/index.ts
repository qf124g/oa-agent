import express from 'express';
import cors from 'cors';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { BusinessError, ok, fail, paginate, asInt, str, plusDays } from './common';
import { store } from './store';
import { tokenStore } from './auth';
import { emitDomainEvent } from './notify';
import type {
  ApprovalRequest,
  AuthUser,
  Employee,
  KnowledgeDocument,
  Role,
  TodoPriority,
  TodoTask,
} from './types';

// 鉴权后的请求（附加 currentUser）
interface AuthedRequest extends Request {
  currentUser?: AuthUser;
}

const app = express();
app.use(cors());
app.use(express.json());

// 无需登录即可访问的路径
const WHITE_LIST = new Set(['/api/auth/login']);

// 鉴权中间件：解析 Bearer token -> 写入 req.currentUser
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (WHITE_LIST.has(req.path)) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = tokenStore.resolve(token);
  if (!user) {
    res.status(401).json(fail(401, '未登录或令牌已失效'));
    return;
  }
  (req as AuthedRequest).currentUser = user;
  next();
}

// 角色校验中间件：限定只有指定角色才能访问
function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    const user = (req as AuthedRequest).currentUser;
    if (!user) {
      throw new BusinessError(401, '未登录或令牌已失效');
    }
    if (user.role !== role) {
      throw new BusinessError(403, '无权限执行该操作');
    }
    next();
  };
}

// 从 query 读取字符串值
function queryStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

app.use(authMiddleware);

// ---------- 认证 ----------

// 登录（公开接口）
app.post('/api/auth/login', (req, res) => {
  const username = str(req.body?.username);
  const password = str(req.body?.password);
  const emp = [...store.employees.values()].find((e) => e.userNo === username);
  if (!emp || emp.password !== password) {
    throw new BusinessError(401, '账号或密码错误');
  }
  const user: AuthUser = { userId: emp.id, userNo: emp.userNo, name: emp.name, role: emp.role };
  const token = tokenStore.issue(user);
  res.json(ok({ token, user: userInfo(emp) }));
});

// 当前用户信息
app.get('/api/auth/me', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const emp = store.employees.get(user.userId);
  if (!emp) {
    throw new BusinessError(401, '用户不存在');
  }
  res.json(ok(userInfo(emp)));
});

// ---------- 待办 ----------

app.get('/api/todos', (req, res) => {
  const q = req.query;
  const ownerId = queryStr(q.ownerId);
  const status = queryStr(q.status);
  const page = asInt(q.page, 1);
  const pageSize = asInt(q.pageSize, 10);
  const user = (req as AuthedRequest).currentUser as AuthUser;

  let list = [...store.todos.values()];
  if (user.role !== 'ADMIN') {
    list = list.filter((t) => t.ownerId === user.userId);
  } else if (ownerId) {
    list = list.filter((t) => t.ownerId === ownerId);
  }
  if (status) {
    list = list.filter((t) => t.status === status);
  }
  list.sort((a, b) => (a.status === 'DONE' ? 1 : 0) - (b.status === 'DONE' ? 1 : 0) || (a.dueDate || '').localeCompare(b.dueDate || ''));
  const items = list.map((t) => ({ ...t, ownerName: store.employeeName(t.ownerId) }));
  res.json(ok(paginate(items, page, pageSize)));
});

app.post('/api/todos', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const title = str(body.title);
  if (!title) {
    throw new BusinessError(400, '待办标题不能为空');
  }
  const ownerId = str(body.ownerId);
  let priority: TodoPriority = 'MEDIUM';
  const p = str(body.priority).toUpperCase();
  if (p === 'HIGH' || p === 'MEDIUM' || p === 'LOW') priority = p;
  let dueDate = str(body.dueDate);
  if (!dueDate) dueDate = plusDays(7);
  const now = Date.now();
  const t: TodoTask = {
    id: store.nextId('T'),
    ownerId: ownerId || user.userId,
    title,
    description: str(body.description),
    priority,
    status: 'PENDING',
    dueDate,
    assignerId: user.userId,
    createdAt: now,
    updatedAt: now,
    ownerName: store.employeeName(ownerId || user.userId),
  };
  store.todos.set(t.id, t);
  res.json(ok(t));
  // 领域事件：通知助手主动触达创建人（通过助手代办的标记 agent 来源，不回推）
  emitDomainEvent({
    type: 'todo.created',
    actorId: user.userId,
    source: req.headers['x-source'] === 'agent' ? 'agent' : 'web',
    data: { id: t.id, title: t.title, priority: t.priority, dueDate: t.dueDate },
  });
});

app.patch('/api/todos/:id/complete', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const t = store.todos.get(req.params.id);
  if (!t) {
    throw new BusinessError(404, '待办不存在');
  }
  if (user.role !== 'ADMIN' && t.ownerId !== user.userId) {
    throw new BusinessError(403, '无权限操作该待办');
  }
  t.status = 'DONE';
  t.updatedAt = Date.now();
  res.json(ok({ ...t, ownerName: store.employeeName(t.ownerId) }));
});

// ---------- 审批 ----------

app.get('/api/approvals/mine', (req, res) => {
  const q = req.query;
  const type = queryStr(q.type);
  const status = queryStr(q.status);
  const page = asInt(q.page, 1);
  const pageSize = asInt(q.pageSize, 10);
  const user = (req as AuthedRequest).currentUser as AuthUser;

  let list = [...store.approvals.values()].filter((a) => a.applicantId === user.userId);
  if (type) list = list.filter((a) => a.type === type);
  if (status) list = list.filter((a) => a.status === status);
  list.sort((a, b) => b.createdAt - a.createdAt);
  const items = list.map(fillApprovalNames);
  res.json(ok(paginate(items, page, pageSize)));
});

app.get('/api/approvals/pending', requireRole('ADMIN'), (req, res) => {
  const page = asInt(req.query.page, 1);
  const pageSize = asInt(req.query.pageSize, 10);
  let list = [...store.approvals.values()].filter((a) => a.status === 'PENDING');
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(ok(paginate(list.map(fillApprovalNames), page, pageSize)));
});

app.post('/api/approvals', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const typeStr = str(body.type).toUpperCase();
  if (typeStr !== 'LEAVE' && typeStr !== 'EXPENSE' && typeStr !== 'PURCHASE') {
    throw new BusinessError(400, '审批类型不正确');
  }
  const title = str(body.title);
  if (!title) {
    throw new BusinessError(400, '审批标题不能为空');
  }
  const detail = body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)
    ? (body.detail as Record<string, unknown>)
    : {};
  const a: ApprovalRequest = {
    id: store.nextId('A'),
    type: typeStr,
    applicantId: user.userId,
    title,
    detail,
    amount: typeof body.amount === 'number' ? body.amount : null,
    status: 'PENDING',
    approverId: null,
    comment: null,
    createdAt: Date.now(),
    decidedAt: 0,
    applicantName: store.employeeName(user.userId),
    approverName: null,
  };
  store.approvals.set(a.id, a);
  res.json(ok(a));
});

app.post('/api/approvals/:id/approve', requireRole('ADMIN'), (req, res) => {
  res.json(ok(decide(req as AuthedRequest, req.params.id, str(req.body?.comment), true)));
});

app.post('/api/approvals/:id/reject', requireRole('ADMIN'), (req, res) => {
  res.json(ok(decide(req as AuthedRequest, req.params.id, str(req.body?.comment), false)));
});

// ---------- 公告 ----------

app.get('/api/announcements', (req, res) => {
  const page = asInt(req.query.page, 1);
  const pageSize = asInt(req.query.pageSize, 10);
  const list = [...store.announcements.values()]
    .sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1) || b.publishedAt - a.publishedAt)
    .map((n) => ({ ...n, authorName: store.employeeName(n.authorId) }));
  res.json(ok(paginate(list, page, pageSize)));
});

app.get('/api/announcements/:id', (req, res) => {
  const n = store.announcements.get(req.params.id);
  if (!n) {
    throw new BusinessError(404, '公告不存在');
  }
  res.json(ok({ ...n, authorName: store.employeeName(n.authorId) }));
});

app.post('/api/announcements', requireRole('ADMIN'), (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const title = str(body.title);
  if (!title) {
    throw new BusinessError(400, '公告标题不能为空');
  }
  const n = {
    id: store.nextId('N'),
    title,
    content: str(body.content),
    authorId: user.userId,
    pinned: body.pinned === true,
    publishedAt: Date.now(),
    authorName: store.employeeName(user.userId),
  };
  store.announcements.set(n.id, n);
  res.json(ok(n));
});

// ---------- 部门 ----------

app.get('/api/departments', (_req, res) => {
  const list = [...store.departments.values()]
    .sort((a, b) => a.orderNo - b.orderNo)
    .map((d) => ({ ...d, managerName: store.employeeName(d.managerEmployeeId) }));
  res.json(ok(list));
});

// ---------- 员工 ----------

app.get('/api/employees', (req, res) => {
  const departmentId = queryStr(req.query.departmentId);
  const name = queryStr(req.query.name);
  const page = asInt(req.query.page, 1);
  const pageSize = asInt(req.query.pageSize, 10);

  let list = [...store.employees.values()];
  if (departmentId) list = list.filter((e) => e.departmentId === departmentId);
  if (name) list = list.filter((e) => e.name.includes(name));
  list.sort((a, b) => a.userNo.localeCompare(b.userNo));
  const items = list.map(sanitizeEmployee);
  res.json(ok(paginate(items, page, pageSize)));
});

app.get('/api/employees/:id', (req, res) => {
  const e = store.employees.get(req.params.id);
  if (!e) {
    throw new BusinessError(404, '员工不存在');
  }
  res.json(ok(sanitizeEmployee(e)));
});

// 新建员工（管理员）：工号即登录账号，初始密码默认 123456
app.post('/api/employees', requireRole('ADMIN'), (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const b = req.body ?? {};
  const userNo = String(b.userNo ?? '').trim();
  const name = String(b.name ?? '').trim();
  const departmentId = String(b.departmentId ?? '').trim();
  const title = String(b.title ?? '').trim();
  if (!userNo || !name || !departmentId || !title) {
    throw new BusinessError(400, '工号、姓名、部门、职位不能为空');
  }
  if ([...store.employees.values()].some((e) => e.userNo === userNo)) {
    throw new BusinessError(400, `工号 ${userNo} 已存在`);
  }
  if (!store.departments.has(departmentId)) {
    throw new BusinessError(400, '部门不存在');
  }
  const emp: Employee = {
    id: store.nextId('E'),
    userNo,
    name,
    departmentId,
    title,
    phone: String(b.phone ?? '').trim(),
    email: String(b.email ?? '').trim() || `${userNo}@oa.local`,
    role: b.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
    password: String(b.password ?? '123456'),
    departmentName: '',
  };
  store.employees.set(emp.id, emp);
  res.json(ok(sanitizeEmployee(emp)));
  // 领域事件：新员工入职，通知操作人（助手代办的标记 agent 来源，不回推）
  emitDomainEvent({
    type: 'employee.created',
    actorId: user.userId,
    source: req.headers['x-source'] === 'agent' ? 'agent' : 'web',
    data: { id: emp.id, name: emp.name, userNo: emp.userNo, title: emp.title, departmentName: store.departmentName(departmentId) },
  });
});

// ---------- 知识库 ----------

app.get('/api/knowledge', (req, res) => {
  const category = queryStr(req.query.category);
  const page = asInt(req.query.page, 1);
  const pageSize = asInt(req.query.pageSize, 10);

  let list = [...store.knowledgeDocs.values()];
  if (category) list = list.filter((k) => k.category === category);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const items = list.map((k) => ({
    id: k.id,
    title: k.title,
    content: null as string | null,
    category: k.category,
    uploadedBy: k.uploadedBy,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
    uploadedByName: store.employeeName(k.uploadedBy),
  }));
  res.json(ok(paginate(items, page, pageSize)));
});

// 全量文档（含正文），供 agent 构建向量索引
app.get('/api/knowledge/full', (_req, res) => {
  const list = [...store.knowledgeDocs.values()].map((k) => ({
    ...k,
    uploadedByName: store.employeeName(k.uploadedBy),
  }));
  res.json(ok(list));
});

app.get('/api/knowledge/:id', (req, res) => {
  const k = store.knowledgeDocs.get(req.params.id);
  if (!k) {
    throw new BusinessError(404, '文档不存在');
  }
  res.json(ok({ ...k, uploadedByName: store.employeeName(k.uploadedBy) }));
});

app.post('/api/knowledge', requireRole('ADMIN'), (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const title = str(body.title);
  const content = str(body.content);
  if (!title || !content) {
    throw new BusinessError(400, '标题和内容不能为空');
  }
  const now = Date.now();
  const k: KnowledgeDocument = {
    id: store.nextId('K'),
    title,
    content,
    category: str(body.category) || '未分类',
    uploadedBy: user.userId,
    createdAt: now,
    updatedAt: now,
    uploadedByName: store.employeeName(user.userId),
  };
  store.knowledgeDocs.set(k.id, k);
  res.json(ok(k));
});

app.delete('/api/knowledge/:id', requireRole('ADMIN'), (req, res) => {
  if (!store.knowledgeDocs.delete(req.params.id)) {
    throw new BusinessError(404, '文档不存在');
  }
  res.json(ok(null));
});

// ---------- 工作台 ----------

app.get('/api/dashboard/stats', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const isAdmin = user.role === 'ADMIN';

  const myTodos = [...store.todos.values()]
    .filter((t) => t.ownerId === user.userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const myApprovals = [...store.approvals.values()]
    .filter((a) => a.applicantId === user.userId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const pendingApprovalCount = isAdmin
    ? [...store.approvals.values()].filter((a) => a.status === 'PENDING').length
    : 0;

  res.json(ok({
    todoCount: myTodos.filter((t) => t.status === 'PENDING').length,
    pendingApprovalCount,
    announcementCount: store.announcements.size,
    employeeCount: store.employees.size,
    departmentCount: store.departments.size,
    knowledgeCount: store.knowledgeDocs.size,
    myTodos: myTodos.slice(0, 5).map((t) => ({ ...t, ownerName: store.employeeName(t.ownerId) })),
    myApprovals: myApprovals.slice(0, 5).map(fillApprovalNames),
  }));
});

// ---------- 统一错误处理 ----------

function fillApprovalNames(a: ApprovalRequest): ApprovalRequest {
  return {
    ...a,
    applicantName: store.employeeName(a.applicantId),
    approverName: a.approverId ? store.employeeName(a.approverId) : null,
  };
}

function sanitizeEmployee(e: Employee): Employee {
  return {
    ...e,
    departmentName: store.departmentName(e.departmentId),
    password: null,
  };
}

function userInfo(emp: Employee) {
  return {
    userId: emp.id,
    userNo: emp.userNo,
    name: emp.name,
    role: emp.role,
    departmentId: emp.departmentId,
    departmentName: store.departmentName(emp.departmentId),
    title: emp.title,
  };
}

function decide(req: AuthedRequest, id: string, comment: string, approved: boolean): ApprovalRequest {
  const user = req.currentUser as AuthUser;
  if (user.role !== 'ADMIN') {
    throw new BusinessError(403, '无权限审批');
  }
  const a = store.approvals.get(id);
  if (!a) {
    throw new BusinessError(404, '审批申请不存在');
  }
  if (a.status !== 'PENDING') {
    throw new BusinessError(400, '该申请已处理');
  }
  a.status = approved ? 'APPROVED' : 'REJECTED';
  a.approverId = user.userId;
  a.comment = comment;
  a.decidedAt = Date.now();
  return fillApprovalNames(a);
}

// 错误处理中间件：业务异常按 code 映射 HTTP 状态码，其余返回 500
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof BusinessError) {
    const status = err.code === 401 ? 401 : 200;
    res.status(status).json(fail(err.code, err.message));
    return;
  }
  res.status(200).json(fail(500, `服务异常: ${err instanceof Error ? err.message : String(err)}`));
}

app.use(errorHandler);

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[backend] 已启动，监听端口 ${PORT}`);
});