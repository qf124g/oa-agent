import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { BusinessError, ok, fail, paginate, asInt, str, plusDays } from './common';
import { store } from './store';
import { tokenStore } from './auth';
import { emitDomainEvent } from './notify';
import { extractTextFromBuffer } from './extract-text';
import { loadKnowledgeSeed } from './seed-knowledge';
import type {
  ApprovalRequest,
  ApprovalType,
  AuthUser,
  Employee,
  FaqEntry,
  KnowledgeDocument,
  Role,
  SynonymEntry,
  TodoPriority,
  TodoTask,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
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

// 从请求头读取幂等键（agent-server 写工具透传，超时重试时按同一 key 去重）
function idempotencyKey(req: Request): string | undefined {
  const v = req.headers['idempotency-key'];
  return typeof v === 'string' && v ? v : undefined;
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

// ---------- 幂等对账 ----------

// 对账查询：agent 写工具重试耗尽后，用同一幂等键确认「这笔写是否已落库」。
// 命中返回首次执行结果（found=true），未命中返回 found=false。
app.get('/api/idempotency/:key', (req, res) => {
  const result = store.getIdempotentResult(req.params.key);
  res.json(ok({ found: result !== undefined, result: result ?? null }));
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
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
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
    return t;
  });
  // 调试用：设置环境变量 SLOW_WRITE_MS（毫秒，需大于客户端 10s 超时，如 12000）后，
  // 首次真实写入（非幂等回放）在落库完成后延迟响应，制造「超时但已写成功」场景；
  // 客户端超时后按同一 Idempotency-Key 重试，命中缓存直接返回，不重复落库。
  const slowMs = Number(process.env.SLOW_WRITE_MS);
  const respond = () => {
    res.json(ok(result));
    // 领域事件：仅在首次执行时触发，幂等回放不重复推送
    if (!replayed) {
      emitDomainEvent({
        type: 'todo.created',
        actorId: user.userId,
        source: req.headers['x-source'] === 'agent' ? 'agent' : 'web',
        data: { id: result.id, title: result.title, priority: result.priority, dueDate: result.dueDate },
      });
    }
  };
  if (!replayed && Number.isFinite(slowMs) && slowMs > 0) {
    // 首次真实写入：落库已完成，这里延迟响应，客户端 10s 超时后会用同一 key 重试
    console.log(`[backend] create_todo 首次写入已落库（id=${result.id}），延迟 ${slowMs}ms 响应以制造客户端超时`);
    setTimeout(respond, slowMs);
  } else {
    // 重试命中缓存：直接回放首次结果，不再重复落库
    if (replayed) {
      console.log(`[backend] create_todo 命中幂等缓存，回放首次结果（id=${result.id}），不重复落库`);
    }
    respond();
  }
});

app.patch('/api/todos/:id/complete', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const { result } = store.runIdempotent(idempotencyKey(req), () => {
    const t = store.todos.get(req.params.id);
    if (!t) {
      throw new BusinessError(404, '待办不存在');
    }
    if (user.role !== 'ADMIN' && t.ownerId !== user.userId) {
      throw new BusinessError(403, '无权限操作该待办');
    }
    t.status = 'DONE';
    t.updatedAt = Date.now();
    store.todos.set(t.id, t);
    return { ...t, ownerName: store.employeeName(t.ownerId) };
  });
  res.json(ok(result));
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
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
    const a: ApprovalRequest = {
      id: store.nextId('A'),
      type: typeStr as ApprovalType,
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
    return a;
  });
  res.json(ok(result));
  // 领域事件：仅在首次执行时触发，幂等回放不重复推送（新审批通知所有管理员，排除申请人自己）
  if (!replayed) {
    const adminIds = [...store.employees.values()]
      .filter((e) => e.role === 'ADMIN' && e.id !== user.userId)
      .map((e) => e.id);
    emitDomainEvent({
      type: 'approval.submitted',
      actorId: user.userId,
      source: req.headers['x-source'] === 'agent' ? 'agent' : 'web',
      targetUserIds: adminIds,
      data: { id: result.id, title, type: typeStr, amount: result.amount, applicantName: store.employeeName(user.userId) },
    });
  }
});

app.post('/api/approvals/:id/approve', requireRole('ADMIN'), (req, res) => {
  const comment = str(req.body?.comment);
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () =>
    decide(req as AuthedRequest, req.params.id, comment, true)
  );
  res.json(ok(result));
  if (!replayed) emitDecisionEvent(req, result, comment);
});

app.post('/api/approvals/:id/reject', requireRole('ADMIN'), (req, res) => {
  const comment = str(req.body?.comment);
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () =>
    decide(req as AuthedRequest, req.params.id, comment, false)
  );
  res.json(ok(result));
  if (!replayed) emitDecisionEvent(req, result, comment);
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
  const { result } = store.runIdempotent(idempotencyKey(req), () => {
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
    return n;
  });
  res.json(ok(result));
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

// 更新员工信息（管理员）：工号即登录账号，改工号需唯一校验（排除自身）；密码留空则不修改
app.patch('/api/employees/:id', requireRole('ADMIN'), (req, res) => {
  const emp = store.employees.get(req.params.id);
  if (!emp) {
    throw new BusinessError(404, '员工不存在');
  }
  const b = req.body ?? {};
  const userNo = b.userNo !== undefined ? String(b.userNo).trim() : emp.userNo;
  const name = b.name !== undefined ? String(b.name).trim() : emp.name;
  const departmentId = b.departmentId !== undefined ? String(b.departmentId).trim() : emp.departmentId;
  const title = b.title !== undefined ? String(b.title).trim() : emp.title;
  if (!userNo || !name || !departmentId || !title) {
    throw new BusinessError(400, '工号、姓名、部门、职位不能为空');
  }
  if ([...store.employees.values()].some((e) => e.userNo === userNo && e.id !== emp.id)) {
    throw new BusinessError(400, `工号 ${userNo} 已存在`);
  }
  if (!store.departments.has(departmentId)) {
    throw new BusinessError(400, '部门不存在');
  }
  emp.userNo = userNo;
  emp.name = name;
  emp.departmentId = departmentId;
  emp.title = title;
  if (b.phone !== undefined) emp.phone = String(b.phone).trim();
  if (b.email !== undefined) emp.email = String(b.email).trim() || `${userNo}@oa.local`;
  if (b.role !== undefined) emp.role = b.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
  if (b.password !== undefined && String(b.password).trim() !== '') emp.password = String(b.password);
  store.employees.set(emp.id, emp);
  res.json(ok(sanitizeEmployee(emp)));
});

// ---------- 知识库 ----------

// 文件上传（内存存储，10MB 上限）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 知识库写操作后：发送 knowledge.updated 事件（携带全量文档正文），驱动 agent-server 实时重建向量索引
function emitKnowledgeEvent(req: Request): void {
  const docs = [...store.knowledgeDocs.values()].map((k) => ({
    id: k.id,
    title: k.title,
    content: k.content,
    category: k.category,
  }));
  // 仅同步已审核公开的词典与 FAQ，未审核的用户数据不进检索链路
  const synonyms = [...store.synonyms.values()].filter((s) => s.status === 'APPROVED' && s.scope === 'PUBLIC');
  const faqs = [...store.faqs.values()].filter((f) => f.status === 'APPROVED' && f.scope === 'PUBLIC');
  const user = (req as AuthedRequest).currentUser as AuthUser;
  emitDomainEvent({
    type: 'knowledge.updated',
    actorId: user.userId,
    source: (req.headers['x-source'] as string) === 'agent' ? 'agent' : 'web',
    data: { docs, synonyms, faqs },
  });
}

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

// ---------- 同义词词典（查询改写热加载数据源，管理员维护） ----------

// 清洗主词：去首尾空白
function normalizeTerm(v: string): string {
  return v.trim();
}

// 清洗同义词列表：逐项 trim、去空、去重
function normalizeSynonyms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 清洗问题：trim + 折叠连续空白
function normalizeQuestion(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

// 清洗答案：非字符串或空白返回 null
function normalizeAnswer(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s || null;
}

// 拉取已审核公开的同义词词典（供 agent-server 查询改写热加载）
app.get('/api/knowledge/synonyms', (_req, res) => {
  const list = [...store.synonyms.values()].filter((s) => s.status === 'APPROVED' && s.scope === 'PUBLIC');
  res.json(ok(list));
});

// 新增同义词（管理员）：管理员操作视为已审核，直接进入检索链路
app.post('/api/knowledge/synonyms', requireRole('ADMIN'), (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const term = normalizeTerm(str(body.term));
  const synonyms = normalizeSynonyms(body.synonyms);
  if (!term || synonyms.length === 0) {
    throw new BusinessError(400, '主词和同义词不能为空');
  }
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
    const now = Date.now();
    const s: SynonymEntry = {
      id: store.nextId('S'),
      term,
      synonyms,
      source: str(body.source) || 'manual',
      status: 'APPROVED',
      scope: 'PUBLIC',
      departmentId: null,
      createdBy: user.userId,
      createdAt: now,
      updatedAt: now,
    };
    store.synonyms.set(s.id, s);
    return s;
  });
  res.json(ok(result));
  if (!replayed) emitKnowledgeEvent(req);
});

// 删除同义词（管理员）：移除后触发事件，词典热加载同步移除
app.delete('/api/knowledge/synonyms/:id', requireRole('ADMIN'), (req, res) => {
  if (!store.synonyms.delete(req.params.id)) {
    throw new BusinessError(404, '同义词不存在');
  }
  res.json(ok(null));
  emitKnowledgeEvent(req);
});

// ---------- FAQ（高频用户问题，独立索引数据源，需审核） ----------

// 拉取 FAQ：默认只返回已审核公开（供 agent-server 构建独立索引）；
// 管理员可传 status=PENDING / ALL 查看待审核或全部条目
app.get('/api/knowledge/faqs', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const status = queryStr(req.query.status);
  let list = [...store.faqs.values()];
  if (status === 'PENDING' || status === 'ALL') {
    if (user.role !== 'ADMIN') throw new BusinessError(403, '无权限查看待审核 FAQ');
    if (status === 'PENDING') list = list.filter((f) => f.status === 'PENDING');
  } else {
    list = list.filter((f) => f.status === 'APPROVED' && f.scope === 'PUBLIC');
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(ok(list));
});

// 提交用户问题为 FAQ 候选（用户/助手）：PENDING 待审核，暂不进检索链路
app.post('/api/knowledge/faqs', (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const question = normalizeQuestion(str(body.question));
  const answer = normalizeAnswer(body.answer);
  if (!question) throw new BusinessError(400, '问题不能为空');
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
    const now = Date.now();
    const f: FaqEntry = {
      id: store.nextId('F'),
      question,
      answer,
      source: str(body.source) || 'user_query',
      status: 'PENDING',
      scope: 'PUBLIC',
      departmentId: null,
      createdBy: user.userId,
      createdAt: now,
      updatedAt: now,
    };
    store.faqs.set(f.id, f);
    return f;
  });
  res.json(ok(result));
  // PENDING 不触发索引同步，审核通过后才同步
});

// 审核 FAQ（管理员）：通过后进入检索链路
app.post('/api/knowledge/faqs/:id/approve', requireRole('ADMIN'), (req, res) => {
  const f = store.faqs.get(req.params.id);
  if (!f) throw new BusinessError(404, 'FAQ 不存在');
  f.status = 'APPROVED';
  f.updatedAt = Date.now();
  store.faqs.set(f.id, f);
  res.json(ok(f));
  emitKnowledgeEvent(req);
});

// 删除 FAQ（管理员）：驳回候选或移除已审核条目；已审核的删除触发索引同步
app.delete('/api/knowledge/faqs/:id', requireRole('ADMIN'), (req, res) => {
  const f = store.faqs.get(req.params.id);
  if (!f) throw new BusinessError(404, 'FAQ 不存在');
  store.faqs.delete(req.params.id);
  res.json(ok(null));
  if (f.status === 'APPROVED') emitKnowledgeEvent(req);
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
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
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
    return k;
  });
  res.json(ok(result));
  if (!replayed) emitKnowledgeEvent(req);
});

app.delete('/api/knowledge/:id', requireRole('ADMIN'), (req, res) => {
  const { result, replayed } = store.runIdempotent(idempotencyKey(req), () => {
    if (!store.knowledgeDocs.delete(req.params.id)) {
      throw new BusinessError(404, '文档不存在');
    }
    return null;
  });
  res.json(ok(result));
  if (!replayed) emitKnowledgeEvent(req);
});

// 上传文档（管理员）：解析文件正文存入知识库，触发向量实时重建
app.post('/api/knowledge/upload', requireRole('ADMIN'), upload.single('file'), async (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  try {
    const file = req.file;
    if (!file) {
      res.json(fail(400, '未选择文件'));
      return;
    }
    const title = str(req.body.title) || file.originalname.replace(/\.[^.]+$/, '');
    const content = await extractTextFromBuffer(file.buffer, file.originalname);
    if (!content.trim()) {
      res.json(fail(400, '未能从文件中解析出文本，请确认文件内容为可提取的文本'));
      return;
    }
    const now = Date.now();
    const k: KnowledgeDocument = {
      id: store.nextId('K'),
      title,
      content,
      category: str(req.body.category) || '未分类',
      uploadedBy: user.userId,
      createdAt: now,
      updatedAt: now,
      uploadedByName: store.employeeName(user.userId),
    };
    store.knowledgeDocs.set(k.id, k);
    res.json(ok(k));
    emitKnowledgeEvent(req);
  } catch (err) {
    res.json(fail(500, `文件解析失败：${err instanceof Error ? err.message : String(err)}`));
  }
});

// ---------- 审批流程（自研 SVG 工作流画布） ----------

app.get('/api/workflows', (_req, res) => {
  const list = [...store.workflows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(ok(list));
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = store.workflows.get(req.params.id);
  if (!wf) {
    throw new BusinessError(404, '流程不存在');
  }
  res.json(ok(wf));
});

app.post('/api/workflows', requireRole('ADMIN'), (req, res) => {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  const body = req.body ?? {};
  const name = str(body.name).trim();
  if (!name) {
    throw new BusinessError(400, '流程名称不能为空');
  }
  const now = Date.now();
  const wf: WorkflowDefinition = {
    id: store.nextId('W'),
    name,
    approvalType: parseApprovalType(body.approvalType),
    nodes: sanitizeNodes(body.nodes),
    edges: sanitizeEdges(body.edges),
    createdBy: user.userId,
    createdByName: store.employeeName(user.userId),
    createdAt: now,
    updatedAt: now,
  };
  store.workflows.set(wf.id, wf);
  res.json(ok(wf));
});

app.patch('/api/workflows/:id', requireRole('ADMIN'), (req, res) => {
  const wf = store.workflows.get(req.params.id);
  if (!wf) {
    throw new BusinessError(404, '流程不存在');
  }
  const body = req.body ?? {};
  if (body.name !== undefined) {
    const name = str(body.name).trim();
    if (!name) {
      throw new BusinessError(400, '流程名称不能为空');
    }
    wf.name = name;
  }
  if (body.approvalType !== undefined) wf.approvalType = parseApprovalType(body.approvalType);
  if (body.nodes !== undefined) wf.nodes = sanitizeNodes(body.nodes);
  if (body.edges !== undefined) wf.edges = sanitizeEdges(body.edges);
  wf.updatedAt = Date.now();
  store.workflows.set(wf.id, wf);
  res.json(ok(wf));
});

app.delete('/api/workflows/:id', requireRole('ADMIN'), (req, res) => {
  if (!store.workflows.delete(req.params.id)) {
    throw new BusinessError(404, '流程不存在');
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

// 审批决策：校验并落库（持久化到 SQLite），返回带姓名信息的审批单
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
  store.approvals.set(a.id, a);
  return fillApprovalNames(a);
}

// 审批结果领域事件：通知申请人（仅在首次执行时调用，幂等回放不重复推送）
function emitDecisionEvent(req: Request, approval: ApprovalRequest, comment: string): void {
  const user = (req as AuthedRequest).currentUser as AuthUser;
  emitDomainEvent({
    type: 'approval.decided',
    actorId: user.userId,
    source: (req.headers['x-source'] as string) === 'agent' ? 'agent' : 'web',
    targetUserIds: [approval.applicantId],
    data: { id: approval.id, title: approval.title, type: approval.type, status: approval.status, comment, approverName: store.employeeName(user.userId) },
  });
}

// 审批类型白名单解析，非法值返回 null
function parseApprovalType(v: unknown): ApprovalType | null {
  return v === 'LEAVE' || v === 'EXPENSE' || v === 'PURCHASE' ? v : null;
}

function isNodeType(v: unknown): v is WorkflowNodeType {
  return v === 'START' || v === 'APPROVAL' || v === 'CONDITION' || v === 'END';
}

// 清洗节点数组：仅保留合法字段，坐标强制为数字，id 缺失时补随机 id
function sanitizeNodes(raw: unknown): WorkflowNode[] {
  if (!Array.isArray(raw)) return [];
  const result: WorkflowNode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    result.push({
      id: str(n.id) || randomUUID(),
      type: isNodeType(n.type) ? n.type : 'APPROVAL',
      title: str(n.title),
      x: typeof n.x === 'number' ? n.x : 0,
      y: typeof n.y === 'number' ? n.y : 0,
      config: n.config && typeof n.config === 'object' ? (n.config as Record<string, unknown>) : undefined,
    });
  }
  return result;
}

// 清洗连线数组：仅保留合法字段，id 缺失时补随机 id
function sanitizeEdges(raw: unknown): WorkflowEdge[] {
  if (!Array.isArray(raw)) return [];
  const result: WorkflowEdge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    result.push({
      id: str(e.id) || randomUUID(),
      from: str(e.from),
      to: str(e.to),
      label: e.label ? str(e.label) : undefined,
    });
  }
  return result;
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

// 启动：先加载知识库 seed（PDF/MD），再开始监听端口
async function bootstrap(): Promise<void> {
  await loadKnowledgeSeed();
  app.listen(PORT, () => {
    console.log(`[backend] 已启动，监听端口 ${PORT}`);
  });
}

void bootstrap();