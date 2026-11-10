# Agent 错误场景案例与大模型消息序列记录

> 本文档汇总项目中 Agent 循环的错误场景案例，并完整记录每次运行时大模型逐轮调用的
> 输入/返回消息序列，作为项目迭代与新项目参考的原始证据。
>
> 配套理论见 [Agent循环失控防护机制详解.md](Agent循环失控防护机制详解.md)。
> 原始 trace 文件（机器可读全量数据）存放于 `agent-server/eval-traces/`，
> 由 `npm run eval` 自动生成，每条用例一个 JSON 文件。

---

## 一、已落地的防护机制与代码位置

| 层级 | 机制 | 实现位置 |
| --- | --- | --- |
| L0 | 结构化错误反馈（哪里错/该是什么/下一步做什么） | `agent-server/src/tools/error-feedback.ts`，由 `tools/executor.ts` 接线 |
| L1 | 重复签名检测（工具名 + 规范化参数） | `agent-server/src/session.ts` 的 `signatureOf` + `Session.failedSigs` |
| L2 | 同签名短路（不执行、写工具不弹确认框，注入三选一纠偏指令） | `agent-server/src/agent-loop.ts` 的 `shortCircuitIfRepeated` |
| L4 | 轮次熔断（MAX_ROUNDS = 8） | `agent-server/src/agent-loop.ts` |
| 源头预防 | JSON Schema 枚举约束 + 工具描述写已知坑 | `agent-server/src/tools/definitions.ts` |

L0 结构化错误覆盖的错误类型映射（`error-feedback.ts`）：

| 后端文案特征 | 结构化类型 | 给模型的引导 |
| --- | --- | --- |
| `不存在` | `NOT_FOUND` | 指出 received 的 ID，hint 引导先调查询工具拿真实 ID |
| `不正确` | `INVALID_PARAM` | 给出 expected_one_of 枚举候选 + suggestion 修正值 |
| `不能为空` | `MISSING_PARAM` | 补全必填参数 |
| `已存在` | `CONFLICT` | 换值，禁止原样重试 |
| `无权限` | `FORBIDDEN` | 换路径或向用户说明，禁止重试 |
| `已处理` | `ALREADY_PROCESSED` | 目标状态已变，重新查询 |
| 网络/超时 | `SERVICE_UNAVAILABLE` | 瞬时故障，禁止模型同参重试 |

L2 短路触发时回注给模型的指令（原文）：

```json
{
  "error": "DUPLICATE_CALL_BLOCKED",
  "tool": "<工具名>",
  "detail": "该调用（相同工具、相同参数）此前已执行并失败 N 次，已被拦截，本次未真正执行。",
  "required_action": "禁止原样重试。你必须三选一：1. 修改参数后重试；2. 更换其他工具达成目标；3. 向用户说明卡点并请求补充信息。"
}
```

---

## 二、错误场景案例总览

| 案例 | 场景 | 触发方式 | 验证的防护层 | 评测用例 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 用户给出不存在的资源 ID | 问「公告 N999 的内容」 | L0 结构化错误引导恢复 | `error-recovery-001` | PASS（真实触发失败并恢复） |
| 2 | 未指明 ID 的写操作（待办） | 问「把标题叫 X 的待办标记完成」 | 源头预防（先查询路径） | `hallucination-001` | PASS（模型主动先查询） |
| 3 | 未指明 ID 的读操作（公告） | 问「关于 X 的公告写了什么」 | 源头预防（先查询路径） | `hallucination-002` | PASS（模型主动先查询） |
| 4 | 枚举参数传中文值 | 提交报销时 type 传「报销」 | L0 枚举候选 + suggestion | 待补充用例 | 机制已实现 |
| 5 | 写工具失败后同参重试 | 确认执行失败后模型原样重试 | L2 短路（不再弹确认框） | 待补充用例 | 机制已实现 |
| 6 | 后端不可用/超时 | 平台后端未启动 | `SERVICE_UNAVAILABLE` 语义 | 待补充用例 | 机制已实现 |

评测命令（需 backend 运行 + 有效 token）：

```bash
cd agent-server
EVAL_TOKEN=<平台登录token> npm run eval
# trace 输出：agent-server/eval-traces/<用例id>_<时间戳>.json
```

---

## 三、案例 1 完整消息序列：失败真实发生并被 L0 解决

用例 `error-recovery-001`，用户输入：**帮我看下公告 N999 的内容**（N999 不存在）。
以下为该次运行中每一轮大模型调用的真实输入与返回（摘自
`eval-traces/error-recovery-001_2026-11-10T08-16-03-924Z.json`，system 提示词首轮全量、后续折叠）。

### 第 1 轮：模型直接按用户给的 ID 查询 → 失败

**发给模型的输入（messages）：**

```json
[
  { "role": "system", "content": "你是企业协同办公平台（OA）的智能助手……（系统提示词全文，含回答规则与工具使用约束）" },
  { "role": "user", "content": "帮我看下公告 N999 的内容" }
]
```

**模型返回：** 无文本，发起工具调用

```json
{ "name": "get_announcement_detail", "arguments": { "id": "N999" } }
```

**工具执行结果（L0 结构化错误，回注为 tool 消息）：**

```json
{
  "error": "NOT_FOUND",
  "tool": "get_announcement_detail",
  "field": "id",
  "received": "N999",
  "hint": "公告不存在。ID 不能猜测，请先调用 list_announcements 查询真实 ID 后再重试"
}
```

要点：修复前后端原始返回是 `{"error":"公告不存在"}`——无字段、无修复路径；
修复后模型拿到了三样新信息：错在哪个字段、收到的值是什么、下一步该调哪个工具。

### 第 2 轮：模型读到 hint，转为查询真实 ID

**发给模型的输入（比第 1 轮多出第 1 轮的 assistant + tool 两条消息）：**

```json
[
  { "role": "system", "content": "（同首轮）" },
  { "role": "user", "content": "帮我看下公告 N999 的内容" },
  { "role": "assistant", "content": "", "tool_calls": [
      { "id": "call_d5b1d3f47fe24fbdb8ac7954", "name": "get_announcement_detail", "arguments": { "id": "N999" } }
  ]},
  { "role": "tool", "tool_call_id": "call_d5b1d3f47fe24fbdb8ac7954",
    "content": "{\"error\":\"NOT_FOUND\",\"tool\":\"get_announcement_detail\",\"field\":\"id\",\"received\":\"N999\",\"hint\":\"公告不存在。ID 不能猜测，请先调用 list_announcements 查询真实 ID 后再重试\"}" }
]
```

**模型返回：** 采纳 hint，改调列表工具（没有原样重试 N999）

```json
{ "name": "list_announcements", "arguments": { "pageSize": 100 } }
```

**工具执行结果：** 成功，返回 4 条真实公告（N011/N010/N001/N002，含标题与正文）。

### 第 3 轮：模型基于真实数据给出最终回答

**输入：** 第 2 轮上下文 + list_announcements 的 tool 结果。
**模型返回（纯文本，循环结束）：**

> 未找到公告 N999，该公告 ID 不存在。当前系统中共有 4 条公告，真实 ID 如下：
> （列出 N011/N010/N001/N002 表格）请确认您要查看的公告 ID，或直接告诉我公告标题关键词，
> 我帮您调出正文。（提示：N011 是 N010 的更正版本……）

### 本案例结论

- 失败真实发生（第 1 轮），但上下文因结构化错误而改变，第 2 轮输出随之改变，3 轮收敛；
- 对照修复前行为：`{"error":"公告不存在"}` 不含新信息，低温度下模型会反复重试 N999 直至 8 轮熔断；
- 若模型第 2 轮仍原样重试 N999，L2 会短路并注入三选一指令（本案例未触发，L0 已解决）。

---

## 四、案例 2/3 消息序列摘要：源头预防生效，未进入错误路径

两条幻觉用例中模型均未猜 ID，第一轮就选择了查询工具，说明
`definitions.ts` 中的工具描述（如「需要待办 ID 时先用本工具查询」）与系统提示词
规则 3（先确认 ID 再查明细）在源头拦住了幻觉。

`hallucination-001`（把标题叫「提交本周工作周报」的待办标记完成）：

```
第 1 轮输入: system + user
模型返回:   get_my_todos({ status: "PENDING", pageSize: 100 })   ← 先查询，未猜 ID
工具结果:   4 条待办（T009/T002/T008/T012）
第 2 轮:    模型发现无完全匹配项，列出候选并指出最接近的 T008，
            请用户确认后再操作（未擅自调用 complete_todo）
```

完整逐轮数据见 `eval-traces/hallucination-001_*.json` 与 `hallucination-002_*.json`。

---

## 五、尚未覆盖的层级（后续迭代项）

| 层级 | 现状 | 说明 |
| --- | --- | --- |
| L3 强制反思/摘除工具 | 未实现 | 当前 L2 短路指令已能纠偏；若线上出现「改参但换汤不换药」的震荡再补 |
| L4 熔断时的进展打包 | 仅一句错误提示 | `agent-loop.ts` 熔断处可升级为「已完成步骤 + 卡点 + 所需信息」 |
| 全局轮次预算 | 分段计数 | 确认续跑后 round 重新从 1 计数，真实上限是「每段 8 轮」，长写链路需评估是否加全局预算 |

## 六、trace 记录机制说明

- 记录器：`agent-server/src/eval/trace.ts`，`npm run eval` 时每条用例自动落盘；
- 内容：每轮发给模型的 messages（system 首轮全量）、模型返回的文本与 tool_calls、
  工具结果原文（含 L0 错误与 L2 短路指令）、运行日志（含「拦截重复调用」记录）、最终历史；
- 用途：任何一次线上/评测中的异常行为，都可用对应时间点的 trace 文件逐轮回放上下文，
  定位是「错误反馈信息不足」还是「模型未遵循 hint」，前者回流改进 `error-feedback.ts`，
  后者考虑升级 L3。
