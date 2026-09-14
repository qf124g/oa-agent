import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 技能注册表：扫描 agent-server/skills/ 目录，解析各技能的 SKILL.md，
// 供模型通过 use_skill 读取步骤、run_skill_script 执行本地计算脚本。

// 技能定义：id 为目录名，name/description 取自 SKILL.md frontmatter，body 为步骤说明
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

// 脚本执行结果统一结构
export interface SkillScriptResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');

// 技能 ID 仅允许字母/数字/下划线/连字符；脚本名严格限定白名单，阻断路径穿越
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const SCRIPT_NAME_RE = /^[A-Za-z0-9_-]+\.mjs$/;

let cache: Map<string, Skill> | null = null;

// 扫描 skills/ 目录：每个子目录即一个技能
function scanSkills(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  let entries: Dirent<string>[] = [];
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_NAME_RE.test(entry.name)) continue;
    const skill = parseSkill(entry.name);
    if (skill) map.set(skill.id, skill);
  }
  return map;
}

// 解析单个技能的 SKILL.md：frontmatter（name/description）+ 正文步骤
function parseSkill(id: string): Skill | null {
  const file = join(SKILLS_DIR, id, 'SKILL.md');
  try {
    const raw = readFileSync(file, 'utf8');
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    const front = m?.[1] ?? '';
    const body = (m?.[2] ?? raw).trim();
    const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? id;
    const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
    return { id, name, description, body };
  } catch {
    return null;
  }
}

function allSkills(): Map<string, Skill> {
  if (!cache) cache = scanSkills();
  return cache;
}

// 按 id 取技能正文
export function getSkill(id: string): Skill | null {
  return allSkills().get(id) ?? null;
}

// 生成注入 system prompt 的技能清单：名称 + 一句话说明，供模型判断是否触发技能
export function getSkillOverview(): string {
  const list = [...allSkills().values()];
  if (list.length === 0) return '';
  const lines = list.map((s) => `- ${s.id}：${s.description}`);
  return ['', '可用技能（当用户任务与技能描述匹配时，先调用 use_skill 读取步骤）：', ...lines].join('\n');
}

// 执行技能脚本：仅在 skills/<id>/scripts/ 白名单内动态 import，脚本导出 default 或 run 函数
export async function runSkillScript(skillId: string, scriptName: string, args: unknown): Promise<SkillScriptResult> {
  if (!SAFE_NAME_RE.test(skillId)) return { ok: false, error: '非法技能 ID' };
  if (!SCRIPT_NAME_RE.test(scriptName) || basename(scriptName) !== scriptName) {
    return { ok: false, error: '非法脚本名' };
  }
  const scriptPath = join(SKILLS_DIR, skillId, 'scripts', scriptName);
  if (!existsSync(scriptPath)) return { ok: false, error: `脚本不存在: ${skillId}/${scriptName}` };
  try {
    const mod = (await import(pathToFileURL(scriptPath).href)) as { default?: unknown; run?: unknown };
    const fn = (mod.default ?? mod.run) as ((a: unknown) => unknown) | undefined;
    if (typeof fn !== 'function') return { ok: false, error: '脚本未导出 default 或 run 函数' };
    const result = await fn(args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: `脚本执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}