import OpenAI from 'openai';
import { config } from '../config';

// OpenAI 客户端（OpenAI 兼容协议，embedding 复用同一 baseURL/key）
const client = new OpenAI({
  baseURL: config.openaiBaseUrl,
  apiKey: config.openaiApiKey,
});

// 将单段文本向量化，返回浮点向量
export async function embedText(text: string): Promise<number[]> {
  const resp = await client.embeddings.create({
    model: config.embeddingModel,
    input: text,
  });
  return resp.data[0].embedding;
}