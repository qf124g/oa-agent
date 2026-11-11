# Query 改写实现说明

本文档说明 agent-server 检索侧对用户问题的改写机制：为什么改写、改写在链路中的位置、三层改写各自的实现细节、触发条件与降级策略。

## 1. 概述

用户自然语言提问往往不适合直接用于向量检索，常见三类问题：

| 问题 | 例子 | 影响 |
| --- | --- | --- |
| 指代/省略 | 「那它怎么申请呢？」（「它」指上文提到的年假） | 脱离上下文无法独立检索 |
| 多意图 | 「年假和病假分别怎么申请？」 | 一个 query 混两个主题，检索结果互相稀释 |
| 表述不一致 | 「请假」 vs 知识库里的「休假」「年假」 | 字面不匹配导致漏召回 |

为此，检索前插入三层改写，按序执行：

```
原始 query
  ├─ ① 指代消解   rewriteQueryForSearch    （LLM，命中触发词才调用）
  ├─ ② 多意图拆分 splitMultiIntentQuery     （LLM，命中多问句才调用）
  └─ ③ 同义词扩展 expandQueryWithSynonyms   （词典，纯内存，不调 LLM）
```

## 2. 整体链路与调用顺序

改写入口在 [executor.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/tools/executor.ts#L104-L134) 的 `search_knowledge` 分支：

```
search_knowledge(args.query, ctx)
  → collectUserQuery(query, token)              改写前采集原始问题（FAQ 沉淀）
  → rewriteQueryForSearch(query, ctx.history)   ① 指代消解
  → splitMultiIntentQuery(rewritten)            ② 多意图拆分
    ├─ 多意图（>1 子问题）
    │    → 子问题分别 searchKnowledge → mergeHits 合并去重
    └─ 单意图
         → searchKnowledge(rewritten)
              → expandQueryWithSynonyms(rewritten)  ③ 同义词扩展
              → embedText → 主索引 + FAQ 索引检索 → 合并 top-k
```

历史上下文的来源：agent-loop 在构造工具上下文时，用 `formatHistoryForRewrite(session.history)` 把最近若干轮对话序列化后作为 `ctx.history` 传入（[agent-loop.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/agent-loop.ts#L202)）。

## 3. 三层改写详解

### 3.1 指代消解 `rewriteQueryForSearch`

文件：[query-rewrite.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/rag/query-rewrite.ts#L31-L56)

**职责**：结合对话历史，把当前问题里的指代词（它/这个/都/上次等）和省略内容补全为独立、完整、可直接检索的问题。

**触发条件**：query 命中触发词正则才调用，否则原样返回，避免每次检索都多一次 LLM 调用。

```ts
const REWRITE_TRIGGER = /它|他|她|这个|那个|这些|那些|都|还有|其他|别的|上次|刚才|上一条/;
```

**改写提示词**：把对话历史 + 当前问题拼成 prompt，`temperature=0` 保证稳定，只要求返回改写后的问题本身。

**降级**：LLM 调用抛错时 `catch` 返回原 query，改写失败不阻断检索。

### 3.2 多意图拆分 `splitMultiIntentQuery`

文件：[query-rewrite.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/rag/query-rewrite.ts#L59-L86)

**职责**：把「年假和病假分别怎么申请？」这类复合问题拆成多个可独立检索的子问题。

**触发条件**：命中多问句正则。

```ts
const MULTI_INTENT_TRIGGER = /[?？].*[?？]|[、；;].*[?？]/;
```

**实现要点**：

- LLM 返回 JSON 字符串数组，剥离可能包裹的 ```json 代码块标记后 `JSON.parse`。
- 过滤空串，仅当子问题 > 1 个才返回，否则返回空数组（由调用方按单查询处理）。
- 拆出的子问题各自独立检索，结果经 `mergeHits` 合并去重后返回，且结果中携带 `subQueries` 供上层观测。

**降级**：解析失败/非数组/数量不足时返回空数组，回退单查询。

### 3.3 同义词扩展 `expandQueryWithSynonyms`

文件：[synonym-dict.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/rag/synonym-dict.ts)

**职责**：把词典中的同义词并入 query，提升不同表述的召回（如「请假」命中主词时补入「休假、年假、事假」）。

**实现**：

```ts
export function expandQueryWithSynonyms(query: string): string {
  const extra: string[] = [];
  for (const [term, synonyms] of dict) {
    if (!query.includes(term)) continue;
    for (const s of synonyms) {
      if (!query.includes(s) && !extra.includes(s)) extra.push(s);
    }
  }
  if (extra.length === 0) return query;
  return `${query} ${extra.join(' ')}`;
}
```

**特点**：纯内存 `Map` 词典，**不向量化、不调 LLM**；词典由 `reloadSynonyms` 随知识库同步事件整表替换（热加载），数据源是后端已审核公开的同义词条目。

## 4. 历史上下文格式化 `formatHistoryForRewrite`

文件：[query-rewrite.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/rag/query-rewrite.ts#L18-L28)

把 `ChatCompletionMessageParam[]` 历史序列化为「用户: xxx / 助手: xxx」文本，仅取最近 `maxTurns`（默认 4）轮，供指代消解补全上下文。

## 5. 与用户问题沉淀的衔接

改写**之前**先调用 `collectUserQuery(query, token)` 采集原始问题（[executor.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/tools/executor.ts#L109)），保证沉淀的是用户真实表述而非改写后文本。

`collectUserQuery`（[knowledge-sync.ts](file:///Users/test/Desktop/food_shop_agent/agent-server/src/rag/knowledge-sync.ts#L172-L180)）对问题做规范化（trim + 小写 + 折叠空白）后聚合计数，达到 `config.faqThreshold` 且未上报过时，`submitFaqCandidate` 提交到后端 `/api/knowledge/faqs`（`source=user_query`，`PENDING` 待审核）。审核与准入见 [RAG用户数据治理与审核实现.md](./RAG用户数据治理与审核实现.md)。

## 6. 结果回传结构

改写结果会随检索结果回传，供 LLM 与前端观测：

- 单意图命中改写时：`{ hits, rewritten: { original, rewritten } }`；未改写时 `rewritten` 为 `undefined`。
- 多意图拆分时：额外携带 `subQueries` 数组。

## 7. 降级与容错

| 环节 | 失败处理 |
| --- | --- |
| 指代消解 LLM 调用 | 抛错返回原 query，检索照常 |
| 多意图拆分 LLM 调用 | 解析失败返回空数组，回退单查询 |
| 同义词扩展 | 纯本地词典，无网络依赖，不会失败 |

核心原则：**改写是增强，不是必经环节**，任何改写失败都降级回原 query，不阻断检索。

## 8. 配置与扩展点

- 触发词正则 `REWRITE_TRIGGER` / `MULTI_INTENT_TRIGGER`：按需增补触发词。
- 改写 prompt：`rewriteQueryForSearch` 内，可调整改写约束（如限定输出格式、禁止臆造）。
- 同义词词典数据源：后端 `/api/knowledge/synonyms`，经 `reloadSynonyms` 热加载，运营可在「同义词」Tab 维护。

## 9. 未覆盖场景

- **HyDE**：用 LLM 生成假设答案再以其向量检索，增强「问题—文档」向量空间对齐。
- **多路召回 + RRF 融合 + Reranker**：当前单路向量，尚未接入 BM25 字面召回与精排。
- **改写结果缓存**：相同历史 + 相同 query 的改写结果未做缓存，重复检索会重复调用 LLM。

上述演进项在 [RAG思考与实现进度.md](./RAG思考与实现进度.md) 中列为「尚未实现」。
