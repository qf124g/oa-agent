#!/usr/bin/env node
// AI Review 卡点脚本（方案 B：CI 自动化）
// 职责：取 git diff + 项目规范 + 误报白名单 → 调大模型审查 → 结构化输出 → blocker 阻断合并
//
// 用法：
//   node scripts/ai-review.mjs                  CI 模式：审查 origin/main...HEAD 的已提交变更
//   node scripts/ai-review.mjs --working        本地模式：审查工作区相对 HEAD 的全部变更（含未提交）
//   node scripts/ai-review.mjs --base <ref>     指定对比基线，如 --base origin/dev
//
// 环境变量：
//   OPENAI_API_KEY   必填（未设置时自动读取 agent-server/.env）
//   OPENAI_BASE_URL  可选，默认阿里云百炼兼容端点
//   OPENAI_MODEL     可选，默认 qwen3.8-max
//   GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_EVENT_PATH  齐全时自动把结果评论到 PR
//
// 退出码：0 = 通过（无问题或仅 warning）；1 = 存在 blocker 或脚本执行失败

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 审查标尺：项目级 AI 开发规范
const RULES_FILE = path.join(ROOT, 'documents/AI辅助开发规范.md');
// 误报白名单：已确认的误报模式，命中则不报告
const WHITELIST_FILE = path.join(ROOT, 'scripts/ai-review-whitelist.md');
// 本地运行时密钥来源（与 agent-server 共用同一份 .env）
const ENV_FILE = path.join(ROOT, 'agent-server/.env');
// diff 送入大模型的最大字符数，超出截断并在 prompt 中注明
const MAX_DIFF_CHARS = 120000;
// 敏感文件路径模式：命中则不送入大模型，直接提示人工处理（防止密钥随审查外发）
const SENSITIVE_PATTERNS = [/\.env(\.|$)/, /\.pem$/, /\.key$/, /secrets?\//i, /credential/i];
// diff 内容级敏感模式：普通文件里内嵌的密钥/凭证同样禁止外发（值长阈值过滤演示数据短密码）
// 高置信度模式：直接扫原始行，不做任何剔除，防止凭证借模板插值剔除绕过检测
const SENSITIVE_HIGH_CONFIDENCE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[A-Z0-9]{12,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];
// 赋值类模式：易与变量引用（process.env.X / ${X}）误报冲突，剔除变量引用片段后再检测
const SENSITIVE_ASSIGNMENT_PATTERNS = [
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9+/_.-]{20,}['"]?/i,
  /Bearer\s+[A-Za-z0-9._-]{24,}/,
];

// ---------- 参数解析 ----------

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { working: false, base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--working') opts.working = true;
    else if (argv[i] === '--base') opts.base = argv[++i];
  }
  return opts;
}

// ---------- 配置加载 ----------

// 环境变量优先；未设置 OPENAI_API_KEY 时从 agent-server/.env 读取
// 只注入审查脚本需要的三个键，不扩散 .env 中的其他变量
function loadConfig() {
  const wanted = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
  if (!process.env.OPENAI_API_KEY && existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!wanted.includes(key) || process.env[key]) continue;
      process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('缺少 OPENAI_API_KEY：请设置环境变量或在 agent-server/.env 中配置');
    process.exit(1);
  }
  return {
    apiKey,
    // 阿里云百炼兼容模式公开端点（与 agent-server/src/config.ts 默认值一致），可用 OPENAI_BASE_URL 覆盖
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
    model: process.env.OPENAI_MODEL || 'qwen3.8-max',
  };
}

// ---------- git diff 获取 ----------

// 统一加 -c core.quotepath=false，避免中文文件名被转义成八进制引号形式
// maxBuffer 放大到 64MB，防止大 diff 超过默认 1MB 缓冲导致 execFileSync 失败
function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// 取变更文件列表与完整 diff；--working 对比工作区（含未跟踪新文件），否则用三点语法取分支增量
function getDiff(opts) {
  if (!opts.working) {
    const range = [`${opts.base}...HEAD`];
    const files = git(['diff', '--name-only', ...range]).split('\n').filter(Boolean);
    return { files, diff: git(['diff', ...range]) };
  }
  const files = git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  let diff = git(['diff', 'HEAD']);
  // git diff 不含未跟踪文件，逐个用 --no-index 生成 diff 补入（node_modules 已被 .gitignore 排除）
  // 空设备按平台选择：Windows 为 NUL，类 Unix 为 /dev/null
  const emptyDevice = os.platform() === 'win32' ? 'NUL' : '/dev/null';
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  for (const f of untracked) {
    files.push(f);
    try {
      execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-index', '--', emptyDevice, f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      // --no-index 有差异时退出码为 1，diff 内容在 stdout；其他错误直接抛出，不静默吞掉
      if (err.status !== 1) throw err;
      diff += `\n${err.stdout ?? ''}`;
    }
  }
  return { files, diff };
}

// 纯文档变更（md/txt/documents 目录）不在代码审查范围
function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => /\.(md|txt)$/.test(f) || f.startsWith('documents/'));
}

// 命中敏感文件（密钥/凭证）时阻断：这类变更必须人工处理，不允许送入大模型
function findSensitiveFiles(files) {
  return files.filter((f) => SENSITIVE_PATTERNS.some((re) => re.test(f)));
}

// 扫描实际送入大模型的完整 diff（含新增、上下文与删除行）中的敏感片段，返回命中的模式描述
// 高置信度模式扫原始行（不剔除，防绕过）；赋值类模式先剔除变量引用片段再检测，避免脚本自身源码误报
function findSensitiveContent(diff) {
  const hits = [];
  for (const line of diff.split('\n')) {
    // 跳过 diff 元信息行（文件头/索引），只查内容行
    if (/^(diff --git|index |---|\+\+\+) /.test(line)) continue;
    for (const re of SENSITIVE_HIGH_CONFIDENCE_PATTERNS) {
      if (re.test(line)) hits.push(re.source);
    }
    const stripped = line
      .replace(/process\.env\.[A-Za-z_][A-Za-z0-9_]*/g, '')
      .replace(/\$\{[^}]*\}/g, '');
    for (const re of SENSITIVE_ASSIGNMENT_PATTERNS) {
      if (re.test(stripped)) hits.push(re.source);
    }
  }
  return [...new Set(hits)];
}

// ---------- 大模型调用 ----------

function buildPrompt(diff, truncated) {
  const rules = readFileSync(RULES_FILE, 'utf8');
  const whitelist = readFileSync(WHITELIST_FILE, 'utf8');
  return `【项目规范】
${rules}

【已确认的误报白名单（命中以下模式一律不报告）】
${whitelist}

【待审查的 git diff】
${diff}
${truncated ? '（注意：diff 过长已截断，仅审查以上内容）' : ''}

【输出要求】
- 只输出一个 JSON 对象，不要输出任何其他文字、不要用代码块包裹
- 结构：{"issues":[{"file":"文件路径","line":行号,"severity":"blocker或warning","issue":"问题描述","suggestion":"修改建议"}]}
- severity 判定：blocker = 明确缺陷、安全漏洞、严重违反项目规范，必须阻断合并；warning = 疑似问题，需人工判断
- file 和 line 必须指向 diff 中新增或修改的行
- 只报告违反规范或有明确缺陷的问题，不要风格偏好类意见
- 没有问题时输出 {"issues":[]}`;
}

// 流式请求大模型并累积完整回复文本。
// 用流式而非一次性返回：审查耗时长，非流式要等模型生成完才回响应头，
// 会超过内置 fetch（undici）的响应头超时；流式下响应头立即返回，规避该限制。
// 整体超时 8 分钟：模型服务无响应时快速失败，不长期阻塞 CI。
async function callLLM(config, prompt) {
  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8 * 60 * 1000),
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        stream: true,
        messages: [
          { role: 'system', content: '你是严格的代码审查员，依据项目规范审查 git diff，输出结构化 JSON 结论。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (err) {
    // 网络层失败：打印底层 cause（DNS/超时/连接重置），方便区分环境问题与代码问题
    throw new Error(`请求大模型失败：${err.message}${err.cause ? `（${err.cause.message || err.cause.code}）` : ''}`);
  }
  if (!res.ok) {
    throw new Error(`大模型接口 ${res.status}: ${await res.text()}`);
  }

  // 解析 SSE 流：按行切分，累积 delta.content；buffer 保留跨 chunk 的不完整尾行
  let content = '';
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    const parsed = JSON.parse(payload);
    content += parsed.choices?.[0]?.delta?.content ?? '';
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);
  return content;
}

// 解析模型输出：剥掉可能的代码块包裹后取首个 JSON 对象
// changedFiles 用于校验模型幻觉：指向非变更文件的问题降级为 warning，不允许以 blocker 阻断合并
function parseIssues(raw, changedFiles) {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`模型输出不是 JSON：${raw.slice(0, 200)}`);
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const fileSet = new Set(changedFiles);
  // 字段规范化：severity 只认 blocker / warning；行号非正整数标记为未知行；未知文件的问题降级为 warning
  return issues.map((it) => {
    const line = Number(it.line);
    const file = String(it.file ?? '未知文件');
    const knownFile = fileSet.has(file);
    const severity = it.severity === 'blocker' && knownFile ? 'blocker' : 'warning';
    return {
      file,
      line: Number.isInteger(line) && line > 0 ? line : 0,
      severity,
      issue: String(it.issue ?? '') + (knownFile ? '' : '（注：文件不在本次变更列表中，已降级为 warning）'),
      suggestion: String(it.suggestion ?? ''),
    };
  });
}

// ---------- 结果输出 ----------

function printReport(issues) {
  const blockers = issues.filter((i) => i.severity === 'blocker');
  const warnings = issues.filter((i) => i.severity === 'warning');
  console.log(`\nAI Review 结果：${blockers.length} 个 blocker，${warnings.length} 个 warning`);
  for (const it of issues) {
    console.log(`\n[${it.severity}] ${it.file}${it.line > 0 ? `:${it.line}` : ''}`);
    console.log(`  问题：${it.issue}`);
    if (it.suggestion) console.log(`  建议：${it.suggestion}`);
  }
  if (issues.length === 0) console.log('未发现问题，审查通过');
  return { blockers, warnings };
}

// CI 环境（GITHUB_TOKEN + PR 事件）时把结果评论到 PR
async function commentOnPR(issues) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !existsSync(GITHUB_EVENT_PATH)) return;
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
  const prNumber = event.pull_request?.number;
  if (!prNumber) return;

  // 表格单元格转义：竖线会破坏表格结构，换行替换为空格
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = issues.map((it) => {
    const location = it.line > 0 ? `\`${it.file}:${it.line}\`` : `\`${it.file}\``;
    return `| ${it.severity} | ${location} | ${cell(it.issue)} | ${cell(it.suggestion)} |`;
  });
  const body = [
    '## AI Review 审查结果',
    '',
    issues.length === 0
      ? '未发现问题，审查通过。'
      : `| 级别 | 位置 | 问题 | 建议 |\n|---|---|---|---|\n${lines.join('\n')}`,
    '',
    '> 由 AI Review 卡点自动生成（scripts/ai-review.mjs），blocker 将阻断合并，warning 请人工判断。',
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    console.error(`PR 评论失败（${res.status}）：${await res.text()}`);
    return;
  }
  console.log(`\n审查结果已评论到 PR #${prNumber}`);
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs();
  const { files, diff } = getDiff(opts);

  if (!diff) {
    console.log('没有可审查的变更，跳过');
    return;
  }
  // 敏感文件（密钥/凭证）不允许送入大模型，直接阻断要求人工处理
  const sensitive = findSensitiveFiles(files);
  if (sensitive.length > 0) {
    console.error(`变更包含敏感文件，禁止送入大模型审查，请人工处理：\n${sensitive.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  // diff 内容里内嵌的密钥/凭证同样禁止外发（扫描实际送入模型的完整 diff）
  const sensitiveHits = findSensitiveContent(diff);
  if (sensitiveHits.length > 0) {
    console.error(`diff 内容疑似包含密钥/凭证，禁止送入大模型审查，请人工脱敏后重试：\n${sensitiveHits.map((s) => `  - ${s}`).join('\n')}`);
    process.exit(1);
  }
  if (isDocsOnly(files)) {
    console.log(`变更仅涉及文档（${files.length} 个文件），跳过代码审查`);
    return;
  }

  const config = loadConfig();
  const truncated = diff.length > MAX_DIFF_CHARS;
  const prompt = buildPrompt(truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, truncated);

  console.log(`审查 ${files.length} 个变更文件（diff ${diff.length} 字符），模型 ${config.model} ...`);
  const raw = await callLLM(config, prompt);
  const issues = parseIssues(raw, files);
  const { blockers } = printReport(issues);
  await commentOnPR(issues);

  if (blockers.length > 0) {
    console.log(`\n存在 ${blockers.length} 个 blocker，审查不通过`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('AI Review 执行失败：', err.message);
  process.exit(1);
});
