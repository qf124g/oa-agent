// 内存向量索引：按文档 id 组织文本块与向量，支持余弦相似度 top-k 检索
// 文档级增量更新：以 contentHash 判断文档是否变化，只重建变化的文档

export interface ChunkEntry {
  docId: string;
  docTitle: string;
  docCategory: string;
  text: string;
  vector: number[];
}

export interface SearchHit {
  docId: string;
  docTitle: string;
  docCategory: string;
  text: string;
  score: number;
}

export class VectorIndex {
  private entries: ChunkEntry[] = [];
  // 已建索引文档的内容哈希：docId -> contentHash
  private hashes = new Map<string, string>();

  // 是否已为某文档建立最新索引
  isFresh(docId: string, contentHash: string): boolean {
    return this.hashes.get(docId) === contentHash;
  }

  // 替换某文档的全部向量块
  upsert(docId: string, contentHash: string, chunks: { docTitle: string; docCategory: string; text: string; vector: number[] }[]): void {
    this.remove(docId);
    this.hashes.set(docId, contentHash);
    for (const c of chunks) {
      this.entries.push({
        docId,
        docTitle: c.docTitle,
        docCategory: c.docCategory,
        text: c.text,
        vector: c.vector,
      });
    }
  }

  // 移除某文档的全部向量块
  remove(docId: string): void {
    this.entries = this.entries.filter((e) => e.docId !== docId);
    this.hashes.delete(docId);
  }

  // 当前索引中存在的文档 id 集合（用于识别被删除的文档）
  docIds(): Set<string> {
    return new Set(this.hashes.keys());
  }

  // 余弦相似度 top-k 检索
  search(queryVector: number[], topK: number): SearchHit[] {
    const scored: SearchHit[] = this.entries.map((e) => ({
      docId: e.docId,
      docTitle: e.docTitle,
      docCategory: e.docCategory,
      text: e.text,
      score: cosine(queryVector, e.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

// 计算两个向量的余弦相似度
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}