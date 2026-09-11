import { randomUUID } from 'node:crypto';
import type { AuthUser } from './types';

// token 有效期：24 小时
const TOKEN_TTL_MILLIS = 24 * 60 * 60 * 1000;

interface Entry {
  user: AuthUser;
  expireAt: number;
}

// 内存 token 存储：token -> (用户信息 + 过期时间)
class TokenStore {
  private tokens = new Map<string, Entry>();

  // 签发 token（demo 使用 UUID，未引入 JWT）
  issue(user: AuthUser): string {
    const token = randomUUID().replace(/-/g, '');
    this.tokens.set(token, { user, expireAt: Date.now() + TOKEN_TTL_MILLIS });
    return token;
  }

  // 校验 token，有效返回用户，无效返回 null
  resolve(token: string | null | undefined): AuthUser | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expireAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry.user;
  }
}

export const tokenStore = new TokenStore();