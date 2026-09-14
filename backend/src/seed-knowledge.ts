import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store';
import { extractTextFromBuffer } from './extract-text';
import type { KnowledgeDocument } from './types';

// seed 目录：backend/seed/knowledge（相对源码目录上跳一级）
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, '..', 'seed', 'knowledge');
// 支持的文件扩展名
const SUPPORTED_EXTS = /\.(pdf|md|txt)$/i;
// 演示账号：seed 文档统一归类到人事专员李娜
const SEED_UPLOADER = 'E003';

// 从 seed 目录加载知识库文档：NN-title.ext -> id=K0NN、title=title，按 id upsert 进 store（PDF 更新后重启即可生效）
export async function loadKnowledgeSeed(): Promise<void> {
  const files = readSeedFiles();
  const now = Date.now();
  for (const file of files) {
    const meta = parseFileName(file);
    if (!meta) continue;
    const buffer = readFileSync(join(SEED_DIR, file));
    const content = await extractTextFromBuffer(buffer, file);
    if (!content.trim()) continue;
    const doc: KnowledgeDocument = {
      id: meta.id,
      title: meta.title,
      content,
      category: '制度',
      uploadedBy: SEED_UPLOADER,
      createdAt: now,
      updatedAt: now,
      uploadedByName: store.employeeName(SEED_UPLOADER),
    };
    store.knowledgeDocs.set(doc.id, doc);
  }
  // 注入固定 id 后刷新 idSeq，避免后续 nextId('K') 与 seed id 冲突
  store.syncIdSeq();
}

function readSeedFiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(SEED_DIR);
  } catch {
    return [];
  }
  return names.filter((n) => SUPPORTED_EXTS.test(n)).sort();
}

// 解析文件名：NN-title.ext -> { id: 'K0NN', title: 'title' }
function parseFileName(name: string): { id: string; title: string } | null {
  const stem = name.replace(SUPPORTED_EXTS, '');
  const m = /^(\d{2})-(.+)$/.exec(stem);
  if (!m || !m[2].trim()) return null;
  return { id: `K0${m[1]}`, title: m[2].trim() };
}