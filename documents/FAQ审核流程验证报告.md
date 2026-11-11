# FAQ 审核流程验证报告

> 验证时间：2026-11-11 · 验证脚本：[backend/scripts/verify-audit.sh](../backend/scripts/verify-audit.sh)

## 一、验证目标

验证 RAG 用户数据治理链路中「审核」环节是否按预期工作，核心断言：

1. 用户提交的 FAQ 候选默认处于 `PENDING`，**不进检索数据源**。
2. 审核通过后翻转为 `APPROVED`，**进入检索数据源**。
3. 驳回会移除候选，不残留脏数据。
4. 待审数据只有管理员可见，普通员工越权查询被拒（403）。
5. 同义词（运营配置）走管理员直通，增删即时生效。
6. 治理字段（`source`/`status`/`scope`/`createdBy`）全程正确落库。

## 二、测试环境与账号

| 项 | 值 |
| --- | --- |
| 后端地址 | `http://localhost:8080`（tsx watch，热重载） |
| 管理员 | `admin`（E001，角色 `ADMIN`） |
| 普通员工 | `zhangwei`（E002，角色 `EMPLOYEE`） |

## 三、验证用例设计（13 步）

| # | 用例 | 预期 |
| --- | --- | --- |
| 1 | 提交候选 A「如何申请年假？」 | 落库 `PENDING`，`source=user_query` |
| 2 | 提交候选 B「测试驳回问题」 | 落库 `PENDING` |
| 3 | 审核前查默认列表 | 不含 A/B |
| 4 | 审核前查 `?status=PENDING` | 含 A/B |
| 5 | 普通员工查 `?status=PENDING` | 403 拒绝 |
| 6 | 通过 A（approve） | A 翻转为 `APPROVED` |
| 7 | 驳回 B（delete） | B 被移除 |
| 8 | 审核后查默认列表 | 含 A，状态 `APPROVED` |
| 9 | 审核后查 `?status=PENDING` | 空数组 |
| 10 | 同义词新增「打车」 | 落库 `APPROVED`，`source=manual` |
| 11 | 同义词列表 | 含新增「打车」 |
| 12 | 同义词删除「打车」 | 删除成功 |
| 13 | 同义词列表 | 恢复为 3 条 seed |

## 四、执行结果（关键步骤实录）

**步骤 1 — 提交候选 A**（治理字段完整落库）

```json
{"id":"F021","question":"如何申请年假？","answer":null,"source":"user_query",
 "status":"PENDING","scope":"PUBLIC","departmentId":null,"createdBy":"E001"}
```

**步骤 3 — 审核前默认列表**（只返回历史已审核的 F019，不含 A/B）

```json
{"data":[{"id":"F019","question":"年假怎么申请？","status":"APPROVED"}]}
```

**步骤 4 — 审核前待审列表**（A/B 均命中）

```json
{"data":[
  {"id":"F022","question":"测试驳回问题","status":"PENDING"},
  {"id":"F021","question":"如何申请年假？","status":"PENDING"}]}
```

**步骤 5 — 普通员工越权查询**（权限拦截生效）

```json
{"code":403,"message":"无权限查看待审核 FAQ","data":null}
```

**步骤 6 — 通过候选 A**（状态翻转 + `updatedAt` 更新）

```json
{"data":{"id":"F021","question":"如何申请年假？","status":"APPROVED"}}
```

**步骤 7 — 驳回候选 B**（删除成功）

```json
{"code":0,"message":"ok","data":null}
```

**步骤 8 — 审核后默认列表**（F021 进入检索数据源）

```json
{"data":[
  {"id":"F021","question":"如何申请年假？","status":"APPROVED"},
  {"id":"F019","question":"年假怎么申请？","status":"APPROVED"}]}
```

**步骤 9 — 审核后待审列表**（清空）

```json
{"data":[]}
```

**步骤 10 — 同义词新增**（管理员直通 `APPROVED`，`source=manual`）

```json
{"data":{"id":"S023","term":"打车","synonyms":["叫车","出租车"],
 "source":"manual","status":"APPROVED","scope":"PUBLIC","createdBy":"E001"}}
```

**步骤 11/13 — 同义词增删前后**（S023 加入后删除，恢复 3 条 seed：S001 报销 / S002 请假 / S003 工资）

## 五、结果汇总

| # | 用例 | 判定 |
| --- | --- | --- |
| 1 | 提交候选 A → PENDING + 治理字段 | ✅ 通过 |
| 2 | 提交候选 B → PENDING | ✅ 通过 |
| 3 | 审核前默认列表不含 A/B | ✅ 通过 |
| 4 | 审核前待审列表含 A/B | ✅ 通过 |
| 5 | 普通员工查待审 → 403 | ✅ 通过 |
| 6 | 通过 A → APPROVED | ✅ 通过 |
| 7 | 驳回 B → 删除 | ✅ 通过 |
| 8 | 审核后默认列表含 A | ✅ 通过 |
| 9 | 审核后待审列表为空 | ✅ 通过 |
| 10 | 同义词新增直通 APPROVED | ✅ 通过 |
| 11 | 同义词列表含新增 | ✅ 通过 |
| 12 | 同义词删除成功 | ✅ 通过 |
| 13 | 同义词列表恢复 seed | ✅ 通过 |

**结论：13/13 全部通过，审核链路（清洗 → 待审 → 通过/驳回 → 准入过滤）与权限隔离均符合设计预期。**

