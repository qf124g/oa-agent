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
];