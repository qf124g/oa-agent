import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 始终读取 agent-server 目录下的 .env，避免受启动时工作目录影响
const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDir, '../.env') });

// 服务配置：大模型接入参数 + 端口 + 平台后端地址 + RAG 参数
export const config = {
  // OpenAI 兼容端点（阿里云百炼 DashScope 兼容模式）
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'qwen-plus',
  // Embedding 模型（用于 RAG 知识库向量化）
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
  port: Number(process.env.PORT || 3002),
  // 平台后端地址（Node.js 后端）
  platformApiBase: process.env.PLATFORM_API_BASE || 'http://localhost:8080',
  // RAG 检索返回的文本块数量
  knowledgeTopK: Number(process.env.KNOWLEDGE_TOP_K || 4),
  // 领域事件内部回调密钥（backend → agent-server 的 /internal/events 鉴权）
  internalSecret: process.env.INTERNAL_SECRET || 'dev-internal-secret',
};