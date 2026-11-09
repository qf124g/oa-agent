# AI 辅助开发规范

> 适用范围：food\_shop\_agent 全仓库（backend / agent-server / agent-sdk / web）。
> 目标：把 AI 从个人技巧变成团队标准产能，同时守住代码质量与数据安全底线。

***

## 1. 工具链统一

| 场景      | 统一工具                                 | 说明                                     |
| ------- | ------------------------------------ | -------------------------------------- |
| 代码生成/改写 | Trae / Cursor                        | 统一使用项目仓库内的规则配置，不各用各的提示词风格              |
| 单元测试生成  | AI 生成骨架 + 人工评审                       | eval 用例（agent-server/src/eval）优先 AI 起草 |
| 性能分析    | AI 解读 Lighthouse / Performance trace | 输出瓶颈结论 + 优化建议，人工确认后执行                  |
| 文档生成    | AI 起草 + 人工校对                         | 技术方案、验证报告先出草稿再评审                       |

***

## 2. 项目级规则（提交到仓库，AI 必读）

以下内容已固化为项目约定，使用 AI 生成代码时必须纳入上下文（rules / system prompt）：

**不重复造轮子**：改动前先理解已有实现（如 agent-loop、session、skills 注册表），在原基础上修改完善。

- **注释用中文，UTF-8 编码；代码中不出现 emoji**。
- **不考虑 fallback、不做旧兼容**：处理思路是「消除 fallback 触发场景」而不是「加更多兜底」；不写防御性死代码。
- **不主动创建文档/测试脚本**：除非明确提出，AI 不得顺手新建 md 或测试文件。
- **React 组件禁止内联 style**：一律走 CSS 类（如 agent-chat.css、global.css）。
- **中间件一文件一职责**：`src/middleware/` 下每个文件只处理一个关注点，鉴权中间件必须校验通过后才 `next()`。
- **代码迁移先 copy 再改写**：禁止凭记忆重写，避免漏改。

***

## 3. 必须人工评审的场景（AI 生成不可直接提交）

- 鉴权与会话：`auth.ts`、token 校验、SSE 鉴权头懒加载逻辑；
- 写操作链路：agent-server 中所有写工具、`run_skill_script` 白名单与 basename 校验（防路径穿越）；
- 确认机制：pendingBatch 队列、confirmId 一次性消费、tool 消息按 tool\_calls 原始顺序回填；
- 事件推送：backend → agent-server 的同步 HTTP 回调（shared secret）、自环跳过规则；
- 数据安全相关：知识库上传（10MB 限制）、文件解析（pdf/docx）、embedding 调用。

AI 在这几处生成的代码，commit 前必须逐行人工 Review。

***

## 4. Prompt 资产库（团队共享）

沉淀在团队知识库，持续补充：

- **页面/组件骨架**：「用 Ant Design v6 + CSS 类（禁内联样式）生成一个 XX 页面，按钮与内容保持间距，不留多余空行」；
- **图表**：「输出 \`\`\`chart 代码块，字段仅 type/xField/yField/data，数据只能来自工具返回」；
- **Skill 编写**：「在 agent-server/skills/ 下新建 SKILL.md + scripts/\*.mjs，脚本导出 `(args) => result`，只做本地确定性计算，不调后端 HTTP」；
- **eval 用例**：「参照 agent-server/src/eval/cases.ts 格式，为 XX 场景补 3 条用例」。

***

## 5. 度量与复盘

- 每月统计：AI 生成代码占比、AI 产出返工率、人均需求吞吐量；
- 每两周一次分享会：成员轮流讲 AI 实战案例（好案例入库，坏案例进「避坑清单」）；
- 避坑清单示例（本项目真实踩坑，供 AI 上下文引用）：
  - koa-connect 包装 Express 中间件会丢 ctx.state → 必须原生 Koa 改写；
  - Node 16 跑 Vite 5 / pdf-parse 报错 → 全仓库锁定 Node 20（.nvmrc）；
  - 单值 pendingConfirmation 会静默丢弃同轮第二个写工具 → 已改为队列结构；
  - SSE 橡皮筋连线盖住端口导致 elementFromPoint 命中失败 → 拖拽层必须压在最底层。

