import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { config } from '../config';

// Query 改写客户端：复用 OpenAI 兼容端点与密钥（与主模型一致）
const client = new OpenAI({
  baseURL: config.openaiBaseUrl,
  apiKey: config.openaiApiKey,
});

// 疑似依赖上下文/指代的词：命中才调用改写，否则直接用原 query 检索，避免每次检索都额外一次 LLM 调用
const REWRITE_TRIGGER = /它|他|她|这个|那个|这些|那些|都|还有|其他|别的|上次|刚才|上一条/;

// 多意图触发：至少两个问号，或存在顿号/分号分隔的多个问句
const MULTI_INTENT_TRIGGER = /[?？].*[?？]|[、；;].*[?？]/;

// 将对话历史序列化为「用户/助手」文本，仅取最近若干轮，供改写时补全指代与省略内容
export function formatHistoryForRewrite(history: ChatCompletionMessageParam[], maxTurns = 4): string {
  const lines: string[] = [];
  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content) {
      lines.push(`用户: ${msg.content}`);
    } else if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
      lines.push(`助手: ${msg.content}`);
    }
  }
  return lines.slice(-maxTurns * 2).join('\n');
}

// 检索前改写：把当前问题中的指代词/省略内容补全为独立完整问题；无需改写时原样返回
export async function rewriteQueryForSearch(query: string, historyText: string): Promise<string> {
  if (!REWRITE_TRIGGER.test(query)) return query;
  const prompt = [
    '你是一个查询改写助手。请结合对话历史，把「当前问题」中的指代词（如"它/这个/都/还有"）和省略内容补全成独立、完整、适合知识库检索的问题。',
    '只返回改写后的问题本身，不要任何解释或额外文字；若无需改写，直接原样返回当前问题。',
    '',
    '### 对话历史 ###',
    historyText || '（无）',
    '',
    '### 当前问题 ###',
    query,
  ].join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
    const rewritten = resp.choices[0]?.message?.content?.trim();
    return rewritten || query;
  } catch {
    // 改写失败不阻断检索，退回原 query
    return query;
  }
}

// 多意图问题拆分为多个独立子问题；非多意图返回空数组，由调用方保持单查询
export async function splitMultiIntentQuery(query: string): Promise<string[]> {
  if (!MULTI_INTENT_TRIGGER.test(query)) return [];
  const prompt = [
    '把下面的复杂问题拆分成多个独立的、可以单独检索答案的子问题。',
    '仅返回 JSON 字符串数组，例如：["子问题1","子问题2"]；若只有一个问题，返回只含原问题的数组。',
    '',
    '### 原始问题 ###',
    query,
  ].join('\n');
  try {
    const resp = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
    const text = resp.choices[0]?.message?.content?.trim() || '';
    // 剥离可能包裹的 ```json 代码块标记
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      const subs = arr.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
      return subs.length > 1 ? subs : [];
    }
    return [];
  } catch {
    return [];
  }
}