代码自动生成 + 智能审查 + 自动化测试三者结合，形成流程化的 AI 研发卡点
这是行业里成熟的做法

## 整体流程

```
开发者提交代码 → 自动化测试（单测/快照） → AI Review 卡点 → 人工复核 → 合并
                        ↓ 不通过                ↓ 不通过
                      打回修复               打回修复
```

卡点的本质：把"AI 生成的代码"和"AI 审查的代码"分开，生成方和审查方不能是同一个上下文，审查方拿着**项目规范文档**当标尺去量。

## 三个环节的具体实现

### 1. 代码自动生成（重构场景）

以 30+ 页面规范化改造为例：

- 先人工精改 2-3 个页面，形成**标准模式**（目录结构、组件拆分、状态管理方式、命名规则）
- 把标准模式沉淀成一份 Prompt 规范文档（如 `refactor-pattern.md`）
- 剩余页面逐个投给 AI：输入 = 旧页面代码 + 规范文档，输出 = 改造后代码
- 关键点：一次只改一个页面，改完立即验证，不批量生成

### 2. 智能审查（Review 卡点）

卡点通常挂在 **MR/PR 环节**，三种实现方式由轻到重：

**方式 A：手动流程（最轻，小团队常用）**
- 提 MR 前，用 Cursor / Claude Code 打开 diff
- 用固定的 Review Prompt 模板："对照以下项目规范审查这段 diff，输出结构化问题列表：文件/行号/问题/严重级别/修改建议"
- 把 AI 审查结论贴到 MR 描述里，作为评审依据

**方式 B：CI 自动化（标准做法）**

在 GitLab CI / GitHub Actions 里加一个 job：

```yaml
# MR 触发时自动运行 AI 审查
ai-review:
  only:
    - merge_requests
  script:
    - git diff origin/main...HEAD > diff.txt
    - python ai_review.py --diff diff.txt --rules refactor-pattern.md
```

`ai_review.py` 的核心逻辑：

```python
# 读取 diff 与项目规范，调用大模型审查
prompt = f"""
你是代码审查员。对照以下项目规范审查 diff：
【规范】
{open("refactor-pattern.md").read()}
【diff】
{diff}
输出 JSON 数组，每项包含：file、line、issue、severity（blocker/warning）、suggestion。
只报告违反规范或有明确缺陷的问题，不要风格偏好类意见。
"""
# 调用大模型 API，解析结构化输出
# severity 为 blocker 时，脚本以非零状态退出，CI 失败，MR 无法合并
```

审查结果自动评论到 MR 上，blocker 级别直接阻断合并。

**方式 C：pre-commit 本地钩子（更早拦截）**
- 在 `.git/hooks` 或 husky 里挂脚本，提交前对暂存区变更跑一遍审查
- 适合规范类检查（命名、目录结构），不适合深度逻辑审查

### 3. 自动化测试兜底

AI 审查解决"符合规范"，测试解决"行为不变"：

- 重构前给旧页面补**快照测试 / 关键交互单测**，作为回归基线
- 改造后跑同一套测试，行为不一致即打回
- 这就是简历里"结合自动化测试保障改造质量"的含义

## 误报处理

- AI 审查误报率高是常态，所以卡点结论**不直接拒绝**，而是分级：blocker 阻断、warning 人工判断
- 维护一份白名单（已确认的误报模式），迭代进 Prompt
- 人工抽检比例：比如每 10 个 MR 抽查 2 个，验证 AI 审查质量
