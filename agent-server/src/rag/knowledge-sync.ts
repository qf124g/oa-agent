import { createHash } from 'node:crypto';
import { config } from '../config';
import { embedText } from './embedding';
import { chunkText } from './chunker';
import { VectorIndex, type SearchHit } from './vector-index';

// 知识库向量索引：文档 source of truth 在平台后端，此处维护内存向量索引
// 按需（首次检索前 / 写操作后）与平台后端同步，按 contentHash 做文档级增量更新

interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  category: string;
}

const index = new VectorIndex();
// 是否已完成过一次全量同步（进程内幂等，避免每次检索都全量拉取）
let synced = false;

// 计算文档正文的内容哈希
function contentHash(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex');
}

// 从平台后端拉取全量文档（含正文）
async function fetchAllDocuments(token: string): Promise<KnowledgeDocument[]> {
  const res = await fetch(`${config.platformApiBase}/api/knowledge/full`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`知识库同步失败（HTTP ${res.status}）`);
  const json = (await res.json()) as { code: number; message: string; data: KnowledgeDocument[] };
  if (json.code !== 0) throw new Error(json.message || '知识库同步失败');
  return json.data || [];
}

// 同步向量索引：新增/变更的文档重新向量化，被删除的文档从索引移除
export async function ensureSynced(token: string): Promise<void> {
  const docs = await fetchAllDocuments(token);
  for (const doc of docs) {
    const hash = contentHash(doc.content);
    if (index.isFresh(doc.id, hash)) continue;
    const chunks = await embedDocument(doc);
    index.upsert(doc.id, hash, chunks);
  }
  // 删除后端已不存在的文档
  const currentIds = new Set(docs.map((d) => d.id));
  for (const docId of [...index.docIds()]) {
    if (!currentIds.has(docId)) index.remove(docId);
  }
  synced = true;
}

// 单篇文档分块并逐块向量化
async function embedDocument(doc: KnowledgeDocument) {
  const texts = chunkText(doc.content);
  const chunks = [];
  for (const text of texts) {
    const vector = await embedText(text);
    chunks.push({ docTitle: doc.title, docCategory: doc.category, text, vector });
  }
  return chunks;
}

// 搜索知识库：首次调用前强制同步一次，之后仅写操作后会触发增量同步
export async function searchKnowledge(query: string, token: string, topK = config.knowledgeTopK): Promise<SearchHit[]> {
  if (!synced) await ensureSynced(token);
  const queryVector = await embedText(query);
  return index.search(queryVector, topK);
}

// 写操作（新增/删除文档）后调用：标记索引待同步，下次检索前重新同步
export function invalidateIndex(): void {
  synced = false;
}