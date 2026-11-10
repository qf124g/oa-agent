# LLM 对话流程、工具调用与 Agent Loop 分析

本文按当前代码（`agent-server/src/agent-loop.ts`、`session.ts`、`index.ts`、`tools/executor.ts`、`tools/error-feedback.ts`、`tools/definitions.ts`）说明一次对话怎么跑、工具怎么挂上、失败后会不会自动重试、成功后会不会再打一遍，以及 loop 里已经存在的缺陷。

## 1. 一次对话怎么走

入口是 `POST /api/chat`（`agent-server/src/index.ts`）。

1. 从 `Authorization: Bearer` 取出 token，请求业务后端 `GET /api/auth/me`。无效则 401，不进模型。
2. 用 body 里的 `sessionId`（没有就新生成 UUID）取或创建内存会话。会话里有：`history`、当前 token、用户、待确认写操作 `pendingBatch`、失败签名表 `failedSigs`。
3. 把本条用户消息 `push` 进 `history`，然后进入 `runAgentLoop`。
4. 全程用 SSE 往外推事件。客户端断开时 `AbortController` 打断正在进行的模型流。
5. 无论正常结束、写操作挂起确认、还是抛错，`finally` 都会发 `done` 并结束响应。

循环本体在 `runAgentLoop`，上限 `MAX_ROUNDS = 8`。每一轮：

1. 组消息：一条当轮现拼的 system（含当前用户名、当天日期、技能清单）加上完整 `history`。system 不进历史，每轮重算。
2. 用 OpenAI 兼容客户端流式调用 `chat.completions.create`，带上全部 `TOOL_DEFINITIONS`，`stream: true`。没有 `tool_choice`，模型可以只回文本。
3. 流式分片里，`content` 立刻以 `message_delta` 推给前端；`tool_calls` 按 `index` 把 `id`、`name`、`arguments` 拼完整。`arguments` 是一段一段的 JSON 字符串，流结束才 `JSON.parse`。
4. 没有工具调用：把 assistant 文本写入历史，发 `message_end(stop)`，本轮用户请求结束。
5. 有工具调用：先把带 `tool_calls` 的 assistant 消息写入历史，再按只读 / 写入分流。只读执行完把 `role: tool` 结果按 `tool_call_id` 写回历史，`continue` 进入下一轮。出现写工具则停循环，等 `POST /api/chat/confirm`。
6. 八轮仍在调工具：发 error「工具调用轮次超过上限」，不再请求模型。

确认续跑是另一条入口 `resumeAfterConfirmation`：校验 `confirmId`、未过期（5 分钟）、从待确认队列移除后，同意才真正 `executeTool`，取消则回注 `{ cancelled: true }`。这一轮所有写操作都处理完，才按原始 `tool_call_id` 顺序补齐 tool 消息，再**重新调用** `runAgentLoop`。新的循环轮次从 1 再数到 8，不继承上一段已经用掉的步数。

消息顺序必须满足协议：assistant 的每个 `tool_call_id` 后面都要有对应 tool 消息，tool 消息不能被截断拆散。`truncateIfNeeded` 在历史超过 40 条时，从头部删到某个 user 消息为止，避免把 tool 消息留在开头。

## 2. 工具是怎么挂上的

工具不是运行时注册的插件，而是一份静态清单。

- 定义：`tools/definitions.ts` 的 `TOOL_DEFINITIONS`，随每次模型请求放进 `tools`。模型只看 name、description、JSON Schema。
- 写工具名单：`WRITE_TOOL_META`。`isWriteTool(name)` 为真的才会进人机确认。当前 8 个：`create_todo`、`complete_todo`、`create_approval`、`approve_approval`、`reject_approval`、`create_announcement`、`add_knowledge_document`、`delete_knowledge_document`。其余（含 `search_knowledge`、`use_skill`、`run_skill_script`）直接执行。
- 执行：`tools/executor.ts` 的 `executeTool`。
  - `search_knowledge`：本地改写 query、向量检索，不打业务后端。
  - `use_skill` / `run_skill_script`：读 `skills/` 下的 Markdown，或按白名单动态 import `scripts/*.mjs`。
  - 其余名字查 `TOOL_ROUTES`，映射成对 `PLATFORM_API_BASE`（默认 `http://localhost:8080`）的 GET/POST/PATCH/DELETE。请求带用户自己的 Bearer token，以及 `X-Source: agent`。超时 10 秒。
- 业务后端用 `code === 0` 当成功。写知识库成功后 `invalidateIndex()`，下次检索前重建向量索引。
- 权限不在 agent 里判断。后端 `requireRole('ADMIN')` 拒绝时，失败文本回注给模型。

同一轮里如果既有只读又有写：只读立刻执行并缓存结果，写工具逐个放进 `pendingBatch`，SSE 发 `confirmation_request` 后函数 return。用户要逐张确认。全部确认或取消之后，才按模型给出的原始顺序把 tool 消息一次补进历史。这样中途挂起时，历史里只有 assistant tool_calls、还没有 tool 消息，协议上是不完整的，必须等确认接口补齐后才能再请求模型。

## 3. 失败了会不会自动重试

**不会。** 代码里没有对模型请求、也没有对工具 HTTP 的自动重放、指数退避或次数重试。

失败后的实际行为分三层，名字容易看成「重试」，作用是拦住重复执行：

| 层 | 位置 | 失败时做什么 |
| --- | --- | --- |
| L0 | `error-feedback.ts` | 把后端中文错误改写成给模型看的 JSON：`NOT_FOUND` / `INVALID_PARAM` / `MISSING_PARAM` / `CONFLICT` / `FORBIDDEN` / `ALREADY_PROCESSED` / `SERVICE_UNAVAILABLE`，并写 hint（换工具、改枚举、不要原样再调）。这是提示，不是再发一次请求。 |
| L1 | `recordFailure` | 仅当 `executeTool` 返回 `ok: false` 时，把「工具名 + 参数键排序后的 JSON」记入 `session.failedSigs`，次数 +1。成功不记。 |
| L2 | `shortCircuitIfRepeated` | 同一签名失败次数 ≥ 1 时，**不再执行**。只读不打后端，写工具不弹确认框。返回一段 `DUPLICATE_CALL_BLOCKED`，要求模型三选一：改参数、换工具、或向用户说明。 |

因此：

- 第一次失败会真实打到后端（或本地检索），错误进历史，模型在**下一轮**自己决定要不要换参数再调。这是模型行为，不是框架重试。
- 同签名第二次起被短路，连一次补救重试都没有。
- 网络超时、连接失败走 `buildTransientError`。注释写「重试由框架退避策略负责」，仓库里没有这段退避。瞬时失败同样记入 `failedSigs`，后端恢复后，这个签名在会话存活期间一直被挡。
- `chat.completions.create` 抛错（断网、401、流中断且不是用户取消）由 `/api/chat` 的 catch 发一条 `error` 事件，不换模型、不重试。
- 参数 JSON 解析失败时 `parseArgs` 吞掉异常，变成 `{}` 继续执行，不会把「参数不是合法 JSON」回给模型。

## 4. 成功了会不会再调用一次

**会。** 成功路径没有任何去重。

- `failedSigs` 只在 `ok === false` 时增加。同样的只读工具、同样的参数，每一轮模型再要一次，就会再打一次后端。
- 同一轮 assistant 消息里如果有两个相同参数的 tool_call，两个都会执行（失败签名要等第一次返回 `ok: false` 才存在；两次都成功则两次都落地）。
- 写工具成功后也不记签名。模型下一轮可以再次发起同一个 `create_todo`，用户会再看到一张确认卡；两张都点确认，就会插入两条待办。没有幂等键。
- 同一次确认接口里，`confirmId` 从队列移除，不能用同一个 id 再确认一次。这只防「同一张卡片重放」，不防「模型重新发起一次新的写调用」。

只读重复的代价主要是多余请求和上下文变长（单条工具结果超过 16KB 会截断）。写操作重复会真实落库。

## 5. Agent loop 怎么实现的

实现是手写的 for 循环，不是第三方 agent 框架。

```
用户消息入 history
        │
        ▼
┌─ round = 1 .. 8 ─────────────────────────────┐
│  system + history  ──stream──►  模型           │
│       │                                          │
│       ├─ 无 tool_calls ──► 写入 assistant 文本，return │
│       │                                          │
│       └─ 有 tool_calls                           │
│            ├─ 全是只读：顺序执行，tool 消息入 history，continue │
│            └─ 含写工具：只读先执行并缓存；写工具入确认队列，return │
└──────────────────────────────────────────────┘
        │ 用户 POST /api/chat/confirm
        ▼
执行或取消该写操作；本批写操作都结束后补齐 tool 消息
再调用 runAgentLoop（轮次重新从 1 计）
```

和循环绑在一起的状态都在进程内存 `Map` 里（`session.ts` 的 `sessions`）。重启进程后会话、待确认、失败签名全部丢失。没有会话 TTL，Map 只增不删。

单轮多工具是串行 `await`，不是并行。写工具确认期间，这次 SSE 已经 `done`，前端靠下一笔 `/api/chat/confirm` 拿后续流。

## 6. 漏洞和实现缺陷

下面都是当前代码可以直接对上的问题，按对对话正确性和安全的影响排列。

### 6.1 只读短路把 tool 结果丢掉，下一轮请求会坏掉

全只读分支里，短路命中时直接 `continue`，返回的纠偏 JSON 没有写入 history：

```146:149:agent-server/src/agent-loop.ts
      for (const p of parsed) {
        if (shortCircuitIfRepeated(session, p.name, p.args, emit, round) !== null) continue;
        await runAndEmit(emit, session, p.call.id, p.name, p.args, round);
      }
```

assistant 消息里已经记下了这个 `tool_call_id`，却没有对应的 tool 消息。下一轮把这段 history 发给模型时，兼容接口会拒绝（tool 消息缺失）。用户看到的是「服务异常」，而不是 L2 想给模型的「禁止原样重试」说明。

含写工具的那条分支会把短路结果放进 `batch.results`，全部被短路时还会按顺序回填。两条路径行为不一致，只读路径是漏的。

同一轮里两个相同只读调用、第一个失败、第二个被短路时，同样会缺一条 tool 消息。

### 6.2 会话不校验所属用户

`getOrCreateSession` 只认 `sessionId`。已存在的会话会把 `token` 和 `user` 换成**当前请求**的身份。`/api/chat/confirm` 用 `getSession(sessionId)` 取会话，也不比较 `session.user.userId` 和当前登录用户。

知道别人的 `sessionId` 就可以：把消息写进对方历史、换成自己的 token 继续跑工具；如果还知道 `confirmId`，可以替对方确认或取消尚未过期的写操作。确认执行时用的是请求方刚写进会话的 token，所以落库身份会变成攻击者，同时对方的待确认状态被消费掉。`sessionId` 会随 SSE 下发，服务端日志也会打印 `session=` 和完整用户消息。

### 6.3 同一会话没有锁

`history` 和 `pendingBatch` 是共享可变对象，`/api/chat` 与 `/api/chat/confirm` 都没有互斥。

- 待确认还没补 tool 消息时，用户又发一条新的 `/api/chat`，会把 user 消息接在「只有 tool_calls、没有 tool 结果」的 assistant 后面，随后的模型请求不合法。`pendingBatch` 仍留在会话上，之后的确认还会把 tool 消息追加到错误的位置，并再开一个 loop。
- 同一批里两张确认卡几乎同时提交时，两个请求都可以在 `await executeTool` 处交错。两边都可能看到队列已空，各自把同一批 tool 消息再 push 一次，并各启动一个 `runAgentLoop`。写操作会执行两次，历史会出现重复的 tool 消息。

### 6.4 工具参数直接拼进 URL

`get_announcement_detail`、`get_employee_detail`、`complete_todo` 等把 `id` 拼进 path，没有 `encodeURIComponent`。`id` 里如果带有 `../` 或额外的 `/`，`fetch` 解析相对路径时可能离开 `/api/announcements/`、`/api/employees/`、`/api/todos/` 这些前缀，用当前用户 token 打到平台后端的其他路径。模型被提示词带偏、或参数来自不可信文本时，影响面是「这个用户 token 能访问的全部后端接口」，不只是该工具声明的那一个。

### 6.5 失败签名只增不减，和「请勿重试」的文案互相打架

`failedSigs` 跟随会话一直留着，没有过期、没有成功后清除。一次超时就会永久封掉该签名。注释承诺的框架重试不存在，模型被要求「不要原样重试」，框架也不会在服务恢复后补一次。结果是瞬时故障被当成永久失败。

### 6.6 其他边界

- 流式 `tool_calls` 用数组下标累积。若 `index` 不从 0 连续出现，数组会出现空洞，后面的 `for...of` 会拿到空元素并抛错，这一轮已输出的半截文本无法收成合法历史。
- 不检查 HTTP 状态与 `res.ok`。只要响应体能解析成 `{ code: 0 }` 就当成功。
- `internalSecret` 默认 `dev-internal-secret`。未改环境变量时，任何人能访问 agent 端口就可以向 `/internal/events` 投递领域事件。
- `cors()` 未限制来源。token 放在浏览器本地存储时，页面上的 XSS 可以直接代用户调 `/api/chat`。
- 确认续跑会把 8 轮预算清零。只读循环有上限；若用户连续确认，写操作链路可以一轮接一轮继续打模型，没有跨确认的总步数上限。
- 会话 Map 无淘汰。长跑进程里历史、失败签名、待确认对象会一直占用内存。

技能脚本有目录白名单（技能 id、脚本名只允许安全字符，且必须是 `skills/<id>/scripts/*.mjs`），这条本身不是任意路径执行。风险在于脚本一旦被放进仓库就会被模型调用，执行身份是 agent 进程。

## 7. 和注释不一致的地方

读代码时以行为为准，不要以注释为准：

- `error-feedback.ts` 写瞬时故障「由框架退避策略负责」。没有退避，也没有第二次 HTTP。
- 只读分支注释写「同签名重试由 L2 短路」。短路判断有，但短路结果没有回填历史，保护没有闭环。
- `definitions.ts` 文件头写 `requiresConfirmation=true`。实际没有这个字段，是否确认只看工具名是否出现在 `WRITE_TOOL_META`。
