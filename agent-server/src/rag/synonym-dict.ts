// 查询改写同义词词典：内存热加载，不向量化。
// 数据源为后端已审核公开的同义词条目，随知识库同步事件整表替换。

export interface SynonymSource {
  term: string;
  synonyms: string[];
}

let dict = new Map<string, string[]>();

// 热加载：整表替换词典（后端同步事件携带已审核条目）
export function reloadSynonyms(entries: SynonymSource[]): void {
  const next = new Map<string, string[]>();
  for (const e of entries) {
    next.set(e.term, e.synonyms);
  }
  dict = next;
}

// 用词典对 query 做同义扩展：命中主词时，把未出现的同义词并入 query，提高不同表述的召回
export function expandQueryWithSynonyms(query: string): string {
  const extra: string[] = [];
  for (const [term, synonyms] of dict) {
    if (!query.includes(term)) continue;
    for (const s of synonyms) {
      if (!query.includes(s) && !extra.includes(s)) extra.push(s);
    }
  }
  if (extra.length === 0) return query;
  return `${query} ${extra.join(' ')}`;
}
