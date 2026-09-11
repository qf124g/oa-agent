# web - OA 业务前端

企业协同办公平台前端，基于 React 18 + TypeScript + Vite + Ant Design，工作台数据概览使用 AntV（@ant-design/plots）图表。

## 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| /login | 登录 | 账号密码登录，token 存 localStorage |
| / | 工作台 | 统计卡片 + AntV 数据概览柱状图 + 待办/审批速览 |
| /todo | 待办任务 | 列表筛选、新建、标记完成 |
| /approval | 审批中心 | 我发起的 / 待我审批（管理员）/ 发起申请 |
| /announcement | 公告 | 列表、详情、发布（管理员） |
| /directory | 通讯录 | 部门筛选、姓名搜索、员工详情 |
| /knowledge | 知识库 | 文档列表、详情、新增/删除（管理员） |

页面右上角悬浮球为 AI 助手入口（来自 agent-sdk），点击展开对话面板，支持流式回复、写操作确认、执行日志查看。

## 脚本

```bash
npm run dev -w web      # 开发模式，端口 5173
npm run build -w web    # 生产构建，输出 dist/
```

## 后端地址配置

开发环境（[src/constants.ts](./src/constants.ts)）默认直连：
- `API_BASE = http://localhost:8080`（业务后端）
- `AGENT_SERVER_URL = http://localhost:3002`（agent-server）

生产构建由 [.env.production](./.env.production) 置空两个变量，走同源 nginx 反代（见根目录 deploy/nginx.conf），无需再改代码。也可通过环境变量覆盖：

```bash
VITE_API_BASE=https://api.example.com npm run build -w web
```

## 鉴权

登录后 token（UUID）写入 localStorage，业务请求经 [src/api.ts](./src/api.ts) 自动携带 `Authorization: Bearer <token>`；agent 请求由 `getAuthHeaders` 透传给 SDK。
