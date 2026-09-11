import { config } from './config';

// 鉴权透传：拿到前端 Bearer token 后调后端 GET /api/auth/me 校验并取当前用户
// 返回已解析的当前用户信息；token 无效时返回 null

export interface CurrentUser {
  userId: string;
  userNo: string;
  name: string;
  role: 'ADMIN' | 'EMPLOYEE';
  departmentId: string;
  departmentName: string;
  title: string;
}

// 从请求头解析 Bearer token
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

// 校验 token 并返回当前用户（无效返回 null）
export async function resolveUser(token: string): Promise<CurrentUser | null> {
  try {
    const res = await fetch(`${config.platformApiBase}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code: number; message: string; data: CurrentUser | null };
    if (json.code !== 0 || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}