# 企业协同办公平台（OA）+ Agent 助手 SDK 需求文档与实施计划

## Context（背景与目标）

「企业协同办公平台（OA）」

- **react 前端**（web）+ **真实 Java 后端**（java-backend，Spring Boot，替代原 mock-platform-api）+ **agent 助手**（agent-server = Node + agent-sdk = React SDK）
- agent 助手独立于 Java 前端开发：前端只通过 SDK 接入，agent 通过 REST 调 Java 后端
- 助手为**悬浮弹窗**，点击打开会话面板
- 覆盖：事项代办、新建（待办/审批/公告/知识库文档等写操作）、权限校验、用户确认操作、基础知识回答、知识库构建（向量 RAG）
- 写操作**完整落地**（真正调后端执行 + 确认 + 权限校验，非演示假成功）

### 关键决策（已与用户确认）
| 决策项 | 结论 |
|---|---|
| 领域 | 企业协同办公平台（OA） |
| Java 后端 | 真实 Spring Boot（Maven 独立管理，非 mock） |
| agent 写操作 | 完整落地（新建/审批真正落库，含确认与权限） |
| 知识库 | 向量库 RAG（embedding + 余弦相似度检索） |

## 总体架构

```
浏览器 web (Vite 5173)
  │ 页面数据 HTTP + Bearer token            │ 聊天 SSE + Bearer token
  ▼                                          ▼
java-backend (Spring Boot 8080)      agent-server (Node 3002)
  ▲                                          │ ① function-calling 循环
  │ 工具执行透传 Bearer token                │ ② 写操作确认协议
  └──────────────────────────────────────────┤ ③ RAG 向量检索
                                             ▼
                                    大模型/Embedding（OpenAI 兼容，阿里云百炼 qwen-plus + text-embedding-v3）
```

- npm workspaces 管理 3 个 Node 包：web / agent-server / agent-sdk（SDK 无独立服务，源码引用）
- java-backend 独立于 npm，Maven 管理，`mvn spring-boot:run` 启动
- 沿用原有约定：统一响应 `{code,message,data}`、分页 `{list,total,page,pageSize}`、SSE 基元事件、`AgentProvider.getAuthHeaders` 透传模式

## OA 领域模型与页面

### 领域实体（Java 内存 ConcurrentHashMap，带种子数据）
- **Department** 部门：id、name、parentId、managerEmployeeId、orderNo
- **Employee** 员工：id、userNo、name、departmentId、title、phone、email、role(EMPLOYEE/ADMIN)、password
- **TodoTask** 待办：id、ownerId、title、description、priority(HIGH/MEDIUM/LOW)、status(PENDING/DONE)、dueDate、assignerId、createdAt
- **ApprovalRequest** 审批：id、type(LEAVE/EXPENSE/PURCHASE)、applicantId、title、detail(JSON)、amount、status(PENDING/APPROVED/REJECTED)、approverId、comment、createdAt、decidedAt
- **Announcement** 公告：id、title、content、authorId、pinned、publishedAt
- **KnowledgeDocument** 知识库文档：id、title、content、category、uploadedBy、createdAt、updatedAt

### 角色权限（demo 简化）
| 能力 | EMPLOYEE | ADMIN |
|---|---|---|
| 登录/查通讯录/公告/读知识库 | ✅ | ✅ |
| 自己的待办（查/建/完成） | ✅ | ✅ |
| 发起审批/查自己发起的 | ✅ | ✅ |
| 审批（通过/驳回） | ❌ | ✅ |
| 发布公告 | ❌ | ✅ |
| 知识库文档新增/删除 | ❌ | ✅ |

固定账号：admin/123456（ADMIN）、zhangwei/123456（EMPLOYEE）、lina/123456（EMPLOYEE）。

### 页面清单（前端）
| 路由 | 页面 | 要点 |
|---|---|---|
| /login | 登录 | 账号密码，token 存 localStorage |
| / | 工作台 Dashboard | 统计卡片 + 我的待办速览 + 待我审批速览 |
| /todo | 待办任务 | 列表/筛选/新建/标记完成 |
| /approval | 审批中心 | 三 Tab：我发起的/待我审批/发起申请 |
| /announcement | 公告 | 列表/详情/置顶，ADMIN 发布 |
| /directory | 通讯录 | 部门筛选 + 员工列表/详情 |
| /knowledge | 知识库 | 文档列表/详情/新增/删除（ADMIN 管理） |

## Java 后端（java-backend，Spring Boot 3.x）

目录（到包/类级别）：
```
java-backend/
├── pom.xml                                  # Spring Boot 3.2.x, JDK 17, 仅 starter-web + validation
├── src/main/resources/application.yml       # server.port=8080
└── src/main/java/com/oa/
    ├── OaApplication.java
    ├── common/        # ApiResponse / PageResult / BusinessException / GlobalExceptionHandler
    ├── auth/          # AuthController / AuthService / TokenStore / AuthUser / AuthFilter / RequireRole / RoleInterceptor
    ├── entity/        # Department/Employee/TodoTask/ApprovalRequest/Announcement/KnowledgeDocument + 枚举
    ├── store/         # InMemoryDataStore（ConcurrentHashMap + 种子数据 + id 生成）
    ├── controller/    # Department/Employee/Todo/Approval/Announcement/Knowledge/Dashboard Controller
    └── service/       # 对应 Service（写操作含权限二次校验）
```

REST 端点（响应 `{code,message,data}`，分页 `{list,total,page,pageSize}`；除 login 外均需 Bearer token）：
- POST /api/auth/login、GET /api/auth/me
- GET /api/departments；GET /api/employees、GET /api/employees/{id}
- GET /api/todos、POST /api/todos、PATCH /api/todos/{id}/complete
- GET /api/approvals/mine、GET /api/approvals/pending（ADMIN）、POST /api/approvals、POST /api/approvals/{id}/approve、POST /api/approvals/{id}/reject
- GET /api/announcements、GET /api/announcements/{id}、POST /api/announcements（ADMIN）
- GET /api/knowledge、POST /api/knowledge（ADMIN）、DELETE /api/knowledge/{id}（ADMIN）
- GET /api/dashboard/stats

鉴权：TokenStore 内存（UUID token + 过期）；AuthFilter 解析 Bearer → 写 request attribute；RequireRole 注解 + RoleInterceptor 校验 ADMIN；写操作权限在 Service 层二次校验（最终安全屏障）。

## agent-server 扩展（Node 3002）

### 工具清单（约 16 个）
读工具（直接执行）：get_workbench_stats / get_my_todos / get_my_approvals / get_pending_approvals / list_announcements / get_announcement_detail / list_departments / list_employees / get_employee_detail / list_knowledge_documents

写工具（requiresConfirmation=true，走确认协议）：create_todo / complete_todo / create_approval / approve_approval / reject_approval / create_announcement / add_knowledge_document / delete_knowledge_document

RAG 工具：search_knowledge（本地向量检索，不调 Java）

### 用户确认操作协议（重点）
状态机：`RUNNING → 拦截写工具 → 存 pendingConfirmation → 发 confirmation_request → 结束本轮 SSE → (POST /api/chat/confirm) → 回填 tool_result → 续传 RUNNING → 最终答复 → done`

新增 SSE 事件：
```
confirmation_request  { sessionId, confirmId, toolName, operationType, title, summary, payload, severity }
confirmation_result   { sessionId, confirmId, approved, rejectedReason }
```

新增接口：
```
POST /api/chat/confirm  body { sessionId, confirmId, approved }
响应：新 SSE 流（confirmation_result → tool_call/tool_result → message_delta... → message_end → done）
```

实现要点：写工具在功能循环中、执行 executor 前被拦截；pendingConfirmation 存 assistant tool_call message + 工具名/args/toolCallId + expiresAt；confirm 校验后调 executeTool（真正落库）或构造取消结果，追加 tool 消息后继续循环。会话历史保留未完成的 assistant tool_call 消息作为恢复上下文。

### 鉴权透传
POST /api/chat 与 /api/chat/confirm 取 Bearer token → 调 Java GET /api/auth/me 校验并拿当前用户 → 绑定到底层；executeTool 每次透传 Bearer token 调 Java；写操作最终权限由 Java Service 判定（agent 不自行判角色）。

### RAG 知识库（重点）
- 文档 source of truth = Java 后端（KnowledgeDocument）；向量索引 = agent-server 内存
- embedding 时机 = 导入时离线 embed；查询时仅 embed query
- 避免重复构建 = contentHash 去重 + 文档级增量/删除级联 + `KNOWLEDGE_REBUILD_ON_START` 启动全量重建
- 结构：chunker（分块）→ embedding（/embeddings）→ vector-index（余弦 top-k）→ search_knowledge → 文本块注入 prompt

目录：agent-server/src/{ index.ts / agent-loop.ts / session-store.ts / tools/{definitions,executor}.ts / rag/{embedding,chunker,vector-index,knowledge-sync}.ts / auth.ts }

.env 关键变量：OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL(qwen-plus) / EMBEDDING_MODEL(text-embedding-v3) / PLATFORM_API_BASE(http://localhost:8080) / PORT=3002 / KNOWLEDGE_TOP_K / KNOWLEDGE_REBUILD_ON_START

## agent-sdk 扩展（React SDK）
组件：index / context.tsx（AgentProvider + getAuthHeaders + 事件分发）/ sse-client.ts（streamChat + confirmChat）/ FloatingAssistant（悬浮球+蓝点）/ ChatPanel / ConfirmDialog / types.ts

对外 API：
```tsx
<AgentProvider url={AGENT_SERVER_URL} getAuthHeaders={() => ({ Authorization: `Bearer ${token}` })}>
  <FloatingAssistant />
</AgentProvider>
```
context 值：open/close/toggle、sendMessage、sessions、unreadCount（蓝点）、pendingConfirmation、confirm(approved)

确认框：收到 confirmation_request → 置 pendingConfirmation → 渲染 ConfirmDialog（含 title/summary/payload，severity=DANGEROUS 红标）→ 确认/取消调 confirm；蓝点 = 面板关闭时新增事件计数（含 confirmation_request）。

## web 前端结构
```
web/src/ main.tsx / App.tsx（路由+登录守卫）/ constants.ts / api.ts（统一附 token）
 ├── auth/ AuthContext（token 存取、user、login/logout）
 ├── components/ Layout（侧边导航+顶栏，内嵌 FloatingAssistant）
 └── pages/ Login / Dashboard / Todo / Approval / Announcement / Directory / Knowledge
```
UI：白底浅蓝主题，无 emoji，注释中文 UTF-8。

## 端口与启动
| 服务 | 端口 | 启动 |
|---|---|---|
| java-backend | 8080 | mvn spring-boot:run |
| agent-server | 3002 | npm run dev -w agent-server |
| web | 5173 | npm run dev -w web（vite server.port 固定） |
| agent-sdk | 无 | 源码引用 |

根 package.json（workspaces: web/agent-server/agent-sdk）scripts：
```jsonc
"dev": "concurrently -n java,agent,web \"npm run dev:java\" \"npm run dev:agent\" \"npm run dev:web\"",
"dev:java": "cd java-backend && mvn spring-boot:run",
```
（Java 为 Maven、Node 为 npm，不能同进 workspace，用 concurrently 编排；启动说明并入本 plan，不单写 md）

## 实施步骤（依赖驱动）
1. 清空现有 food_shop 代码（保留 .git / .env 结构，重写四包）
2. java-backend：pom + 启动类 + common + store 种子数据 + entity + 鉴权 + 全部 Controller/Service；curl 验证登录/只读/写/权限
3. agent-server 只读链路：改写 tools 为 OA 只读工具 + 鉴权透传；跑通 SSE 全链路
4. agent-server 确认协议：requiresConfirmation 拦截 + 状态机 + /api/chat/confirm 续传
5. agent-sdk：getAuthHeaders + ConfirmDialog + 蓝点 + confirmChat
6. agent-server RAG：embedding/chunker/vector-index/knowledge-sync/search_knowledge + prompt 注入 + 写工具联动建删索引
7. web 前端：auth + Login + Layout + 6 页面 + SDK 接入
8. 根目录编排 + 联调 + 端到端验证

## 验证标准（跑通定义）
1. 编排启动 8080/3002/5173；无 token 调 /api/auth/me 返回 401
2. admin/123456 登录 → 进入工作台，数据来自 Java
3. 7 个页面渲染，数据与 Java 内存种子一致
4. 只读链路：带 token 问「我的待办有哪些」→ SSE 事件序列完整（session→message_start→tool_call→tool_result→message_delta...→message_end→done）
5. 鉴权：zhangwei（EMPLOYEE）问「帮我审批第一条申请」→ 返回 403 语义，不越权
6. 确认写闭环：admin 说「帮我新建待办：明天提交周报」→ confirmation_request → 确认框 → 点确认 → 真落库 → 待办页可见 → 流式答复
7. 取消写闭环：点取消 → 不落库 → LLM 答复「已取消」
8. 审批闭环：admin 发起报销 → 确认协议真正通过/驳回 → 状态变化
9. RAG：新增文档（如考勤制度）→ 提问命中并注入语义；重启后 KNOWLEDGE_REBUILD_ON_START 重建仍可检索
10. 硬约束：注释中文 UTF-8、无 emoji、白底浅蓝 UI、无测试脚本/额外 md

## 环境前置条件（执行时先校验）
- JDK 17+ 与 Maven（`java -version`、`mvn -v`），本机需确认已安装，缺则说明
- Node 需 v20（本机默认 v16，用 nvm 切换 `export PATH=/Users/test/.nvm/versions/node/v20.20.2/bin:$PATH`）
- 大模型/embedding 用阿里云百炼兼容协议（.env 配置，key 复用环境已有 DashScope key）