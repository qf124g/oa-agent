# LLM 调用关键步骤说明

本文档从 [agent-loop.ts](../agent-server/src/agent-loop.ts) 中提取调用大模型的关键步骤，聚焦「请求 → 流式响应 → 工具调用 → 结果回传」这条主链路，省略日志输出、事件推送等辅助逻辑，方便理解 OpenAI 兼容协议下 Agent 的实际运行过程。

## 整体循环结构

```
用户提问
  │
  ▼
┌─────────────────────────────────────────┐
│ 第 N 轮（最多 8 轮，防死循环）              │
│  1. 组装 messages（system + history）     │
│  2. 携带 tools 定义，流式请求大模型         │
│  3. 累积流式分片：content / tool_calls     │
│  4. 分流：                                 │
│     - 无 tool_calls → 纯文本，结束          │
│     - 有 tool_calls → 执行工具，结果回传     │
│       history，进入下一轮                  │
└─────────────────────────────────────────┘
```

## 关键步骤 1：组装请求并流式调用

每轮循环都携带**完整会话历史 + 工具定义**发起请求（[agent-loop.ts#L54-L75](../agent-server/src/agent-loop.ts#L54-L75)）：

```ts
const messages: ChatCompletionMessageParam[] = [
  { role: 'system', content: buildSystemPrompt(session.user.name) },
  ...history,   // 历史消息：user / assistant / tool 三种角色
];

const stream = await client.chat.completions.create(
  {
    model: config.openaiModel,
    messages,
    tools: TOOL_DEFINITIONS,   // 19 个工具的 JSON Schema 定义
    stream: true,
  },
  { signal }
);
```

工具定义形如（模型据此决定是否调用、如何填参）：

```json
{
  "type": "function",
  "function": {
    "name": "get_my_todos",
    "description": "查询待办任务列表，支持按归属人、状态筛选...",
    "parameters": {
      "type": "object",
      "properties": {
        "status": { "type": "string", "enum": ["PENDING", "DONE"] },
        "page": { "type": "number" }
      },
      "required": []
    }
  }
}
```

## 关键步骤 2：累积流式分片

流式返回中，`content` 和 `tool_calls` 都是**分片下发**的。文本直接转发前端；`tool_calls` 的 `arguments` 是分片字符串，必须按 `index` 拼接完整后才能 JSON.parse（[agent-loop.ts#L82-L100](../agent-server/src/agent-loop.ts#L82-L100)）：

```ts
let content = '';
const toolCalls: ToolCallAccum[] = [];

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (!delta) continue;

  // 文本增量：实时下发前端渲染
  if (delta.content) {
    content += delta.content;
    emit({ type: 'message_delta', content: delta.content });
  }

  // 工具调用增量：按 index 累积 id / name / arguments 分片
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!toolCalls[idx]) {
        toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }
      if (tc.id) toolCalls[idx].id = tc.id;
      if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
      if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
    }
  }
}
```

## 关键步骤 3：分流——纯文本结束 / 工具调用继续

**分支 A：无 tool_calls，纯文本回答，写入历史并结束**（[agent-loop.ts#L110-L115](../agent-server/src/agent-loop.ts#L110-L115)）：

```ts
if (toolCalls.length === 0) {
  history.push({ role: 'assistant', content });
  emit({ type: 'message_end', finishReason: 'stop' });
  return;
}
```

**分支 B：有 tool_calls，先把 assistant 消息（含 tool_calls）写入历史**——这是 OpenAI 协议的硬性要求，后续每个 `tool_call_id` 都必须有对应的 `tool` 消息回填（[agent-loop.ts#L117-L123](../agent-server/src/agent-loop.ts#L117-L123)）：

```ts
const assistantMsg: ChatCompletionMessageParam = {
  role: 'assistant',
  content: content || null,
  tool_calls: toolCalls,   // [{ id, type: 'function', function: { name, arguments } }]
};
history.push(assistantMsg);
```

此时会话历史中的消息序列为：

```json
{ "role": "assistant", "content": null, "tool_calls": [
    { "id": "call_abc123", "type": "function",
      "function": { "name": "get_my_todos", "arguments": "{\"status\":\"PENDING\"}" } }
] }
```

## 关键步骤 4：执行工具并回传结果

工具按读/写分流：

- **只读工具**：直接执行（HTTP 调业务后端 / 本地向量检索），结果**立即写入历史**，进入下一轮循环（[agent-loop.ts#L144-L150](../agent-server/src/agent-loop.ts#L144-L150)、[L304-L318](../agent-server/src/agent-loop.ts#L304-L318)）：

```ts
// 全部只读：顺序执行后进入下一轮
for (const p of parsed) {
  await runAndEmit(emit, session, p.call.id, p.name, p.args, round);
}
continue;

// runAndEmit 内部：执行工具 → 结果写入历史
const content = await executeToolAndEmit(...);   // 实际执行（HTTP 调后端）
session.history.push({
  role: 'tool',
  tool_call_id: toolCallId,   // 必须与 assistant 消息里的 tool_calls.id 对应
  content,                     // 序列化后的工具返回
});
```

回传后历史序列变为（下一轮请求会带上）：

```json
{ "role": "assistant", "tool_calls": [{ "id": "call_abc123", ... }] },
{ "role": "tool", "tool_call_id": "call_abc123",
  "content": "{\"ok\":true,\"data\":{\"list\":[...],\"total\":3}}" }
```

- **写工具**：不直接执行，生成确认卡片（含摘要与风险等级）推给前端，本轮挂起等待用户确认（[agent-loop.ts#L152-L202](../agent-server/src/agent-loop.ts#L152-L202)）。

## 关键步骤 5：写工具确认后的回填与续跑

用户确认/取消后（[agent-loop.ts#L246-L278](../agent-server/src/agent-loop.ts#L246-L278)）：

```ts
// 确认 → 真正执行；取消 → 构造取消结果（同样要回填，协议要求一个不能少）
if (approved) {
  const executed = await executeTool(pending.toolName, pending.args, ...);
  result = executed.result;
} else {
  result = { cancelled: true, message: '用户已取消该操作' };
}
batch.results[pending.toolCallId] = stringifyToolResult(result);

// 本轮还有未确认的写操作 → 等待，暂不回填
if (batch.pending.length > 0) return;

// 全部处理完：按 tool_calls 原始顺序回填 tool 消息，再续跑主循环
for (const toolCallId of batch.toolCallIds) {
  session.history.push({ role: 'tool', tool_call_id: toolCallId, content: batch.results[toolCallId] });
}
await runAgentLoop({ emit, session, sessionId, signal });
```

## 完整时序示例

用户说「帮我查一下待处理的待办」，实际发生的 LLM 调用过程：

```
第 1 轮请求：
  messages = [system, user("帮我查一下待处理的待办")]
  tools    = [19 个工具定义]

第 1 轮响应（流式分片累积后）：
  tool_calls = [{ id: "call_abc123", name: "get_my_todos",
                  arguments: "{\"status\":\"PENDING\"}" }]

  → history 追加 assistant 消息（含 tool_calls）
  → 执行 get_my_todos（GET /api/todos?status=PENDING，透传用户 token）
  → history 追加 tool 消息（tool_call_id = call_abc123，content = 查询结果）

第 2 轮请求：
  messages = [system, user, assistant(tool_calls), tool(结果)]

第 2 轮响应：
  纯文本："您当前有 3 条待处理的待办：1. ... 2. ... 3. ..."

  → history 追加 assistant 消息，循环结束
```

## 关键设计点

| 设计点 | 说明 |
|---|---|
| 每轮全量携带历史 | OpenAI 协议无状态，上下文靠 messages 数组传递 |
| tool_calls 分片拼接 | 流式下 arguments 是分片字符串，拼接完整后才能 JSON.parse |
| assistant(tool_calls) 必须先入历史 | 否则后续 tool 消息没有对应的 tool_call_id，协议报错 |
| 每个 tool_call_id 必须有 tool 消息 | 一轮多工具时一个不能少，取消的写操作也要回填取消结果 |
| 写工具延迟回填 | 等本轮全部写操作确认完，按原始顺序批量回填，再续跑循环 |
| 8 轮熔断 | 防止模型陷入工具调用死循环 |
