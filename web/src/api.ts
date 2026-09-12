import { API_BASE, TOKEN_KEY } from './constants';

// 平台后端统一响应结构
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

// 通用请求封装：自动附带 Bearer token、解 envelope，业务失败抛错
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unpack<T>(res);
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

// 文件上传：multipart（不手动设 Content-Type，浏览器自动带 boundary）
export async function apiUpload<T>(path: string, file: File, extra?: Record<string, string>): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) fd.append(k, v);
    }
  }
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  return unpack<T>(res);
}