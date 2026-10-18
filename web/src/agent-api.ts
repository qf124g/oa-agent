import { AGENT_SERVER_URL, TOKEN_KEY } from './constants';

// agent-server 统一响应结构（与 backend 的 ok/fail 同构）
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

// 读取本地 token 并构造鉴权头
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// 解包统一响应：401 清 token，业务失败抛错
async function unpack<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
  }
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
  }
  if (json.code !== 0) {
    throw new Error(json.message || '请求失败');
  }
  return json.data;
}

// agent-server 通用请求封装：自动附带 Bearer token、解 envelope，业务失败抛错
async function agentRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(AGENT_SERVER_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unpack<T>(res);
}

export function agentGet<T>(path: string): Promise<T> {
  return agentRequest<T>('GET', path);
}

export function agentPost<T>(path: string, body?: unknown): Promise<T> {
  return agentRequest<T>('POST', path, body);
}

// 时间戳格式化为 YYYY-MM-DD HH:mm:ss
export function formatDateTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}