// 评测用例：声明一条离线评测的输入与期望判定标准。
// 判定规则分两层：
//  1. 工具命中（规则判定）：最终实际调用的工具需覆盖 expectTools 中的每一项。
//  2. 关键词（规则判定）：expectKeywords 要求全部出现在最终回答中，forbidKeywords 要求全部不出现。
// expectKeywords / forbidKeywords 可留空，仅做工具命中校验。

export interface EvalCase {
  id: string;
  name: string;
  question: string;
  /** 期望调用的工具名（全部命中才判定工具维度通过） */
  expectTools: string[];
  /** 禁止调用的工具名（任一命中即不通过，用于验证模型没有走错误路径，如猜 ID 硬试） */
  forbidTools?: string[];
  /** 最终回答中必须包含的关键词（可选，全部命中） */
  expectKeywords?: string[];
  /** 最终回答中禁止出现的关键词（可选） */
  forbidKeywords?: string[];
  /** 是否产生写操作；写用例在确认环节默认按 autoApprove=false 取消，不会真实落库 */
  mutatesData?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'todos-001',
    name: '查询我的待办',
    question: '帮我看看我的待办事项有哪些',
    expectTools: ['get_my_todos'],
  },
  {
    id: 'knowledge-001',
    name: '知识库检索：报销流程',
    question: '公司的报销流程是怎样的？',
    expectTools: ['search_knowledge'],
  },
  {
    id: 'employees-001',
    name: '查询员工列表',
    question: '公司都有哪些员工？',
    expectTools: ['list_employees'],
  },
  {
    id: 'todo-create-001',
    name: '创建待办（写操作）',
    question: '帮我创建一条高优先级待办：明天下午参加项目评审会',
    expectTools: ['create_todo'],
    mutatesData: true,
  },
  // ID 幻觉场景：问题中不含任何真实待办 ID，模型若直接猜 ID 调 complete_todo 会失败，
  // 修复后（L0 结构化错误引导 + L2 重复短路）模型应转为先查询再操作。
  // 判定：最终调用了 get_my_todos（走了查询路径）且没有调用 complete_todo（没有猜 ID 硬试）。
  {
    id: 'hallucination-001',
    name: 'ID 幻觉：完成一个未指明 ID 的待办',
    question: '帮我把那条标题叫「提交本周工作周报」的待办标记为已完成',
    expectTools: ['get_my_todos'],
    forbidTools: ['complete_todo'],
  },
  // ID 幻觉场景（公告侧）：同样不含真实 ID，期望模型先查列表而不是猜 ID 取详情
  {
    id: 'hallucination-002',
    name: 'ID 幻觉：查看一条未指明 ID 的公告',
    question: '帮我看看那条关于「办公区消防演练安排」的公告，正文写了什么',
    expectTools: ['list_announcements'],
    forbidTools: ['get_announcement_detail'],
  },
  // 错误恢复场景：用户直接给出一个不存在的公告 ID，迫使 get_announcement_detail 返回 NOT_FOUND。
  // 用于真实触发 L0 结构化错误，观察模型拿到「先查询真实 ID」的 hint 后是否转为查列表恢复。
  // 判定：调用了 get_announcement_detail（触发错误）且最终也调用了 list_announcements（走了恢复路径）。
  {
    id: 'error-recovery-001',
    name: '错误恢复：用户给了不存在的公告 ID',
    question: '帮我看下公告 N999 的内容',
    expectTools: ['get_announcement_detail', 'list_announcements'],
  },
];