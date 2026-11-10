// L0 结构化错误反馈：把平台后端面向人类的错误文案，转成写给大模型看的「修复指令」。
// 设计原则（见 documents/Agent循环失控防护机制详解.md 1.2 节）：
//   失败回注必须携带新信息（哪里错 / 应该是什么 / 下一步做什么），
//   否则模型上下文不变、输出必然复现，形成同参重试死循环。

// 按工具名给出「ID 不存在时应先查询哪个工具」的映射，写进 hint 引导模型换路
const ID_QUERY_TOOL: Record<string, string> = {
  complete_todo: 'get_my_todos',
  approve_approval: 'get_pending_approvals',
  reject_approval: 'get_pending_approvals',
  get_announcement_detail: 'list_announcements',
  get_employee_detail: 'list_employees',
  delete_knowledge_document: 'list_knowledge_documents',
};

// 按工具名给出其 ID 类参数键名，用于在错误里精确指出 received 值
const ID_FIELD_OF_TOOL: Record<string, string> = {
  complete_todo: 'id',
  approve_approval: 'id',
  reject_approval: 'id',
  get_announcement_detail: 'id',
  get_employee_detail: 'employeeId',
  delete_knowledge_document: 'id',
  create_todo: 'ownerId',
};

// 参数取值类错误的候选值表：field -> 合法枚举（与 tools/definitions.ts 的 schema 保持一致）
const ENUM_EXPECTED: Record<string, string[]> = {
  type: ['LEAVE', 'EXPENSE', 'PURCHASE'],
  status: ['PENDING', 'DONE'],
  priority: ['HIGH', 'MEDIUM', 'LOW'],
};

// 中文口语到枚举值的映射，用于给出 suggestion（模型下一轮大概率直接采纳）
const ENUM_SUGGESTION: Record<string, Record<string, string>> = {
  type: { 请假: 'LEAVE', 报销: 'EXPENSE', 采购: 'PURCHASE' },
  status: { 待处理: 'PENDING', 进行中: 'PENDING', 已完成: 'DONE' },
  priority: { 高: 'HIGH', 中: 'MEDIUM', 低: 'LOW' },
};

// 按工具名给出参数类错误的字段级提示（后端文案无法反推字段时的兜底）
const PARAM_HINT_BY_TOOL: Record<string, { field: string; hint: string }> = {
  create_approval: {
    field: 'type',
    hint: 'type 只接受枚举值 LEAVE/EXPENSE/PURCHASE，中文类型名会被拒绝',
  },
  create_todo: {
    field: 'title',
    hint: 'title 为必填字符串，不能为空',
  },
};

// 把后端错误文案 + 本次调用上下文，构造为结构化错误对象（回注给模型）
export function buildErrorFeedback(name: string, args: Record<string, unknown>, message: string): unknown {
  // 资源不存在类：指出 received 的 ID，并引导先查询真实 ID（禁止继续猜测）
  if (/不存在/.test(message)) {
    const field = ID_FIELD_OF_TOOL[name] ?? 'id';
    const received = args[field];
    const queryTool = ID_QUERY_TOOL[name];
    return {
      error: 'NOT_FOUND',
      tool: name,
      field,
      received: received ?? null,
      hint: queryTool
        ? `${message}。ID 不能猜测，请先调用 ${queryTool} 查询真实 ID 后再重试`
        : `${message}。请先用查询工具确认目标存在后再操作`,
    };
  }

  // 枚举/取值类：给出合法候选值与最可能的修正建议
  if (/不正确/.test(message)) {
    const known = PARAM_HINT_BY_TOOL[name];
    const field = known?.field ?? '参数';
    const received = known ? args[known.field] : undefined;
    const expected = ENUM_EXPECTED[field];
    const suggestion = received !== undefined ? ENUM_SUGGESTION[field]?.[String(received)] : undefined;
    return {
      error: 'INVALID_PARAM',
      tool: name,
      field,
      received: received ?? null,
      ...(expected ? { expected_one_of: expected } : {}),
      ...(suggestion ? { suggestion } : {}),
      hint: known?.hint ?? message,
    };
  }

  // 必填缺失类：指出缺失字段
  if (/不能为空/.test(message)) {
    return {
      error: 'MISSING_PARAM',
      tool: name,
      hint: `${message}。请补全必填参数后重试`,
    };
  }

  // 唯一性冲突类：参数本身合法，重试无意义，必须换值
  if (/已存在/.test(message)) {
    return {
      error: 'CONFLICT',
      tool: name,
      hint: `${message}。该值已被占用，更换新值后再试，不要原样重试`,
    };
  }

  // 权限类：改参数无用，引导换路径或向用户说明
  if (/无权限/.test(message)) {
    return {
      error: 'FORBIDDEN',
      tool: name,
      hint: `${message}。这是权限问题而非参数问题，请勿重试，改为向用户说明或换用有权限的操作`,
    };
  }

  // 状态冲突类（如重复审批）：目标已处理，重试无意义
  if (/已处理/.test(message)) {
    return {
      error: 'ALREADY_PROCESSED',
      tool: name,
      hint: `${message}。目标状态已变更，请勿重试，可重新查询最新状态`,
    };
  }

  // 兜底：保留原始文案，但明确告知模型这是未分类错误
  return { error: message, tool: name };
}

// 网络/超时类错误：瞬时故障，参数无问题。
// 语义上禁止模型同参重试（重试由框架退避策略负责），错误消息引导模型直接说明情况。
export function buildTransientError(name: string, err: unknown): unknown {
  return {
    error: 'SERVICE_UNAVAILABLE',
    tool: name,
    hint: `调用后端服务失败（${err instanceof Error ? err.message : String(err)}）。这是瞬时故障而非参数问题，请勿原样重试，直接向用户说明服务暂不可用`,
  };
}

// 后端返回了响应体但结构异常（非标准 { code, message, data }）
export function buildMalformedResponseError(name: string, httpStatus: number): unknown {
  return {
    error: 'SERVICE_UNAVAILABLE',
    tool: name,
    hint: `平台接口返回异常（HTTP ${httpStatus}）。请勿原样重试，直接向用户说明服务暂不可用`,
  };
}
