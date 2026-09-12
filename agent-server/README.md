# agent-server - Agent 服务

本项目核心。独立的 Node.js（Express + TypeScript）服务，向上对接 OpenAI 兼容大模型，向下以用户身份调用业务后端 API，向前端提供 SSE 流式对话协议。端口 3002。

## 运行原理

```
用户消息
  → 组装会话历史 + System Prompt + 19 个工具定义
  → 调用大模型（流式）
  ├─ 纯文本回复        → message_delta 流式下发 → done
  ├─ 只读工具调用       → 透传 token 调业务后端 → 结果回注模型 → 进入下一轮（最多 8 轮熔断）
  └─ 写操作工具调用     → 拦截，生成 confirmation_request（操作摘要 + 风险等级）
                          → 用户确认后 POST /api/chat/confirm 续传执行
```

关键实现：

- **toolcall 多步推理循环**（[src/agent-loop.ts](./src/agent-loop.ts)）：模型思考 → 工具决策 → 执行 → 结果回注 → 汇总回复；单轮多工具串行调用，8 步熔断防失控
- **流式 tool_calls 分片组装**：流式响应中工具参数为增量字符串，按 index 累积拼接后统一解析
- **读写分流**（Human-in-the-loop）：只读工具直接执行，写操作（新建待办/审批/公告等）自动拦截为确认请求
- **令牌透传**：`Authorization: Bearer` 由前端 → agent-server → 业务后端全链路透传，工具执行按用户角色完成接口级 RBAC 校验，AI 操作不越权
- **RAG 知识增强**（[src/rag/](./src/rag/)）：文档分块 → Embedding 向量化 → 内存向量索引（按内容 hash 增量更新）→ 余弦相似度 TopK 检索 → 上下文注入；`search_knowledge` 工具供模型主动检索

## 业务工具（19 个）

只读（11）：get_workbench_stats、get_my_todos、get_my_approvals、get_pending_approvals、list_announcements、get_announcement_detail、list_departments、list_employees、get_employee_detail、list_knowledge_documents、search_knowledge

写操作（8，均需用户确认）：create_todo、complete_todo、create_approval、approve_approval、reject_approval、create_announcement、add_knowledge_document、delete_knowledge_document

工具定义见 [src/tools/definitions.ts](./src/tools/definitions.ts)（JSON Schema 参数约束），执行器见 [src/tools/executor.ts](./src/tools/executor.ts)。

## SSE 事件协议（11 种）

| 事件 | 说明 |
|---|---|
| session | 会话 ID 下发 |
| message_start / message_delta / message_end | 助手回复流式输出 |
| tool_call / tool_result | 工具调决策与执行结果 |
| log | 逐步骤执行日志（第 N 步、标题、详情、原始数据），前端日志面板展示 |
| confirmation_request / confirmation_result | 写操作确认请求与结果 |
| error / done | 错误与结束 |

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查 |
| POST | /api/chat | 发起对话（SSE 流式返回） |
| POST | /api/chat/confirm | 写操作确认/取消后续传（SSE 流式返回） |
| GET | /api/agent/events | 助手主动推送通道（常驻 SSE，Bearer 鉴权，心跳保活，离线消息补发） |
| POST | /internal/events | 领域事件上报（backend 内部回调，X-Internal-Secret 共享密钥鉴权） |

## 配置

复制 `.env.example` 为 `.env`：

| 变量 | 默认 | 说明 |
|---|---|---|
| OPENAI_BASE_URL | 阿里云百炼兼容模式端点 | OpenAI 兼容协议，可切换智谱/DeepSeek 等 |
| OPENAI_API_KEY | - | 必填，大模型密钥 |
| OPENAI_MODEL | qwen-plus | 对话模型 |
| EMBEDDING_MODEL | text-embedding-v3 | RAG 向量化模型 |
| PORT | 3002 | 服务端口 |
| PLATFORM_API_BASE | http://localhost:8080 | 业务后端地址 |
| KNOWLEDGE_TOP_K | 4 | RAG 检索返回文本块数量 |

## 脚本

```bash
npm run dev -w agent-server     # 开发模式（tsx watch）
npm run start -w agent-server   # 生产模式
```
