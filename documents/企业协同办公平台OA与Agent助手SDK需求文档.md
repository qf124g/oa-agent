# 企业协同办公平台（OA）+ Agent 助手 SDK 需求文档

## 背景与目标

「企业协同办公平台（OA）」演示项目：

- **React 前端**（web）+ **Node.js 业务后端**（backend = Express + TS）+ **Agent 助手**（agent-server = Node 服务 + agent-sdk = React SDK）
- Agent 助手独立于业务前后端开发：前端只通过 SDK 接入，agent-server 通过 REST 调业务后端
- 助手为**悬浮弹窗**，点击打开会话面板
- 覆盖：事项代办、新建（待办/审批/公告/知识库文档等写操作）、权限校验、用户确认操作、基础知识问答、知识库构建（向量 RAG）
- 写操作**完整落地**（真正调后端执行 + 确认 + 权限校验，非演示假成功）

### 关键决策

| 决策项 | 结论 |
|---|---|
| 领域 | 企业协同办公平台（OA） |
| 业务后端 | Node.js（Express + TypeScript + tsx），内存数据存储，纳入 npm workspaces 统一编排 |
| Agent 写操作 | 完整落地（新建/审批真正落库，含确认与权限） |
| 知识库 | 向量库 RAG（Embedding + 余弦相似度检索） |
| 前端 UI | Ant Design v6 + AntV 图表，统一主题 |

## 总体架构

```
浏览器 web (Vite 5173)
  │ 页面数据 HTTP + Bearer token            │ 聊天 SSE + Bearer token
  ▼                                          ▼
backend (Express 8080)               agent-server (Express 3002)
  ▲                                          │ ① toolcall 多步推理循环
  │ 工具执行透传 Bearer token                │ ② 写操作确认协议
  └──────────────────────────────────────────┤ ③ RAG 向量检索
                                             ▼
                              大模型/Embedding（OpenAI 兼容协议，阿里云百炼 qwen-plus + text-embedding-v3）
```

- npm workspaces 统一管理 4 个包：web / backend / agent-server / agent-sdk（SDK 无独立服务，源码引用）
- 统一响应 `{code,message,data}`、分页 `{list,total,page,pageSize}`、SSE 事件流、`AgentProvider.getAuthHeaders` 鉴权透传模式

## OA 领域模型与页面

### 领域实体（backend 内存 Map，带种子数据）

- **Department** 部门：id、name、parentId、managerEmployeeId、orderNo
- **Employee** 员工：id、userNo、name、departmentId、title、phone、email、role(EMPLOYEE/ADMIN)、password
- **TodoTask** 待办：id、ownerId、title、description、priority(HIGH/MEDIUM/LOW)、status(PENDING/DONE)、dueDate、assignerId、createdAt
- **ApprovalRequest** 审批：id、type(LEAVE/EXPENSE/PURCHASE)、applicantId、title、detail(JSON)、amount、status(PENDING/APPROVED/REJECTED)、approverId、comment、createdAt、decidedAt
- **Announcement** 公告：id、title、content、authorId、pinned、publishedAt
- **KnowledgeDocument** 知识库文档：id、title、content、category、uploadedBy、createdAt、updatedAt

### 角色权限

| 能力 | EMPLOYEE | ADMIN |
|---|---|---|
| 登录/查通讯录/公告/读知识库 | ✅ | ✅ |
| 自己的待办（查/建/完成） | ✅ | ✅ |
| 发起审批/查自己发起的 | ✅ | ✅ |
| 审批（通过/驳回） | ❌ | ✅ |
| 发布公告 | ❌ | ✅ |
| 知识库文档新增/删除 | ❌ | ✅ |
| 新增员工 | ❌ | ✅ |

固定账号（密码均为 123456）：admin（陈昊，ADMIN）、zhangwei（张伟）、lina（李娜）。

### 页面清单

| 路由 | 页面 | 要点 |
|---|---|---|
| /login | 登录 | 账号密码，token 存 localStorage |
| / | 工作台 Dashboard | 统计卡片 + AntV 数据概览柱状图 + 我的待办/审批速览 |
| /todo | 待办任务 | 列表/筛选/新建/标记完成 |
| /approval | 审批中心 | 三 Tab：我发起的/待我审批/发起申请 |
| /announcement | 公告 | 列表/详情/置顶，ADMIN 发布 |
| /directory | 通讯录 | 部门筛选 + 姓名搜索 + 员工详情 |
| /knowledge | 知识库 | 文档列表/详情/新增/删除（ADMIN 管理） |

## agent-server 设计（Express 3002）

### 业务工具（19 个）

- **只读（11 个，直接执行）**：get_workbench_stats / get_my_todos / get_my_approvals / get_pending_approvals / list_announcements / get_announcement_detail / list_departments / list_employees / get_employee_detail / list_knowledge_documents / search_knowledge（RAG 检索，不直接调业务后端）
- **写操作（8 个，走确认协议）**：create_todo / complete_todo / create_approval / approve_approval / reject_approval / create_announcement / add_knowledge_document / delete_knowledge_document

工具以 JSON Schema 声明参数约束注入模型，配合 System Prompt 引导按业务意图与角色权限选工具。

### 推理循环（agent-loop）

模型思考 → 工具决策 → 执行 → 结果回注 → 汇总回复；单轮支持多工具串行调用，8 步熔断防失控。流式响应中 tool_calls 为分片传输（arguments 增量字符串），按 index 累积拼接后统一解析。

### 确认操作协议（Human-in-the-loop）

状态机：`RUNNING → 拦截写工具 → 存 pendingConfirmation → 发 confirmation_request → 结束本轮 SSE →（前端消息流推入确认卡片，用户在卡片上确认/取消）→ POST /api/chat/confirm → 回填 tool_result → 续传 RUNNING → 最终答复 → done`

确认接口：

```
POST /api/chat/confirm   body { sessionId, confirmId, approved }
响应：新 SSE 流（confirmation_result → tool_call/tool_result → message_delta... → done）
```

服务端：写工具在推理循环中、执行 executor 前被拦截；pendingConfirmation 记录 assistant tool_call 消息 + 工具名/args/toolCallId，confirmId 一次性消费且 5 分钟过期；确认后调 executeTool（真正落库）或构造取消结果，追加 tool 消息后继续循环。会话历史保留未完成的 assistant tool_call 消息作为恢复上下文。

前端（卡片式确认，非弹窗）：

1. SDK 收到 confirmation_request 后，将一张确认卡片（ConfirmationItem，status=pending）**推入消息流**，与对话消息、工具调用块按时间顺序混排
2. 卡片内容：操作徽标（normal 蓝标 / dangerous 红标）+ 操作标题 + 人类可读摘要（由服务端 WRITE_TOOL_META 的 summaryFields 拼装）+ 可折叠的操作参数 JSON + 「取消 / 确认执行」按钮
3. 用户点击后按钮进入禁用态（防重复提交），SDK 调 POST /api/chat/confirm 续传
4. 收到 confirmation_result 后卡片按 confirmId **定格为「已确认」（绿标）/「已取消」（灰标）**，不再消失，作为会话记录保留——回溯对话时能看清当时确认了什么操作
5. 一个会话同一时刻至多一张待确认卡片（服务端单 pendingConfirmation 约束）；清空会话（新会话）时卡片随消息流一并清除

### SSE 事件协议（11 种）

| 事件 | 说明 |
|---|---|
| session | 会话 ID 下发 |
| message_start / message_delta / message_end | 助手回复流式输出 |
| tool_call / tool_result | 工具决策与执行结果 |
| log | 逐步骤执行日志（第 N 步、标题、详情、原始数据），驱动前端日志面板 |
| confirmation_request / confirmation_result | 写操作确认请求（含 title/summary/payload/severity）与结果 |
| error / done | 错误与结束 |

### 鉴权透传

POST /api/chat 与 /api/chat/confirm 取 Bearer token → 调 backend GET /api/auth/me 校验并拿当前用户 → 绑定到会话；executeTool 每次透传 Bearer token 调 backend；写操作最终权限由 backend 判定（agent-server 不自行判角色），AI 操作权限与用户页面操作完全一致。

### RAG 知识库

- 文档 source of truth = backend（KnowledgeDocument），向量索引 = agent-server 内存
- 同步策略为**懒同步**：首次检索前全量同步一次；新增/删除文档的写操作后将索引标记失效，下次检索前再同步
- 增量更新按 contentHash（md5）：内容未变的文档跳过重新向量化，后端已删除的文档级联移出索引
- 链路：chunker（分块）→ embedding（/embeddings）→ vector-index（余弦 TopK）→ search_knowledge 工具 → 文本块注入 Prompt

### 文件结构与环境变量

```
agent-server/src/
  index.ts        # 路由：/api/chat、/api/chat/confirm、/api/health
  agent-loop.ts   # toolcall 多步推理循环 + 确认协议状态机
  session.ts      # 会话存储与 pendingConfirmation
  sse.ts          # SSE 事件封装
  auth.ts         # token 解析与用户校验
  prompts.ts      # System Prompt
  config.ts       # 环境变量
  tools/          # definitions.ts（19 工具 JSON Schema）+ executor.ts（透传执行）
  rag/            # chunker / embedding / vector-index / knowledge-sync
```

| 环境变量（.env） | 默认 | 说明 |
|---|---|---|
| OPENAI_BASE_URL | 阿里云百炼兼容模式端点 | OpenAI 兼容协议，可切换智谱/DeepSeek |
| OPENAI_API_KEY | - | 必填，大模型密钥 |
| OPENAI_MODEL | qwen-plus | 对话模型 |
| EMBEDDING_MODEL | text-embedding-v3 | RAG 向量化模型 |
| PORT | 3002 | 服务端口 |
| PLATFORM_API_BASE | http://localhost:8080 | 业务后端地址 |
| KNOWLEDGE_TOP_K | 4 | RAG 检索返回文本块数量 |
| INTERNAL_SECRET | dev-internal-secret | 领域事件内部回调密钥（与 backend 保持一致） |

## 助手主动触达（业务事件推送，P1）

用户在网页上完成业务操作后，助手主动推送一条消息到会话面板，用户可点快捷按钮让助手代办后续流程，避免在页面间逐个跳转。

链路：`web 页面操作 → backend 落库 → 同步回调 agent-server（POST /internal/events，X-Internal-Secret 共享密钥鉴权）→ 领域事件转模板消息 → 常驻事件通道 SSE 推送 → SDK 注入消息流 + 未读角标 → 用户点快捷按钮代发预置指令 → 进入正常 agent 循环（写操作仍走确认卡片）`

要点：

- 事件通道：`GET /api/agent/events` 常驻 SSE 连接（Bearer 鉴权、25s 心跳保活、断线指数退避重连）；同一用户多标签页全部推送
- 离线收件箱：用户无在线连接时按用户暂存（上限 20 条），连接建立后补发
- 防自循环：事件带 source 字段（web / agent），agent-server 工具调用统一带 `X-Source: agent` 头，助手代办触发的业务事件不再回推
- 推送形态：模板消息（标题 + 文案 + 快捷操作按钮），零 token 成本、确定性强；LLM 个性化建议作为后续增强
- 已实现事件：`todo.created`（补充描述、查看我的待办）、`employee.created`（生成入职待办、发欢迎公告，web 端已补管理员新建员工入口）；后续扩展 approval.submitted / approval.decided 等

## agent-sdk 设计（React SDK）

组件结构：index / context.tsx（AgentProvider + getAuthHeaders + 事件分发 + 常驻事件连接）/ sse-client.ts（streamChat + confirmChat + connectEvents）/ FloatingAssistant（悬浮球 + 未读角标）/ ChatPanel（对话视图与日志视图切换、推送消息与快捷按钮渲染）/ ConfirmCard（内联确认卡片） / types.ts

对外 API：

```tsx
<AgentProvider url={AGENT_SERVER_URL} getAuthHeaders={() => ({ Authorization: `Bearer ${token}` })}>
  <FloatingAssistant />
</AgentProvider>
```

context 能力：open/close/toggle、sendMessage、消息流（ChatItem = 普通消息 AgentMessage | 确认卡片 ConfirmationItem）、unreadCount（未读角标）、pendingConfirmation、confirm(approved)、logs（执行日志）。

确认卡片（ConfirmCard）：消息流中的一等条目。confirmation_request 事件到达时在消息流尾部插入 pending 态卡片（含 title/summary/可折叠 payload，dangerous 红标）；用户在卡片上点「确认执行/取消」调 confirm；confirmation_result 事件按 confirmId 将卡片定格为已确认（绿标）/已取消（灰标），按钮区随之隐藏，卡片永久保留在会话记录中。

日志面板：渲染 SSE log 事件，逐步展示"第 N 步做了什么任务、决策了什么工具、返回了什么信息"，支持展开原始 JSON；done 事件时将最终回复打印到浏览器控制台。

## web 前端设计

```
web/src/ main.tsx（ConfigProvider 主题 + 中文 locale）/ App.tsx（路由 + 登录守卫）/ constants.ts / api.ts（统一附 token）
 ├── auth/ AuthContext（token 存取、user、login/logout）
 ├── components/ Layout（antd Sider + Menu + 顶栏，内嵌 FloatingAssistant）/ DataTable / StatCard
 └── pages/ Login / Dashboard / Todo / Approval / Announcement / Directory / Knowledge
```

- UI 基于 Ant Design v6（ConfigProvider 统一主题色 #1677ff）+ AntV 图表；无 emoji，注释中文 UTF-8
- 后端地址：开发环境直连 localhost:8080 / localhost:3002；生产构建由 .env.production 置空走同源 nginx 反代

## 端口与启动

| 服务 | 端口 | 启动 |
|---|---|---|
| backend | 8080 | npm run dev -w backend |
| agent-server | 3002 | npm run dev -w agent-server |
| web | 5173 | npm run dev -w web |
| agent-sdk | 无 | 源码引用 |

根 package.json（workspaces: web / backend / agent-server / agent-sdk）一键启动：

```bash
npm install
cp agent-server/.env.example agent-server/.env   # 填入 OPENAI_API_KEY
npm run dev    # concurrently 并行拉起 backend / agent / web
```

要求 Node 20+（本机用 `export PATH=/Users/test/.nvm/versions/node/v20.20.2/bin:$PATH` 切换）。

## 生产部署

- 前端构建：`npm run build -w web`（产物 web/dist，同源模式）
- 进程守护：根目录 ecosystem.config.js（pm2 双进程：oa-backend:8080 + oa-agent-server:3002）
- 反向代理：deploy/nginx.conf，/api/chat(/confirm) → 3002（SSE 关闭缓冲），其余 /api/* → 8080，前端静态托管 + SPA 回退

## 验证清单

1. `npm run dev` 一键拉起 8080/3002/5173；无 token 调 /api/auth/me 返回 401
2. admin/123456 登录 → 进入工作台，统计卡片与 AntV 图表渲染，数据来自 backend
3. 7 个页面渲染正常，数据与内存种子一致
4. 只读链路：带 token 问「我的待办有哪些」→ SSE 事件序列完整（session → log → tool_call → tool_result → message_delta... → message_end → done），日志面板逐步可见
5. 鉴权：zhangwei（EMPLOYEE）问「帮我审批第一条申请」→ 返回 403 语义，不越权
6. 确认写闭环：admin 说「帮我新建待办：明天提交周报」→ 消息流推入确认卡片 → 点确认 → 真落库 → 待办页可见 → 流式答复，卡片定格为「已确认」；点取消则不落库，卡片定格为「已取消」
7. 审批闭环：admin 发起报销 → 确认协议真正通过/驳回 → 状态变化
8. RAG：新增知识库文档（如考勤制度）→ 提问命中并注入语义回答；删除后不再命中
9. 硬约束：注释中文 UTF-8、无 emoji、Ant Design 统一 UI
