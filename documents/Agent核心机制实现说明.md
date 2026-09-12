# Agent 核心机制实现说明

本文档对应本项目（企业协同办公 AI Agent 助手平台）中的实现位置、机制细节与设计取舍

技术点清单与代码映射：

| 简历技术点               | 核心实现文件                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| 大模型 toolcall 多步推理循环 | agent-server/src/agent-loop.ts、tools/definitions.ts                        |
| SSE 流式对话            | agent-server/src/sse.ts、index.ts；agent-sdk/src/sse-client.ts               |
| 写操作二次确认协议           | agent-server/src/agent-loop.ts、session.ts、index.ts；agent-sdk ConfirmCard |
| 用户令牌透传权限校验          | agent-server/src/auth.ts、tools/executor.ts；backend/src/auth.ts             |
| RAG 检索增强            | agent-server/src/rag/（chunker / embedding / vector-index / knowledge-sync） |
| OpenAI 兼容协议         | agent-server/src/agent-loop.ts、rag/embedding.ts、config.ts                  |

***

## 1. 大模型 toolcall 多步推理循环

### 实现位置

[agent-loop.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/agent-loop.ts) 的 `runAgentLoop()`。

### 机制说明

经典 ReAct 风格循环：模型思考 → 输出 tool\_calls → 执行 → 结果回注会话历史 → 再次请求模型汇总，直到模型输出纯文本为止。

```typescript
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const messages = [{ role: 'system', content: buildSystemPrompt(session.user.name) }, ...history];
  const stream = await client.chat.completions.create({ model, messages, tools: TOOL_DEFINITIONS, stream: true });
  // ... 累积流式增量，组装 tool_calls
  if (toolCalls.length === 0) {
    history.push({ role: 'assistant', content });   // 纯文本回答：结束循环
    return;
  }
  // 有工具调用：执行 → history.push({ role: 'tool', ... }) → continue 进入下一轮
}
```

关键设计点：

1. **8 步熔断**：`MAX_ROUNDS = 8`（agent-loop.ts#L16），防止模型在多工具场景下陷入死循环，超限后以 error 事件优雅结束。
2. **单轮多工具串行调用**：模型一轮可返回多个 tool\_calls，逐个执行并把每个结果以 `role: 'tool'` 消息按 tool\_call\_id 对应追加进历史，再统一进入下一轮推理。
3. **流式 tool\_calls 分片组装**（手写 Agent 循环的真实难点）：OpenAI 兼容协议的流式响应中，tool\_calls 以分片下发——`arguments` 是逐 token 增长的 JSON 字符串片段，`id/name` 也只在首个分片出现。需要按下标累积拼接、流结束后再整体 `JSON.parse`（agent-loop.ts#L86-96）：

```typescript
if (delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    const idx = tc.index ?? 0;
    if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) toolCalls[idx].id = tc.id;
    if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
  }
}
```

1. **读写分流**：一轮中若既有只读又有写工具，先执行无副作用的只读工具，再拦截第一个写工具进入确认流程（agent-loop.ts#L149-153）。
2. **会话历史截断保护**：[session.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/session.ts) 的 `truncateIfNeeded()` 超过 40 条时从头截断，且保证截断点落在 user 消息之后——因为 OpenAI 协议要求 tool 消息必须紧跟对应的 assistant tool\_calls 消息，不能拆散。
3. **工具结果长度控制**：[executor.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/tools/executor.ts) 的 `stringifyToolResult()` 超过 16KB 截断，防止上下文膨胀。

### 工具定义（19 个）

[definitions.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/tools/definitions.ts)：11 个只读 + 8 个写操作，以 JSON Schema 声明参数约束（enum 约束状态/类型取值），description 中写明使用规则（如"需要审批 ID 时先用查询工具获取"），配合 [prompts.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/prompts.ts) 的 System Prompt 引导模型按业务意图与权限选工具。

***

## 2. SSE 流式对话

### 实现位置

- 服务端封装：[sse.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/sse.ts)、[index.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/index.ts) 的 `initSSE()`
- 客户端解析：[sse-client.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-sdk/src/sse-client.ts)

### 机制说明

**服务端**（index.ts#L27-35）：

```typescript
res.status(200).set({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',   // 关键：禁用 nginx 缓冲，保证事件实时下发
});
res.flushHeaders();
```

自定义 11 种事件类型（sse.ts#L4-17）：session / message\_start / message\_delta / message\_end / tool\_call / tool\_result / log / confirmation\_request / confirmation\_result / error / done。每个事件为单行 JSON，以 `data: {...}\n\n` 帧格式写出。

**客户端**（sse-client.ts#L44-70）：浏览器原生 EventSource 不支持 POST 和自定义请求头（鉴权需要），因此用 `fetch + ReadableStream` 手动实现 SSE 解析：

```typescript
const reader = res.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  buffer += decoder.decode(value, { stream: true });   // stream:true 处理多字节字符跨包
  while ((sep = buffer.indexOf('\n\n')) !== -1) {      // 空行分帧，一次可能读到多帧
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    // 解析 data: 行 → JSON.parse → 按 type 分发
  }
}
```

处理的边界情况：TCP 分包导致一帧被切开（用 buffer 累积 + 空行分隔符切帧）、多字节 UTF-8 字符跨包（`decode(value, { stream: true })`）、连接断开兜底（服务端 `writeSSE` 写之前检查 `writableEnded`，客户端断开后 `res.on('close')` 触发 `AbortController` 中断正在进行的 LLM 请求，index.ts#L74-77）。

**可观测性**：`log` 事件把服务端的逐步执行过程（第 N 步、做了什么、决策了什么工具、返回了什么）实时下发，前端 SDK 渲染为日志面板——这是把"Agent 黑盒"变成"白盒"的关键设计。

***

## 3. 写操作二次确认协议（Human-in-the-loop）

### 实现位置

- 状态机：[agent-loop.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/agent-loop.ts) `runAgentLoop()`（拦截）+ `resumeAfterConfirmation()`（续传）
- 待确认状态：[session.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/session.ts) `PendingConfirmation`
- 确认接口：[index.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/index.ts) `POST /api/chat/confirm`
- 前端确认卡片：[ConfirmCard.tsx](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-sdk/src/components/ConfirmCard.tsx)（内联于消息流）

### 机制说明

完整状态机：

```
推理循环中模型决策了写工具
  → 不执行，生成 PendingConfirmation { confirmId, toolName, args, toolCallId, step, title, summary, severity, expiresAt }
  → 发 confirmation_request 事件（含操作标题/摘要/参数/风险等级）→ 本轮 SSE 结束
  → 前端消息流推入确认卡片，用户在卡片上点「确认执行」或「取消」
  → POST /api/chat/confirm { sessionId, confirmId, approved }
  → 校验 pending 存在、confirmId 匹配、未过期（5 分钟 TTL）
  → 确认：executeTool 真正落库 / 取消：构造 { cancelled: true } 结果
  → 结果追加为 tool 消息（与之前未完成的 assistant tool_calls 对应）
  → 重新进入 runAgentLoop，模型基于执行结果产出最终答复
```

关键设计点：

1. **拦截点在执行前**：写工具在调用 executor 前被拦下，保证未确认前零副作用。
2. **会话历史的完整性**：拦截时 assistant 的 tool\_calls 消息已入历史，确认后补对应 tool 消息，消息序列始终满足 OpenAI 协议约束（assistant tool\_calls 后必须跟 tool 消息），因此可以无缝续跑主循环。
3. **操作摘要与风险分级**：[definitions.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/tools/definitions.ts) 的 `WRITE_TOOL_META` 为每个写工具声明展示标题、摘要字段和风险等级——如"驳回审批"为 high、"删除知识库文档"为 dangerous（前端红标警示）；`buildSummary()` 把参数拼成人类可读摘要（"类型： EXPENSE，标题： 差旅报销，金额： 1500"）。
4. **防重放/防过期**：confirmId 为一次性 UUID，消费即销毁；5 分钟 TTL 过期失效。

***

## 4. 用户令牌透传权限校验

### 实现位置

- agent-server 侧：[auth.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/auth.ts)、[executor.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/tools/executor.ts)
- 业务后端侧：backend/src/auth.ts（Bearer token 校验 + requireRole RBAC）

### 机制说明

链路：**前端 → agent-server → 业务后端**，全程透传同一个 Bearer token。

1. **入口校验**（index.ts#L39-48）：`/api/chat` 和 `/api/chat/confirm` 先从请求头提取 token，调业务后端 `GET /api/auth/me` 验证有效性并换取当前用户（userId/name/role），token 无效直接 401。
2. **绑定会话**：token 与用户存入 Session；确认接口收到请求时刷新 token（index.ts#L115），避免确认阶段用了过期 token。
3. **工具执行透传**（executor.ts#L79-87）：每个工具映射为一条业务后端 REST 路由（`TOOL_ROUTES`），执行时原样附带 `Authorization: Bearer <用户 token>`：

```typescript
const res = await fetch(config.platformApiBase + path, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
  body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
});
```

1. **权限判定后置**：agent-server 不自行判断角色，权限由业务后端的 `requireRole('ADMIN')` 中间件裁定。普通员工让助手"帮我通过这条审批"，后端返回 403，agent 把失败结果回注给模型，模型如实告知无权限——**AI 操作的权限边界与用户在页面上手工操作完全一致**，不存在"AI 特权通道"。

这个设计的价值：agent-server 保持无状态权限逻辑，权限模型只在业务后端维护一份；助手能力升级不需要同步改权限代码。

***

## 5. RAG 检索增强

### 实现位置

[rag/](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/rag/) 目录四个模块，全链路自研：

```
backend 知识库文档（source of truth）
  → chunker.ts      分块（段落优先，超长段落按句号/分号再切，单块 ≤500 字）
  → embedding.ts    向量化（text-embedding-v3，OpenAI 兼容 /embeddings 接口）
  → vector-index.ts 内存向量索引（余弦相似度 TopK 检索）
  → knowledge-sync.ts 同步策略（懒同步 + contentHash 增量）
  → search_knowledge 工具暴露给模型，检索结果注入会话历史
```

### 机制说明

1. **分块**（chunker.ts）：段落聚合切分，保证语义完整；超长段落按中文标点（。；！？）二次切分；`MAX_CHUNK_LEN = 500` 控制在 embedding 输入上限内。
2. **向量化**（embedding.ts）：复用同一 OpenAI 兼容客户端调 `/embeddings`，模型 text-embedding-v3。
3. **索引与检索**（vector-index.ts）：纯内存实现，检索时逐块算余弦相似度排序取 TopK（默认 `KNOWLEDGE_TOP_K = 4`）。
4. **增量同步**（knowledge-sync.ts，核心工程点）：
   - **懒同步**：不启动时全量构建（避免冷启动慢），首次检索前强制同步一次（`synced` 标记幂等）；
   - **文档级增量**：以正文 md5 作 contentHash，已建索引且内容未变的文档跳过向量化（`isFresh` 判断），变化的文档整块替换（`upsert`），后端已删除的文档级联移出索引；
   - **写操作联动**：`add_knowledge_document` / `delete_knowledge_document` 工具执行成功后调 `invalidateIndex()` 标记失效，下次检索前自动重同步（executor.ts#L96-98）——知识"即改即生效"。
5. **检索结果注入**：`search_knowledge` 是普通工具，命中文本块（含标题/分类/相似度分数）作为 tool 消息回注，模型基于真实文档内容作答，杜绝编造制度条文。System Prompt 规则 4 引导"制度、流程、FAQ 类问题优先检索知识库"。

***

## 6. OpenAI 兼容协议

### 实现位置

[config.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/config.ts)、[agent-loop.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/agent-loop.ts#L22-25)、[embedding.ts](file:///Users/test/Documents/trae_projects/food_shop_agent/agent-server/src/rag/embedding.ts)

### 机制说明

- 使用官方 `openai` SDK 但 `baseURL` 可配置，当前接阿里云百炼兼容模式端点（`https://dashscope.aliyuncs.com/compatible-mode/v1`），对话用 qwen-plus、向量化用 text-embedding-v3；
- 因为是标准兼容协议，改 `.env` 的 `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY` 即可切换 DeepSeek、智谱等任意兼容厂商，业务代码零改动；
- 深度使用了协议的进阶特性：`tools`（JSON Schema 函数声明）、流式增量中的 tool\_calls 分片、`tool_call_id` 消息关联、embeddings 接口。

#
