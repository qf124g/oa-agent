// 故障测试：验证「写成功但响应超时 → 同一幂等键重试命中回执，不重复落库」
// 前置：backend 需以 SLOW_WRITE_MS=12000 启动（大于脚本的 10s 客户端超时）
//   cd backend && SLOW_WRITE_MS=12000 npm run dev
// 运行：node scripts/fault-test.mjs

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const DB_FILE = join(__dirname, '..', 'data', 'store.db');

async function main() {
  // 1. 登录拿 token（seed 账号 admin / 123456）
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  if (login.code !== 0) throw new Error(`登录失败: ${JSON.stringify(login)}`);
  const token = login.data.token;

  // 2. 唯一标题 + 固定幂等键（模拟 agent 的 confirmId）
  const title = `故障测试-${Date.now()}`;
  const key = randomUUID();

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Idempotency-Key': key,
  };

  // 3. 第一次写：客户端 10s 超时，后端 SLOW_WRITE_MS=12000 延迟响应 → 客户端超时，但后端已落库
  let firstTimedOut = false;
  try {
    await fetch(`${BASE}/api/todos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    firstTimedOut = err && err.name === 'TimeoutError';
  }

  // 4. 第二次写：同一幂等键，命中回执立即返回（replayed=true，不重复落库）
  const secondRes = await fetch(`${BASE}/api/todos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title }),
  });
  const second = await secondRes.json();

  // 5. 直接读库，展示最终数据库结果
  const db = new Database(DB_FILE, { readonly: true });
  const todoRows = db.prepare(`SELECT id, data FROM todos WHERE data LIKE ?`).all(`%${title}%`);
  const idemRows = db.prepare(`SELECT key FROM idempotency WHERE key = ?`).all(key);
  db.close();

  // 6. 打印结论
  console.log('=== 故障测试结果 ===');
  console.log(`第一次请求是否超时：${firstTimedOut ? '是（TimeoutError）' : '否'}`);
  console.log(`第二次请求 code：${second.code}（0=成功，回放首次结果）`);
  console.log(`todos 表中「${title}」记录数：${todoRows.length}（期望 1）`);
  console.log(`idempotency 表中该 key 记录数：${idemRows.length}（期望 1）`);
  console.log(`最终待办标题：${todoRows.map((r) => JSON.parse(r.data).title).join('、') || '(无)'}`);

  const pass = firstTimedOut && second.code === 0 && todoRows.length === 1 && idemRows.length === 1;
  console.log(pass ? '结论：PASS —— 超时后按同一幂等键重试，最终只落库一次' : '结论：FAIL —— 见上方字段');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
