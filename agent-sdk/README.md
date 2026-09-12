# agent-sdk - React 智能助手组件库

可复用的 AI 助手前端 SDK。以悬浮窗形式嵌入任意 React 业务系统，两行代码接入，自带流式对话、写操作确认、执行日志面板，与业务后端完全解耦。

## 快速接入

```tsx
import { AgentProvider, FloatingAssistant } from 'agent-sdk';

function App() {
  return (
    <AgentProvider
      url="http://localhost:3002"   // agent-server 地址（生产可为空串走同源反代）
      getAuthHeaders={() => {        // 透传当前用户 token，权限与页面操作一致
        const token = localStorage.getItem('oa_token');
        return token ? { Authorization: `Bearer ${token}` } : {};
      }}
    >
      <YourApp />
      <FloatingAssistant />
    </AgentProvider>
  );
}
```

## 导出

| 导出 | 说明 |
|---|---|
| AgentProvider | 上下文 Provider，管理会话、SSE 流、确认流程、执行日志 |
| FloatingAssistant | 悬浮球 + 聊天面板（内部使用 ChatPanel + ConfirmCard） |
| ChatPanel | 独立聊天面板组件（对话视图 / 日志视图切换） |
| ConfirmCard | 写操作确认卡片（内联于消息流，操作摘要 + 风险等级标识 + 确认/取消按钮） |
| useAgent | Hook，访问会话状态与操作方法 |
| 类型 | AgentMessage、ToolCallView、ConfirmationRequest、SSEEvent、AuthHeaders 等 |

## 特性

- **流式对话**：解析 agent-server 的 SSE 事件流，回复内容逐字渲染
- **写操作人机确认**：收到 confirmation_request 事件在消息流中推入确认卡片，用户在卡片上确认/取消后续传执行，卡片定格为已确认/已取消状态保留在会话记录中
- **执行日志面板**：面板头部「日志」按钮切换视图，逐步展示"第 N 步做了什么任务、决策了什么工具、返回了什么信息"，支持展开原始 JSON；最终回复同步打印到浏览器控制台
- **工具调用可视化**：对话流中内联展示工具名称、参数与执行结果
- **鉴权透传**：`getAuthHeaders` 回调注入业务系统 token，agent-server 透传至业务后端完成权限校验
- **未读提醒**：面板关闭时收到回复显示未读角标
- **主题变量**：颜色不做硬编码，全部引用宿主应用 global.css `:root` 中的 `--color-*` / `--shadow-*` CSS 变量（见 web/src/styles/global.css），接入方需定义同名变量

## 对接协议

SDK 通过两个 SSE 端点与 agent-server 通信：

- `POST {url}/api/chat`：发起对话，body 含 sessionId 与用户消息
- `POST {url}/api/chat/confirm`：确认/取消写操作，body 含 sessionId、confirmId、approved

事件协议详见 [agent-server README](../agent-server/README.md)。

## 说明

本包以 TS 源码形式被 workspace 直接引用（web 的 vite.config 已将 agent-sdk 排除出预构建），无独立构建产物；改造后在任意 React 项目中使用只需保证对端为兼容的 agent-server。
