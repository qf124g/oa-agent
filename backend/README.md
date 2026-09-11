# backend - 业务后端

OA 平台业务后端，Express + TypeScript（tsx 运行），内存数据存储，启动时初始化种子数据。端口 8080。

## 脚本

```bash
npm run dev -w backend      # 开发模式（tsx watch）
npm run start -w backend    # 生产模式
PORT=8080 npm run start -w backend  # 指定端口
```

## API 一览

统一响应结构 `{ code, message, data }`，`code=0` 为成功；鉴权接口需携带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | /api/auth/login | 登录（userNo + 密码） | 公开 |
| GET | /api/auth/me | 当前用户信息 | 登录 |
| GET | /api/dashboard/stats | 工作台统计 | 登录 |
| GET/POST | /api/todos | 待办列表 / 新建 | 登录 |
| PATCH | /api/todos/:id/complete | 标记完成 | 登录 |
| GET | /api/approvals/mine | 我发起的审批 | 登录 |
| GET | /api/approvals/pending | 待我审批 | ADMIN |
| POST | /api/approvals | 发起审批 | 登录 |
| POST | /api/approvals/:id/approve 、 /reject | 通过 / 驳回 | ADMIN |
| GET/POST | /api/announcements | 公告列表 / 发布 | 登录 / ADMIN |
| GET | /api/announcements/:id | 公告详情 | 登录 |
| GET | /api/departments | 部门列表 | 登录 |
| GET | /api/employees 、 /api/employees/:id | 员工列表 / 详情 | 登录 |
| GET/POST | /api/knowledge | 知识库列表 / 新增 | 登录 / ADMIN |
| GET | /api/knowledge/:id | 知识库详情 | 登录 |
| DELETE | /api/knowledge/:id | 删除知识库文档 | ADMIN |
| GET | /api/knowledge/full | 全量知识库文档（供 agent-server 同步向量索引） | 登录 |

## 权限模型

- 角色：`ADMIN` / `EMPLOYEE`，写管理类接口通过 `requireRole('ADMIN')` 中间件控制
- token 为登录时签发的 UUID，存于内存 Map；`/api/auth/me` 可校验并返回用户
- agent-server 的工具调用会原样透传用户 token，因此 AI 操作的权限与用户在页面上操作完全一致

## 数据说明

- 全部数据存于内存（[src/store.ts](./src/store.ts)），重启即重置为种子数据
- 种子账号：`admin`（陈昊，ADMIN）、`zhangwei`（张伟）、`lina`（李娜），密码均为 `123456`
- 实体 ID 使用全局自增序列，避免与种子数据冲突
