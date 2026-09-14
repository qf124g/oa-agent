import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// OA 领域工具定义：读工具直接执行，写工具需用户确认（requiresConfirmation=true）
// 大模型根据这些 schema 决定调用哪个工具、传什么参数

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  // ---------- 只读：工作台 ----------
  {
    type: 'function',
    function: {
      name: 'get_workbench_stats',
      description: '查询当前用户的工作台统计：我的待办数、待我审批数、公告数、员工数、部门数、知识库文档数，以及我的待办与审批速览列表。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ---------- 只读：待办 ----------
  {
    type: 'function',
    function: {
      name: 'get_my_todos',
      description: '查询待办任务列表，支持按归属人、状态筛选，分页返回。普通员工默认只看自己的待办，管理员可指定 ownerId 查看他人待办。需要待办 ID 时先用本工具查询。',
      parameters: {
        type: 'object',
        properties: {
          ownerId: { type: 'string', description: '归属员工 ID，管理员可指定，普通员工忽略' },
          status: { type: 'string', enum: ['PENDING', 'DONE'], description: '状态：PENDING 待处理 / DONE 已完成' },
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  // ---------- 只读：审批 ----------
  {
    type: 'function',
    function: {
      name: 'get_my_approvals',
      description: '查询当前用户发起的审批申请列表，支持按类型、状态筛选，分页返回。需要审批 ID 时先用本工具查询。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['LEAVE', 'EXPENSE', 'PURCHASE'], description: '类型：LEAVE 请假 / EXPENSE 报销 / PURCHASE 采购' },
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'], description: '状态：PENDING 待审批 / APPROVED 已通过 / REJECTED 已驳回' },
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_approvals',
      description: '查询待我审批的申请列表（仅管理员可用）。返回待审批的申请，包含申请人、类型、标题、金额等。',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  // ---------- 只读：公告 ----------
  {
    type: 'function',
    function: {
      name: 'list_announcements',
      description: '查询公告列表，置顶优先，分页返回公告的标题、作者、发布时间等摘要信息。需要公告正文时用 get_announcement_detail。',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_announcement_detail',
      description: '按公告 ID 查询公告详情，包含完整正文内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '公告 ID，如 N001' },
        },
        required: ['id'],
      },
    },
  },
  // ---------- 只读：组织架构 ----------
  {
    type: 'function',
    function: {
      name: 'list_departments',
      description: '查询公司所有部门列表，包含部门 ID、名称、负责人。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_employees',
      description: '查询员工列表，支持按部门、姓名关键字筛选，分页返回。需要员工 ID 时先用本工具查询。',
      parameters: {
        type: 'object',
        properties: {
          departmentId: { type: 'string', description: '部门 ID，不传查全部' },
          name: { type: 'string', description: '姓名关键字，模糊匹配' },
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_employee_detail',
      description: '按员工 ID 查询单个员工详细信息，包含部门、职位、联系方式、角色等。',
      parameters: {
        type: 'object',
        properties: {
          employeeId: { type: 'string', description: '员工 ID，如 E001' },
        },
        required: ['employeeId'],
      },
    },
  },
  // ---------- 只读：知识库 ----------
  {
    type: 'function',
    function: {
      name: 'list_knowledge_documents',
      description: '查询知识库文档列表（标题与分类摘要，不含正文），支持按分类筛选，分页返回。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '分类，如 制度/流程/FAQ' },
          page: { type: 'number', description: '页码，默认 1' },
          pageSize: { type: 'number', description: '每页条数，默认 10，最大 100' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '在公司知识库中做语义检索，返回与问题最相关的文档片段。适合回答制度、流程、常见问题等知识类提问。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索问题或关键词，如「考勤迟到会怎样」「报销流程」' },
        },
        required: ['query'],
      },
    },
  },
  // ---------- 只读：技能 ----------
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: '加载指定技能（skill）的详细步骤说明。当用户任务与某条注册技能匹配（如周报、新员工入职、报销汇总）时，先调用本工具读取步骤，再按步骤编排后续工具调用。',
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: '技能 ID，如 weekly-report / new-employee-onboarding / expense-report' },
        },
        required: ['skillId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_skill_script',
      description: '执行技能关联的本地计算脚本（只读、不发后端请求），用于数据汇总、格式转换等确定性计算，返回脚本计算结果。',
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: '技能 ID' },
          script: { type: 'string', description: '脚本文件名，如 summarize-expense.mjs' },
          args: { type: 'object', description: '传给脚本的参数对象，结构由对应技能步骤说明约定' },
        },
        required: ['skillId', 'script'],
      },
    },
  },
  // ---------- 写操作：待办 ----------
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: '新建一条待办任务（默认归属当前用户，管理员可指定他人）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '待办标题，必填' },
          description: { type: 'string', description: '待办详情描述' },
          priority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: '优先级：HIGH 高 / MEDIUM 中 / LOW 低，默认 MEDIUM' },
          dueDate: { type: 'string', description: '截止日期，格式 YYYY-MM-DD，默认 7 天后' },
          ownerId: { type: 'string', description: '归属员工 ID，管理员可指定，普通员工忽略' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_todo',
      description: '将指定待办任务标记为已完成（本人或管理员可操作）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 ID，如 T001' },
        },
        required: ['id'],
      },
    },
  },
  // ---------- 写操作：审批 ----------
  {
    type: 'function',
    function: {
      name: 'create_approval',
      description: '发起一条审批申请（请假/报销/采购）。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['LEAVE', 'EXPENSE', 'PURCHASE'], description: '审批类型：LEAVE 请假 / EXPENSE 报销 / PURCHASE 采购' },
          title: { type: 'string', description: '审批标题，必填' },
          detail: { type: 'object', description: '详情补充，随类型变化，如请假起止、报销明细' },
          amount: { type: 'number', description: '金额（报销/采购用，请假不传）' },
        },
        required: ['type', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_approval',
      description: '通过一条待审批的申请（仅管理员可操作）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '审批申请 ID，如 A001' },
          comment: { type: 'string', description: '审批意见' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_approval',
      description: '驳回一条待审批的申请（仅管理员可操作）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '审批申请 ID，如 A001' },
          comment: { type: 'string', description: '驳回理由' },
        },
        required: ['id'],
      },
    },
  },
  // ---------- 写操作：公告 ----------
  {
    type: 'function',
    function: {
      name: 'create_announcement',
      description: '发布一条公告（仅管理员可操作）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '公告标题，必填' },
          content: { type: 'string', description: '公告正文内容' },
          pinned: { type: 'boolean', description: '是否置顶' },
        },
        required: ['title'],
      },
    },
  },
  // ---------- 写操作：知识库 ----------
  {
    type: 'function',
    function: {
      name: 'add_knowledge_document',
      description: '新增一篇知识库文档（仅管理员可操作），新增后自动纳入向量检索。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题，必填' },
          content: { type: 'string', description: '文档正文，必填' },
          category: { type: 'string', description: '分类，如 制度/流程/FAQ，默认未分类' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_knowledge_document',
      description: '删除一篇知识库文档（仅管理员可操作），删除后同步移出向量索引。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '文档 ID，如 K001' },
        },
        required: ['id'],
      },
    },
  },
];

export interface WriteToolMeta {
  title: string;
  severity: 'normal' | 'high' | 'dangerous';
  summaryFields: { key: string; label: string }[];
}

// 写工具元信息：用于生成确认框展示的操作标题、摘要与严重级别
export const WRITE_TOOL_META: Record<string, WriteToolMeta> = {
  create_todo: { title: '新建待办', severity: 'normal', summaryFields: [{ key: 'title', label: '标题' }, { key: 'priority', label: '优先级' }] },
  complete_todo: { title: '完成待办', severity: 'normal', summaryFields: [{ key: 'id', label: '待办 ID' }] },
  create_approval: { title: '发起审批', severity: 'normal', summaryFields: [{ key: 'type', label: '类型' }, { key: 'title', label: '标题' }, { key: 'amount', label: '金额' }] },
  approve_approval: { title: '通过审批', severity: 'high', summaryFields: [{ key: 'id', label: '审批 ID' }, { key: 'comment', label: '意见' }] },
  reject_approval: { title: '驳回审批', severity: 'dangerous', summaryFields: [{ key: 'id', label: '审批 ID' }, { key: 'comment', label: '理由' }] },
  create_announcement: { title: '发布公告', severity: 'normal', summaryFields: [{ key: 'title', label: '标题' }, { key: 'pinned', label: '置顶' }] },
  add_knowledge_document: { title: '新增知识库文档', severity: 'normal', summaryFields: [{ key: 'title', label: '标题' }, { key: 'category', label: '分类' }] },
  delete_knowledge_document: { title: '删除知识库文档', severity: 'dangerous', summaryFields: [{ key: 'id', label: '文档 ID' }] },
};

export function isWriteTool(name: string): boolean {
  return name in WRITE_TOOL_META;
}