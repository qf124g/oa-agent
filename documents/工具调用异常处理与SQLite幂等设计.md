# 工具调用异常处理与 SQLite 幂等设计

> 本文档说明三件事：
> 1. SQLite 数据库如何设计、幂等键如何落地；
> 2. agent-loop 对工具调用的各类异常（超时、失败重试、参数错误、确认过期、并发等）如何分级处理；
> 3. 异常状态如何与数据库联动，保证「同一笔写」在超时/重试/重启等场景下不会重复落库。
>
> 配套代码：
> - 后端存储与幂等：`backend/src/store.ts`、`backend/src/index.ts`
> - 工具执行与错误反馈：`agent-server/src/tools/executor.ts`、`agent-server/src/tools/error-feedback.ts`
> - Agent 循环：`agent-server/src/agent-loop.ts`、`agent-server/src/session.ts`

---

## 1. 核心结论（先看这个）

- 「超时」≠「写失败」：后端可能已成功落库，只是响应没回来。
- 解决思路是**幂等键**：让后端能识别「这是同一笔写」，配合「同 key 有限重试」做到 **exactly-once**。
- 幂等键的生命周期：**在写操作进入确认队列时生成**（`confirmId = randomUUID()`），确认执行、超时重试全程复用同一个值。
- 幂等键状态**持久化在 SQLite**（`idempotency` 表），与业务数据同库同事务，重启不丢。
- agent 侧还有两层**内存态护栏**（`failedSigs` / `succeededSigs`），它们是「模型行为矫正」，不是 exactly-once 保证，因此不需要落库（详见第 5 节）。

---

## 2. SQLite 数据库设计

### 2.1 存储模型

后端原来用「内存 Map + JSON 文件快照」存数据，无法做到「幂等检查 + 写 + 记结果」的原子性。现迁移为 SQLite，**每张实体表一行存一条实体，`data` 列存整条实体的 JSON 文本**（文档型存储，避免逐字段建列）。

### 2.2 表结构

| 表 | 用途 | 关键列 |
|---|---|---|
| `departments` / `employees` / `todos` / `approvals` / `announcements` / `knowledge_docs` / `workflows` | 七类业务实体 | `id TEXT PRIMARY KEY`、`data TEXT NOT NULL`（实体 JSON） |
| `meta` | 键值元数据 | `key TEXT PRIMARY KEY`、`value TEXT NOT NULL`（存 `id_seq` 自增序列） |
| `idempotency` | 幂等记录 | `key TEXT PRIMARY KEY`、`result TEXT NOT NULL`、`created_at`、`updated_at` |

```sql
CREATE TABLE IF NOT EXISTS "todos" (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 2.3 实体访问层 `Collection`

`backend/src/store.ts` 里的 `Collection<V>` 对业务层暴露 **Map 风格接口**（`get` / `set` / `delete` / `has` / `values` / `size`），底层是一条 SQL：

- `get(id)` → `SELECT data FROM "t" WHERE id = ?`，`JSON.parse`
- `set(id, v)` → `INSERT ... ON CONFLICT(id) DO UPDATE SET data = excluded.data`（插入或整条覆盖）
- `values()` → `SELECT data` 后逐个 `JSON.parse`

这样路由层里原有的 `store.todos.values()`、`store.todos.get(id)`、`store.todos.set(id, t)` 等写法几乎不用变，只是把落盘从 JSON 文件换成了 SQLite。

### 2.4 自增 id 生成 `nextId`

`nextId(prefix)` 用**单条原子 UPDATE** 实现，可在幂等事务内部安全调用（不嵌套事务）：

```ts
nextId(prefix: string): string {
  const row = this.db
    .prepare(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'id_seq' RETURNING value`)
    .get() as { value: string } | undefined;
  const seq = Number(row?.value ?? 1);
  return prefix + String(seq).padStart(3, '0');
}
```

### 2.5 迁移与 seed

- 首次启动（`store.db` 不存在）时，尝试从旧 `backend/data/store.json` **迁移**（读取快照，逐表写入）；文件不存在或损坏则**seed** 演示数据。
- 迁移/seed 后调用 `syncIdSeq()`，把 `id_seq` 提升到所有实体编号最大值之上，避免与外部注入的固定 id（如知识库 seed 的 `K001`）冲突。

---

## 3. 幂等机制设计

### 3.1 幂等键何时生成

幂等键就是写操作确认卡的 `confirmId`，**在写工具被放入待确认队列的那一刻生成**（`agent-loop.ts` 的 `resumeAfterConfirmationInner` 上游）：

```ts
const pending: PendingConfirmation = {
  confirmId: randomUUID(),   // ← 幂等键在这里生成
  toolName: p.name,
  args,
  // ...
};
```

选择 `confirmId` 而非「工具名 + 参数」的理由：`confirmId` 是每次「确认卡片」唯一、一次性消费的 ID，天然稳定且与参数无关；同一张卡片的多次执行/重试共享同一个值，正好匹配幂等键的语义。

### 3.2 幂等键传递链路

```
agent-loop.ts                      executor.ts                       backend
  confirmId (randomUUID)
     │
     ▼
executeToolSafely(..., pending.confirmId)  →  executeTool(ctx.idempotencyKey)
                                                     │
                                                     ▼
                                    headers['Idempotency-Key'] = ctx.idempotencyKey
                                                     │
                                                     ▼
                                  backend 写路由: idempotencyKey(req) 读头
                                                     │
                                                     ▼
                                  store.runIdempotent(key, () => { 写入并返回实体 })
```

### 3.3 后端 `runIdempotent` 事务语义

```ts
runIdempotent<T>(key: string | undefined, write: () => T): { result: T; replayed: boolean } {
  if (!key) return { result: write(), replayed: false };
  const tx = this.db.transaction((k) => {
    const existing = /* SELECT result FROM idempotency WHERE key = k */;
    if (existing) return { result: JSON.parse(existing.result), replayed: true }; // 命中：回放缓存
    const result = write();                    // 未命中：真正执行写入（含 nextId + 业务 set）
    /* INSERT INTO idempotency(key, result, ...) */
    return { result, replayed: false };
  });
  return tx(key);
}
```

关键点：

1. **幂等检查 + 业务写入 + 记录结果在同一个 SQLite 事务里**，要么全部成功、要么全部回滚。
2. `write()` 抛错（如业务 404/403）时，事务回滚，**不写入幂等记录**，异常向上传播 → 路由返回错误。幂等记录**只缓存成功的写**。
3. 命中缓存返回 `replayed: true`，路由据此**跳过领域事件推送**，避免「回放请求」重复通知。

### 3.4 超时后的正确动作：同 key 重试

`executor.ts` 对写工具（带幂等键）在网络/超时故障时**按同一 key 有限重试**：

```ts
const isWrite = method !== 'GET';
const maxAttempts = isWrite && ctx.idempotencyKey ? 3 : 1;   // 只读不重试，写最多 3 次
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  try {
    // ... fetch（带 Idempotency-Key），10s 超时
    // 拿到响应后 return
  } catch (err) {
    if (attempt === maxAttempts - 1) return { ok: false, result: buildTransientError(name, err) };
    await sleep(300 * (attempt + 1));   // 300ms / 600ms 退避后重试
  }
}
```

重试安全性的来源：**重试请求携带同一个 `Idempotency-Key`**，后端按 key 去重：

- 若第一次其实已成功（响应丢失）→ 重试命中缓存，拿到首次结果，不重复落库。
- 若第一次根本没到达后端 → 重试真正执行，只落一次。

---

## 4. agent-loop 工具调用异常处理全景

错误处理分为三层（命名沿用代码注释 L0/L1/L2）：

| 层级 | 位置 | 职责 |
|---|---|---|
| **L0 结构化错误反馈** | `error-feedback.ts` | 把后端面向人的文案转成写给模型的「修复指令」，打破同参重试死循环 |
| **L1 失败登记** | `agent-loop.ts` 的 `recordFailure` + `session.failedSigs` | 累计「工具名+参数签名」的失败次数 |
| **L2 同签名短路** | `agent-loop.ts` 的 `shortCircuitIfRepeated` | 同签名已失败过 → 直接拦截，不执行、不弹确认 |

### 4.1 调用签名 `signatureOf`

```ts
signatureOf(name, args) = `${name}:${JSON.stringify(args, Object.keys(args).sort())}`
```

即「工具名 + 参数（key 排序后序列化）」，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 同签名。`failedSigs` / `succeededSigs` 都以它为键。

### 4.2 各类异常与处理对照表

| 异常类型 | 触发点 | 处理 | 结果 |
|---|---|---|---|
| 模型调用失败 | `chat.completions.create` 抛错 | emit `error` + `message_end`，return | 不产生悬空工具调用 |
| 流式中断 | 遍历 stream 抛错 | 回滚未完成 tool_calls，补 `message_end` | 不产生悬空 assistant(tool_calls) |
| 纯文本回复 | `toolCalls.length === 0` | push assistant（空 content 给占位文本） | 结束本轮 |
| 参数 JSON 解析失败 | `parseArgs` 返回 `ok:false` | `invalidArgsToolResult` 回注 + `recordFailure` | 不执行、不弹确认 |
| 只读工具执行失败 | `executeToolSafely` 返回 `ok:false` | `recordFailure`（除非 aborted） | 结果回注模型 |
| 写工具同签名已失败 | `shortCircuitIfRepeated`（L2） | 短路，返回 `DUPLICATE_CALL_BLOCKED` | 不执行、不弹确认 |
| 写工具同签名已成功 | `isAlreadySucceeded` | 跳过，返回 `DUPLICATE_WRITE_SKIPPED` | 不重复弹确认/不重复写 |
| 确认请求过期 | `pending.expiresAt < now` | 移除 + 回填「未执行」+ 批次空则续跑 | 不卡死 pendingBatch |
| 确认请求重放 | `confirmId` 找不到 | emit error，return | 一次性消费防重放 |
| 网络/超时（写） | fetch 抛错 | 同 key 重试最多 3 次，仍败 → `SERVICE_UNAVAILABLE` | 配合幂等不重复落库 |
| 网络/超时（读） | fetch 抛错 | 不重试 → `SERVICE_UNAVAILABLE` | 直接告知 |
| 业务错误（`code !== 0`） | 后端返回非 0 | `buildErrorFeedback`（L0）分类回注 | 见 4.3 |
| 响应体异常 | `res.json()` 为 null | `buildMalformedResponseError` | `SERVICE_UNAVAILABLE` |
| 未知工具 | 无对应 route | `UNKNOWN_TOOL` | 提示换正确工具名 |
| 用户取消 / 请求取消 | AbortSignal / 用户拒绝 | 返回 cancelled，**不登记失败** | 不算工具失败 |

### 4.3 L0 业务错误分类（`buildErrorFeedback`）

按后端错误文案的关键词，把错误转成结构化对象，其中带 `hint` 引导模型下一步：

| 关键词 | 分类 | 引导 |
|---|---|---|
| `不存在` | `NOT_FOUND` | 指出 received 的 ID，引导先调查询工具（如 `get_my_todos`）拿真实 ID |
| `不正确` | `INVALID_PARAM` | 给出合法枚举 + 最可能的 `suggestion` |
| `不能为空` | `MISSING_PARAM` | 补全必填参数后重试 |
| `已存在` | `CONFLICT` | 换新值，不要原样重试 |
| `无权限` | `FORBIDDEN` | 权限问题非参数问题，改向用户说明 |
| `已处理` | `ALREADY_PROCESSED` | 状态已变更，重新查询最新状态 |

---

## 5. 异常状态与数据库的联动

三者的协作关系：

```
                      ┌────────────────────────────────────────────┐
                      │  后端 SQLite（持久，跨重启）                  │
                      │  - idempotency 表：幂等键 → 首次执行结果      │
                      │  - 业务表：最终写入的数据                    │
                      │  - 二者同事务                                 │
                      └────────────────────────────────────────────┘
                                    ▲ 写 + Idempotency-Key
                                    │
  ┌──────────────────────────────────────────────────────────────┐
  │  agent-server（内存，会话级）                                  │
  │  - confirmId：幂等键，确认时生成，随写请求透传                 │
  │  - failedSigs：同签名失败计数（防重试死循环）                  │
  │  - succeededSigs：同签名成功集合（防重复弹确认/重复写）        │
  └──────────────────────────────────────────────────────────────┘
```

**为什么 `failedSigs` / `succeededSigs` 不需要落库？**

它们挂在 `Session` 上，而 `Session`（连同 `history`、`pendingBatch`）本身是纯内存 `Map`（`session.ts`）。进程一重启，整个会话上下文（对话历史、待确认队列）全丢，模型根本不知道之前做过什么。所以：

- 单独持久化这两个签名没有意义——会话都丢了，签名留着也无上下文可匹配。
- 真正需要落库的 exactly-once 保证，已由后端的 `idempotency` 表承担。

---

## 6. 反面案例（带消息序列）

下面用「若不加防护会怎样 → 实际如何被挡住」的方式，逐个说明关键异常场景。

> 记法说明：
> - `SSE>` 表示下发给前端的 SSE 事件；
> - `history[...]` 表示写入会话历史的消息（system/user/assistant/tool）；
> - 消息序列中省略了无关的 `log` 事件，保留关键决策点。

---

### 案例 1：超时但后端已写成功（本设计的核心场景）

**若不防护**：`create_todo` 后端已 `INSERT` 成功，但响应在 10s 超时后丢失。agent 误判失败并告诉模型「别重试」，用户端却已出现一条「幽灵待办」；若模型/用户再重试，则重复创建。

**实际处理**（超时 → 同 key 重试 → 命中缓存）：

```
1. 用户:「帮我建一条『买牛奶』的待办」
2. 模型返回 tool_calls: [create_todo(title=买牛奶)]
3. agent-loop 生成确认卡 confirmId = 3f2a…（幂等键在此生成）
   SSE> confirmation_request { confirmId: 3f2a…, toolName: create_todo }
4. 用户点击「确认」
5. agent-loop: executeToolSafely(..., idempotencyKey = 3f2a…)
6. executor: POST /api/todos, headers: { Idempotency-Key: 3f2a… }
7. 后端 runIdempotent(3f2a…):
     - 查 idempotency 表：无 → 事务内 INSERT todos(T005) + INSERT idempotency(3f2a…)
     - 提交成功，但响应在网络上丢失
8. executor: fetch 抛 TimeoutError（10s 到）
9. executor: 非最后一次 → 退避 300ms，用同一个 Idempotency-Key: 3f2a… 重试
10. 后端 runIdempotent(3f2a…):
      - 查 idempotency 表：命中 → 直接返回缓存的 T005（replayed=true）
11. executor 拿到 code=0 + data=T005，返回 ok=true
12. agent-loop: markSucceeded(create_todo, {title:买牛奶})
    SSE> tool_result { ok:true, result: T005 }
```

结果：**只落库一条 T005**，模型与用户都看到成功。

---

### 案例 2：重试到上限仍失败（后端完全不可达）

**若不防护**：无限重试或无限等待。

**实际处理**（3 次后放弃，转成 `SERVICE_UNAVAILABLE`）：

```
1. 写操作确认后执行，fetch 连续 3 次都抛错（第一次执行 + 300ms/600ms 两次退避重试）
2. 第 3 次仍是最后一次 → return { ok:false, result: buildTransientError }
   result = { error: 'SERVICE_UNAVAILABLE', hint: '...瞬时故障而非参数问题，请勿原样重试...' }
3. agent-loop: recordFailure(create_todo, args)  → failedSigs[签名] = 1
4. SSE> tool_result { ok:false, result: SERVICE_UNAVAILABLE }
5. 模型看到 hint 后，不再原样重试，改为向用户说明「服务暂不可用」
```

结果：不落库、不重复，模型被引导停止盲试。

---

### 案例 3：模型同参重试死循环（L2 短路）

**若不防护**：模型参数不变反复调 `create_approval(type=请假)`，后端每次都报「type 不正确」，死循环直到 `MAX_ROUNDS`。

**实际处理**（第一次失败登记，第二次起短路）：

```
第 1 轮：
  模型调用 create_approval(type=请假)
  后端返回 code!=0，message="审批类型不正确"
  executor: buildErrorFeedback → INVALID_PARAM { suggestion: 'LEAVE' }
  agent-loop: recordFailure → failedSigs['create_approval:{type:请假}'] = 1
第 2 轮：
  模型仍调 create_approval(type=请假)（原样重试）
  agent-loop: shortCircuitIfRepeated → failedTimes=1 ≥ 1 → 短路
  SSE> tool_result { error:'DUPLICATE_CALL_BLOCKED', required_action:'禁止原样重试…' }
  该调用不执行、也不弹确认
```

结果：循环被打破，模型被强制三选一（改参数 / 换工具 / 向用户说明）。

---

### 案例 4：模型新一轮重复发起已成功的写（succeededSigs）

**若不防护**：第一轮已成功 `create_todo(买牛奶)`，模型在后续轮又原样发起，会生成**新的 confirmId**（新幂等键）→ 后端重复落库。

**实际处理**（同签名已成功 → 跳过）：

```
第 1 轮：
  create_todo(title=买牛奶) 经确认执行成功
  agent-loop: markSucceeded → succeededSigs.add('create_todo:{title:买牛奶}')
第 3 轮：
  模型又调用 create_todo(title=买牛奶)
  agent-loop: isAlreadySucceeded → true
  SSE> tool_result { skipped:true, reason:'DUPLICATE_WRITE_SKIPPED', detail:'...未重复执行...' }
  不弹确认、不发后端请求
```

结果：不重复落库、不骚扰用户。注意：这是**会话内**护栏，跨重启不生效（见第 5 节）。

---

### 案例 5：参数 JSON 解析失败

**若不防护**：拿空参执行或静默降级，导致误写。

**实际处理**（显式失败 + 登记）：

```
1. 模型返回 tool_calls 中 arguments = "{title: 漏了引号}"
2. parseArgs → JSON.parse 抛错 → { ok:false, error:'...' }
3. agent-loop: invalidArgsToolResult(create_todo, error)  → INVALID_ARGUMENTS
   recordFailure(create_todo, {__raw__: 原文})
   SSE> tool_result { error:'INVALID_ARGUMENTS', required_action:'禁止用相同原始参数重试…' }
4. 该写操作不入确认队列，直接回填结果，续跑
```

结果：不执行、不弹确认，模型被要求修正 JSON。

---

### 案例 6：确认请求过期（5 分钟未确认）

**若不防护**：`pendingBatch` 永久残留，下一次 `runAgentLoop` 直接报错卡死（第 1 行就有「有未处理确认」拦截）。

**实际处理**（移除 + 回填「未执行」+ 续跑）：

```
1. 写操作弹出确认卡，expiresAt = now + 5min
2. 用户 5 分钟后才点「确认」
3. resumeAfterConfirmationInner: pending.expiresAt < now → 过期
   - 从 pending 队列移除该项
   - batch.results[toolCallId] = { cancelled:true, message:'确认请求已过期，该操作未执行' }
   - 若 batch.pending 空 → flushBatchResults + runAgentLoop 续跑
4. SSE> confirmation_result { approved:false, rejectedReason:'确认请求已过期' }
```

结果：不执行写、不卡死，会话能正常继续。

---

### 案例 7：确认请求重放（confirmId 一次性消费）

**若不防护**：同一 confirmId 被重复确认，导致写执行两次。

**实际处理**（消费即失效）：

```
1. 用户确认 confirmId=3f2a…，agent 执行写，并从 pending 队列移除该项
2. 用户（或前端重试）再次用 confirmId=3f2a… 发起确认
3. resumeAfterConfirmationInner: batch.pending.find(confirmId) → 找不到
   SSE> error: '确认请求不存在或已被处理'
```

结果：不重复执行。即使有并发确认，`withSessionLock` 也会先串行化（见案例 8）。

---

### 案例 8：同一会话并发确认（sessionLocks）

**若不防护**：两个确认并发执行 → 重复回填 tool 消息 + 双重续跑 → history 400。

**实际处理**（会话级互斥串行化）：

```
1. 用户快速连续确认两个写操作（confirmId=A、confirmId=B）
2. resumeAfterConfirmation(A) → withSessionLock → 进入执行
3. resumeAfterConfirmation(B) → withSessionLock → 排队等 A 完成
4. A 完成后 B 再执行，flushBatchResults 幂等回填（已存在的 tool_call_id 跳过）
```

结果：不会重复 push 同一条 tool 消息，也不会并发跑两份循环（另有 `runningSessions` 双重防护）。

---

### 案例 9：流式中断产生悬空 tool_calls（history 完整性）

**若不防护**：模型已下发 `message_start` + 部分 tool_calls 分片后流断，`assistant(tool_calls)` 缺 tool 消息 → 下次请求 400。

**实际处理**（回滚 + 完整性补齐）：

```
1. 模型流式返回中，delta 累积出 tool_calls 分片（arguments 只拼到一半）
2. 遍历 stream 抛错（非取消）
   - 只 push 已收到的纯文本 content（不 push 带悬空 tool_calls 的 assistant）
   - SSE> message_end
   - return（不进入工具执行）
3. 即便历史里已存在缺失 tool 的 assistant，进入下一轮前 ensureHistoryIntegrity 会逐条补齐 MISSING_RESULT_CONTENT
```

结果：历史始终保持「assistant(tool_calls) → 其后紧跟 tool 消息组」不变式。

---

### 案例 10：审批「已处理」重复操作（L0 + 幂等）

**若不防护**：管理员对已通过的审批再次 approve，后端报「该申请已处理」，模型若误解会反复重试。

**实际处理**（L0 分类 + 幂等缓存）：

```
1. 管理员确认 approve_approval(A001)
2. 后端 runIdempotent(confirmId): 首调成功 → 事务内改状态 + 记幂等
3. 若响应超时，executor 用同 key 重试 → 命中缓存，返回已通过的结果（不再报「已处理」）
4. 若是在新一轮里用新参数重新 approve 同一个已处理的 A001：
   后端 code!=0 message="该申请已处理"
   executor: buildErrorFeedback → ALREADY_PROCESSED
   hint: '目标状态已变更，请勿重试，可重新查询最新状态'
```

结果：超时重试场景下拿到正确成功结果；真正的「重复操作」场景下被引导去重新查询。

---

## 7. 一句话总结

- **数据库**：SQLite，实体表 + `meta` + `idempotency`，业务数据与幂等记录同库同事务。
- **幂等键**：`confirmId`（`randomUUID`），确认卡生成时诞生，确认执行/超时重试全程复用。
- **超时处理**：写工具带幂等键最多重试 3 次（300/600ms 退避），后端按 key 去重 → 不重复落库。
- **agent-loop 异常分层**：L0 结构化错误反馈（分类+引导）、L1 失败签名登记、L2 同签名短路；加上会话级锁、历史完整性补齐、确认过期/重放防护，构成完整闭环。
- **内存 vs 持久**：`failedSigs`/`succeededSigs` 是会话内行为护栏，不落库；真正的 exactly-once 由后端 `idempotency` 表保证。
