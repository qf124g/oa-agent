# RAG 知识库用户数据治理与审核实现

本文档整理本轮对 RAG 知识库的改造：如何在不污染主库的前提下动态沉淀用户数据（高频问题、关键词/同义词），并建立「清洗 → 审核 → 准入」的治理链路，以及配套的审核界面。

> 前置背景见 [RAG思考与实现进度.md](./RAG思考与实现进度.md)，本文只讲**本轮新增的用户数据治理能力**，不重复已有内容。

## 1. 目标与设计原则

围绕「用户产生的数据如何安全地进入检索链路」确立四条原则：

| 原则 | 落地方式 |
| --- | --- |
| 文档进主库增量入库 | 主文档索引按 `contentHash` 文档级增量更新（原有能力，保持） |
| 常问问题进独立 FAQ 索引 | FAQ 单独建 `VectorIndex`，与主文档库完全隔离，检索时合并并区分来源 |
| 关键词/同义词进查询改写词典热加载 | 同义词不向量化，单独走内存词典，随同步事件整表替换 |
| 用户数据必须清洗、审核、带来源与权限字段 | FAQ 候选 `PENDING` 待审，通过后 `APPROVED`；来源 `source`、权限 `scope` 全程落库 |

## 2. 整体架构：三路分离

知识数据不再混在一个向量库里，而是按性质拆成三路：

```
                     ┌─ 主文档 ──── 主向量索引 index（contentHash 增量）
后端数据源 ──同步──→  ├─ FAQ ─────── 独立向量索引 faqIndex（仅 APPROVED+PUBLIC）
                     └─ 同义词 ──── 查询改写词典 dict（内存 Map，整表热加载，不向量化）
```

检索时主文档命中与 FAQ 命中合并排序，同义词在检索前做查询扩展，三者职责互不干扰。

## 3. 改动清单总览

| 层 | 文件 | 做了什么 | 负责什么 |
| --- | --- | --- | --- |
| 后端模型 | `backend/src/types.ts` | 新增 `SynonymEntry`/`FaqEntry` 及治理字段 | 定义用户数据的数据结构与治理字段 |
| 后端存储 | `backend/src/store.ts` | 新增 `synonyms`/`faqs` 两张表与 Collection、`ensureSynonymSeed` | 持久化同义词与 FAQ，保证初始词典幂等注入 |
| 后端接口 | `backend/src/index.ts` | 新增同义词/FAQ 全套路由、4 个清洗函数、事件扩展 | 提供数据增删查、审核入口与清洗/准入过滤 |
| 检索侧词典 | `agent-server/src/rag/synonym-dict.ts` | 词典内存热加载 + `expandQueryWithSynonyms` | 同义词查询扩展，不参与向量化 |
| 检索侧同步 | `agent-server/src/rag/knowledge-sync.ts` | 主索引/独立 FAQ 索引分离、同步 bundle、检索合并、FAQ 候选上报 | 三路数据的同步、检索与用户问题沉淀 |
| 检索侧事件 | `agent-server/src/events.ts` | 适配 `knowledge.updated` 新事件结构 | 实时接收后端已审核数据并重建索引 |
| 检索侧执行 | `agent-server/src/tools/executor.ts` | `collectUserQuery` 增加 token 透传 | 采集原始问题并上报候选 |
| 前端界面 | `web/src/pages/Knowledge.tsx`、`web/src/types.ts` | 知识库页三 Tab、审核/词典组件、前端类型 | 提供人工审核与同义词维护界面 |

## 4. 分模块详解

### 4.1 后端数据模型（`types.ts`）

两条用户数据的共同治理字段：

- `source`：来源，取值 `seed` / `user_query` / `manual`。
- `status`：审核状态，`PENDING`（待审）/ `APPROVED`（已通过）。
- `scope`：可见范围，`PUBLIC`（公开）/ `DEPARTMENT`（部门可见）。
- `departmentId`：`scope=DEPARTMENT` 时限定部门，否则为 `null`。
- `createdBy` / `createdAt` / `updatedAt`：创建人、时间戳，用于溯源。

`SynonymEntry` 额外含 `term`（主词）+ `synonyms`（扩展词数组）；`FaqEntry` 含 `question`（问题）+ `answer`（可空答案）。

### 4.2 后端存储（`store.ts`）

- `TABLES` 增加 `synonyms`、`faqs` 两张表，SQLite 建表。
- `Store` 增加 `synonyms`、`faqs` 两个 `Collection` 实例。
- `ensureSynonymSeed()`：词典为空时注入三条初始同义词（报销/请假/工资），幂等，保证无论旧库新库启动后词典都有可演示数据。

### 4.3 后端接口与清洗（`index.ts`）

**清洗函数**（入口轻量规范化）：

| 函数 | 作用 |
| --- | --- |
| `normalizeTerm` | 主词去首尾空白 |
| `normalizeSynonyms` | 逐项 trim、去空、去重 |
| `normalizeQuestion` | trim + 折叠连续空白 |
| `normalizeAnswer` | 非字符串或空白返回 `null` |

**同义词接口**（管理员维护，管理员操作视为已审核）：

| 方法 | 路径 | 职责 |
| --- | --- | --- |
| `GET` | `/api/knowledge/synonyms` | 返回 `APPROVED+PUBLIC` 词典（供 agent-server 热加载） |
| `POST` | `/api/knowledge/synonyms` | 管理员新增，直接 `APPROVED`，触发事件 |
| `DELETE` | `/api/knowledge/synonyms/:id` | 管理员删除，触发事件 |

**FAQ 接口**（用户产生，需人工审核）：

| 方法 | 路径 | 职责 |
| --- | --- | --- |
| `GET` | `/api/knowledge/faqs` | 默认返回 `APPROVED+PUBLIC`；管理员 `?status=PENDING\|ALL` 查待审/全部 |
| `POST` | `/api/knowledge/faqs` | 提交候选，落库 `PENDING`，**不触发**索引同步 |
| `POST` | `/api/knowledge/faqs/:id/approve` | 管理员审核通过，`APPROVED`，触发事件 |
| `DELETE` | `/api/knowledge/faqs/:id` | 管理员驳回/删除，删除已审核条目才触发事件 |

**事件扩展**：`emitKnowledgeEvent` 的 `knowledge.updated` 事件体由 `{ docs }` 扩展为 `{ docs, synonyms, faqs }`，其中 `synonyms`/`faqs` 只携带 `APPROVED+PUBLIC` 条目。

### 4.4 检索侧词典（`synonym-dict.ts`）

- `reloadSynonyms(entries)`：整表替换内存词典（`Map<term, synonyms[]>`），即「热加载」。
- `expandQueryWithSynonyms(query)`：命中主词时，把未出现的同义词追加进查询串，用于提升不同表述的召回。词典**不做向量化**。

### 4.5 检索侧同步与检索（`knowledge-sync.ts`）

- `index`（主文档索引）+ `faqIndex`（独立 FAQ 索引）两个 `VectorIndex` 实例。
- `reconcileDocs`：主文档按 `contentHash` 增量更新，删除的移除。
- `reconcileFaqs`：FAQ 独立索引增量更新，`category` 固定 `user_faq` 与主文档隔离。
- `applyBundle`：一次性应用 `{ docs, synonyms, faqs }`（主索引 + FAQ 索引 + 词典热加载）。
- `ensureSynced`（拉取路径）/ `syncFromEvent`（事件路径）：两路同步入口。
- `searchKnowledge`：先做同义词扩展，再检索主索引与 FAQ 索引，命中合并按 score 排序截取 top-k。
- `collectUserQuery` + `submitFaqCandidate`：聚合计数达阈值后，把清洗后的问题 POST 到后端 `/api/knowledge/faqs`（`source=user_query`），同一问题仅上报一次。

### 4.6 前端审核界面（`Knowledge.tsx`）实现细节

知识库页由单列表重构为三个 Tab（antd `Tabs` 承载），后两个仅管理员可见。

**组件结构**

```
Knowledge（主组件：useAuth 判权 + Tabs 容器）
├─ DocumentList          文档 Tab（原列表/详情/新增/上传逻辑整体抽出）
├─ FaqReview             FAQ 审核 Tab
└─ SynonymManager        同义词 Tab
    └─ SynonymCreateModal 新增同义词弹窗
```

**权限控制**

主组件通过 `useAuth()` 获取 `user`，`const isAdmin = user?.role === 'ADMIN'`；`items` 先只放「文档」，仅当 `isAdmin` 为真时才追加「FAQ 审核」「同义词」两个 Tab。普通员工看不到审核入口，前端与后端 `requireRole('ADMIN')` 双重拦截。

**FaqReview 组件**

- 状态：`rows: FaqEntry[]`、`loading`、`error`。
- 加载：`apiGet<FaqEntry[]>('/api/knowledge/faqs?status=PENDING')`，只拉待审列表。
- 通过：`apiPost('/api/knowledge/faqs/${id}/approve')` → `message.success` → `load()` 刷新。
- 驳回：`apiDelete('/api/knowledge/faqs/${id}')` → `load()` 刷新。
- 表格列：问题（`question`）、来源（`source` Tag）、提交时间（`createdAt` 格式化）、操作（通过/驳回）。

核心代码：

```tsx
const approve = async (id: string) => {
  try {
    await apiPost(`/api/knowledge/faqs/${id}/approve`);
    message.success('已通过，进入检索链路');
    load();
  } catch (err) {
    message.error(err instanceof Error ? err.message : '审核失败');
  }
};

const reject = async (id: string) => {
  try {
    await apiDelete(`/api/knowledge/faqs/${id}`);
    message.success('已驳回');
    load();
  } catch (err) {
    message.error(err instanceof Error ? err.message : '驳回失败');
  }
};
```

「操作」列用 `Flex` 排布「通过」（`type="primary"`）与「驳回」（`Popconfirm` 二次确认 + `danger`）两个按钮；空态 `emptyText="暂无待审核的 FAQ"`。

**SynonymManager 组件**

- 状态：`rows: SynonymEntry[]`、`loading`、`error`、`showCreate`。
- 加载：`apiGet<SynonymEntry[]>('/api/knowledge/synonyms')`。
- 新增：`SynonymCreateModal` 弹窗，`term` 输入主词、`synonyms` 输入逗号/顿号分隔的扩展词，提交前 `split(/[,，、]/)` 拆分 → `trim` → 去空，再 `apiPost('/api/knowledge/synonyms', { term, synonyms })`。
- 删除：`apiDelete('/api/knowledge/synonyms/${id}')`（`Popconfirm` 二次确认）。
- 表格列：主词（`term` 蓝 Tag）、同义/扩展词（`synonyms` 逐个 Tag 展示）、来源（`source`）、操作（删除）。

**数据流**

三个 Tab 的数据都来自后端治理后的接口：文档走 `GET /api/knowledge`，FAQ 审核走 `GET /api/knowledge/faqs?status=PENDING`，同义词走 `GET /api/knowledge/synonyms`。审核/删除动作成功后都重新 `load()` 刷新；后端已审核数据通过 `knowledge.updated` 事件推给 agent-server 重建独立 FAQ 索引与词典，形成闭环。

## 5. 治理链路：清洗 → 审核 → 准入

### 5.1 清洗

入口 4 个纯函数做格式规范化（trim、去空、去重、折叠空白）。当前为**轻量清洗**，尚未加入长度门禁、敏感词、语义去重（完善方向见第 9 节）。

### 5.2 审核

`status: PENDING → APPROVED` 状态机：

- FAQ（用户产生）：提交即 `PENDING`，管理员 approve 后 `APPROVED`。
- 同义词（运营配置）：管理员直接 `APPROVED`。

### 5.3 准入过滤

统一在出口处 `status === 'APPROVED' && scope === 'PUBLIC'` 过滤：

- 查询接口 `GET /faqs`、`GET /synonyms` 只返回已审核公开条目。
- 事件体只携带已审核公开的 `synonyms`/`faqs`。

因此**未审核数据在数据源出口即被拦下**，agent-server 拿不到，自然进不了向量索引与检索链路。

## 6. 数据流转全链路（以 FAQ 为例）

```
用户提问
  → executor.collectUserQuery(query, token)        采集原始问题（改写前）
  → 聚合计数达阈值 → submitFaqCandidate            清洗 + 上报
  → POST /api/knowledge/faqs                       后端落库 status=PENDING
  → 管理员在「FAQ 审核」Tab 点「通过」                POST /:id/approve
  → status=APPROVED → emitKnowledgeEvent            事件携带 APPROVED faqs
  → agent-server syncFromEvent → reconcileFaqs      重建独立 FAQ 索引
  → searchKnowledge                                检索时 FAQ 命中与文档合并返回
```

## 7. API 一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/knowledge/synonyms` | 登录 | 已审核公开词典 |
| `POST` | `/api/knowledge/synonyms` | 管理员 | 新增同义词（直接通过） |
| `DELETE` | `/api/knowledge/synonyms/:id` | 管理员 | 删除同义词 |
| `GET` | `/api/knowledge/faqs` | 登录 | 默认已审核；管理员可 `status=PENDING/ALL` |
| `POST` | `/api/knowledge/faqs` | 登录 | 提交候选（PENDING） |
| `POST` | `/api/knowledge/faqs/:id/approve` | 管理员 | 审核通过 |
| `DELETE` | `/api/knowledge/faqs/:id` | 管理员 | 驳回/删除 |

## 8. 验证记录

后端热重载后实测（`admin` 账号）：

1. 提交 FAQ 候选 → `F019` 状态 `PENDING`。
2. `GET /faqs` 默认列表不含 `F019`（PENDING 被过滤）。
3. `POST /faqs/F019/approve` → `APPROVED`。
4. `GET /faqs` 默认列表含 `F019`。
5. 提交 `F020` → `GET /faqs?status=PENDING` 命中；`DELETE /faqs/F020` 后待审列表为空。
6. `GET /synonyms` 返回 `S001-S003` 三条 seed。

前端三 Tab 未用浏览器实跑，后端数据链路已全部走通。

## 9. 后续可完善方向

- **L3 质量门禁**：问题长度上下限、纯噪声（纯标点/数字/表情）拒绝。
- **L5 语义去重**：提交候选时与已有 `APPROVED` FAQ 做向量相似度比对，超阈值判重复、拒绝新增，替代当前进程内精确串去重。
- **敏感词机审**：词库命中直接拒收或转人工复核。
- **权限落地**：`scope=DEPARTMENT` 目前仅落库字段，检索侧尚未按部门过滤（需引入检索时的用户上下文）。
