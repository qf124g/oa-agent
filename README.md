# 企业协同办公平台 + AI Agent 助手

一个前后端分离、Monorepo 管理的企业协同办公（OA）演示项目，核心亮点是**自研 AI Agent 服务**：以悬浮窗 SDK 形式嵌入业务前端，通过大模型 toolcall 多步推理，把自然语言对话转化为真实的业务操作。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│ web (React + TS + Vite + Ant Design + AntV)              │
│  OA 业务前端：工作台 / 待办 / 审批 / 公告 / 通讯录 / 知识库 │
│  └─ 内嵌 agent-sdk 悬浮助手                               │
└───────┬──────────────────────────────┬───────────────────┘
        │ HTTP /api/*                  │ SSE /api/chat(/confirm)
        ▼                              ▼
┌───────────────────┐      透传      ┌────────────────────────┐
│ backend           │ ◄── token ─── │ agent-server           │
│ Express + TS      │   /api/*      │ Express + TS           │
│ 内存数据 + RBAC    │               │ toolcall 循环 + SSE + RAG│
│ :8080             │               │ :3002 → 大模型(OpenAI兼容)│
└───────────────────┘               └────────────────────────┘
```

四个 workspace 包：

| 包 | 说明 | 端口 |
|---|---|---|
| [web](./web/README.md) | OA 业务前端（React 18 + Vite + antd + AntV） | 5173 |
| [backend](./backend/README.md) | 业务后端（Express + TS，内存数据存储，RBAC） | 8080 |
| [agent-server](./agent-server/README.md) | Agent 服务（toolcall 多步推理、SSE 流式协议、写操作人机确认、RAG） | 3002 |
| [agent-sdk](./agent-sdk/README.md) | React 悬浮窗助手组件库（对话面板 / 确认弹窗 / 执行日志面板） | - |

## Agent 核心能力

- **多步推理循环**：模型思考 → 工具决策 → 执行 → 结果回注 → 汇总回复，单轮支持多工具串行调用，8 步熔断
- **19 个业务工具**：11 个只读查询 + 8 个写操作，JSON Schema 声明参数约束
- **SSE 全链路流式协议**：11 种事件类型，前端日志面板可逐步观测工具决策与返回
- **人机回环（Human-in-the-loop）**：写操作自动生成含摘要与风险等级的确认卡片，用户确认后执行
- **权限透传**：用户 token 由前端 → agent-server → 业务后端全链路透传，接口级 RBAC 校验
- **RAG 知识增强**：文档分块 → Embedding → 向量索引（按内容 hash 增量更新）→ 余弦相似度检索 → 上下文注入

## 快速开始

要求 Node 20+。

```bash
# 1. 安装依赖（workspaces 根目录统一安装）
npm install

# 2. 配置大模型密钥（阿里云百炼 DashScope，兼容 OpenAI 协议）
cp agent-server/.env.example agent-server/.env
# 编辑 agent-server/.env 填入 OPENAI_API_KEY

# 3. 一键启动三个服务（backend:8080 + agent-server:3002 + web:5173）
npm run dev
```

浏览器访问 http://localhost:5173

演示账号（密码均为 `123456`）：

| 账号 | 姓名 | 角色 |
|---|---|---|
| admin | 陈昊 | 管理员（可审批、发公告、管理知识库） |
| zhangwei | 张伟 | 员工 |
| lina | 李娜 | 员工 |

试试对助手说：「帮我新建一个高优先级待办：周五前提交周报」、「我有哪些待审批的申请」、「请假流程是什么」。

## 生产部署

已内置部署配置：

- [deploy/nginx.conf](./deploy/nginx.conf)：前端静态托管 + `/api/chat(/confirm)` → 3002（SSE 关闭缓冲）+ 其余 `/api/*` → 8080
- [ecosystem.config.js](./ecosystem.config.js)：pm2 双进程守护

```bash
npm install && npm run build -w web   # 生产构建走同源反代（web/.env.production）
cp agent-server/.env.example agent-server/.env  # 填入密钥
pm2 start ecosystem.config.js && pm2 save
sudo cp deploy/nginx.conf /etc/nginx/conf.d/oa.conf  # 改 server_name 后 reload
```

## 目录结构

```
├── web/            # OA 业务前端
├── backend/        # 业务后端（Express，内存数据）
├── agent-server/   # Agent 服务（核心）
│   └── src/
│       ├── agent-loop.ts    # toolcall 多步推理循环
│       ├── sse.ts           # SSE 事件协议
│       ├── tools/           # 19 个业务工具定义与执行器
│       └── rag/             # 分块 / Embedding / 向量索引
├── agent-sdk/      # React 助手组件库
├── deploy/         # nginx 配置
└── documents/      # 需求文档
```
