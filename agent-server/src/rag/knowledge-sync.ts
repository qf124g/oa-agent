import { createHash } from 'node:crypto';
import { config } from '../config';
import { embedText } from './embedding';
import { chunkText } from './chunker';
import { VectorIndex, type SearchHit } from './vector-index';
import { expandQueryWithSynonyms, reloadSynonyms, type SynonymSource } from './synonym-dict';

// 知识库向量索引：文档 source of truth 在平台后端，此处维护内存向量索引
// 主文档与 FAQ 分属两个独立索引；同义词走查询改写词典（不向量化）。
// 按需（首次检索前 / 写操作后）与后端同步：文档/FAQ 按 contentHash 增量更新，词典整表热加载。

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  category: string;
}

// 后端已审核公开的 FAQ 条目
export interface FaqSource {
  id: string;
  question: string;
  answer: string | null;
}

// 一次同步携带的完整数据包（文档 + 同义词 + FAQ）
export interface KnowledgeBundle {
  docs: KnowledgeDocument[];
  synonyms: SynonymSource[];
  faqs: FaqSource[];
}

const index = new VectorIndex(); // 主文档索引
const faqIndex = new VectorIndex(); // 独立 FAQ 索引
let synced = false;

function contentHash(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex');
}

// 拉取后端全量文档（含正文）
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

// 拉取后端已审核公开的同义词词典
async function fetchSynonyms(token: string): Promise<SynonymSource[]> {
  const res = await fetch(`${config.platformApiBase}/api/knowledge/synonyms`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`同义词同步失败（HTTP ${res.status}）`);
  const json = (await res.json()) as { code: number; message: string; data: SynonymSource[] };
  if (json.code !== 0) throw new Error(json.message || '同义词同步失败');
  return json.data || [];
}

// 拉取后端已审核公开的 FAQ
async function fetchFaqs(token: string): Promise<FaqSource[]> {
  const res = await fetch(`${config.platformApiBase}/api/knowledge/faqs`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`FAQ 同步失败（HTTP ${res.status}）`);
  const json = (await res.json()) as { code: number; message: string; data: FaqSource[] };
  if (json.code !== 0) throw new Error(json.message || 'FAQ 同步失败');
  return json.data || [];
}

// 主文档增量同步：新增/变更重新向量化，删除的从索引移除
async function reconcileDocs(docs: KnowledgeDocument[]): Promise<void> {
  for (const doc of docs) {
    const hash = contentHash(doc.content);
    if (index.isFresh(doc.id, hash)) continue;
    const chunks = await embedDocument(doc);
    index.upsert(doc.id, hash, chunks);
  }
  const currentIds = new Set(docs.map((d) => d.id));
  for (const docId of [...index.docIds()]) {
    if (!currentIds.has(docId)) index.remove(docId);
  }
}

// FAQ 独立索引增量同步：问题（或答案）作为可检索文本，category 固定 user_faq 与主文档隔离
async function reconcileFaqs(faqs: FaqSource[]): Promise<void> {
  for (const f of faqs) {
    const text = f.answer?.trim() ? f.answer : f.question;
    const hash = contentHash(text);
    if (faqIndex.isFresh(f.id, hash)) continue;
    const chunks = await embedDocument({ id: f.id, title: f.question, content: text, category: 'user_faq' });
    faqIndex.upsert(f.id, hash, chunks);
  }
  const currentIds = new Set(faqs.map((f) => f.id));
  for (const docId of [...faqIndex.docIds()]) {
    if (!currentIds.has(docId)) faqIndex.remove(docId);
  }
}

// 应用同步包：主文档 + FAQ + 同义词词典热加载
async function applyBundle(bundle: KnowledgeBundle): Promise<void> {
  await reconcileDocs(bundle.docs);
  await reconcileFaqs(bundle.faqs);
  reloadSynonyms(bundle.synonyms);
  synced = true;
}

// 同步（拉取路径）：从后端拉全量数据后增量重建（聊天时兜底）
export async function ensureSynced(token: string): Promise<void> {
  const [docs, synonyms, faqs] = await Promise.all([
    fetchAllDocuments(token),
    fetchSynonyms(token),
    fetchFaqs(token),
  ]);
  await applyBundle({ docs, synonyms, faqs });
}

// 同步（事件路径）：backend 写操作后推送全量数据，立即实时重建
export async function syncFromEvent(bundle: KnowledgeBundle): Promise<void> {
  await applyBundle(bundle);
}

// 单篇文档分块并逐块向量化（主文档与 FAQ 复用）
async function embedDocument(doc: KnowledgeDocument) {
  const texts = chunkText(doc.content);
  const chunks = [];
  for (const text of texts) {
    const vector = await embedText(text);
    chunks.push({ docTitle: doc.title, docCategory: doc.category, text, vector });
  }
  return chunks;
}

// 搜索：主文档索引 + 独立 FAQ 索引合并，命中经同义词词典扩展后检索
export async function searchKnowledge(query: string, token: string, topK = config.knowledgeTopK): Promise<SearchHit[]> {
  if (!synced) await ensureSynced(token);
  const expanded = expandQueryWithSynonyms(query);
  const queryVector = await embedText(expanded);
  const docHits = index.search(queryVector, topK);
  const faqHits = faqIndex.search(queryVector, topK);
  return [...docHits, ...faqHits].sort((a, b) => b.score - a.score).slice(0, topK);
}

// 写操作（新增/删除文档）后调用：标记索引待同步，下次检索前重新同步
export function invalidateIndex(): void {
  synced = false;
}

// ---------------------------------------------------------------------------
// 用户问题沉淀通道：采集用户原始提问，聚合计数达到阈值后提交为 FAQ 候选（待审核）
// 治理链路：agent-server 只负责清洗 + 上报候选；审核与准入由后端完成，未审核不进检索
// ---------------------------------------------------------------------------

const userQuestionCount = new Map<string, number>();
const reportedQuestions = new Set<string>();

function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

// 采集用户原始问题（在 search_knowledge 检索改写前调用）。
// 计数达到阈值后提交为 FAQ 候选（PENDING），同一问题仅提交一次。
export function collectUserQuery(rawQuery: string, token: string): void {
  const q = normalizeQuestion(rawQuery);
  if (!q) return;
  const next = (userQuestionCount.get(q) ?? 0) + 1;
  userQuestionCount.set(q, next);
  if (next < config.faqThreshold || reportedQuestions.has(q)) return;
  reportedQuestions.add(q);
  void submitFaqCandidate(rawQuery, token);
}

// 提交 FAQ 候选：清洗后的问题 + 来源标记，后端落库为 PENDING 待审核
async function submitFaqCandidate(question: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${config.platformApiBase}/api/knowledge/faqs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Source': 'agent',
      },
      body: JSON.stringify({ question, source: 'user_query' }),
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => null)) as { code: number; message: string } | null;
    if (json && json.code === 0) {
      console.log(`[knowledge] 用户问题「${question}」达 ${config.faqThreshold} 次，已提交为 FAQ 候选待审核`);
    }
  } catch (err) {
    console.error(`[knowledge] FAQ 候选提交失败：${question}`, err);
  }
}
