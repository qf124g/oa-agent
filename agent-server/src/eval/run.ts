import { config } from '../config';
import { resolveUser } from '../auth';
import { runEvalCase, type EvalResult } from './runner';
import { EVAL_CASES } from './cases';

// 评测 CLI：离线批量运行评测集。
// 用法：
//   EVAL_TOKEN=<token> npm run eval
//   或 npm run eval -- <token>
// 可选：EVAL_AUTO_APPROVE=true 自动同意写操作确认（默认 false，写用例自动取消、不落库）。

async function main(): Promise<void> {
  // Node 版本守卫：auth.ts / executor.ts 依赖全局 fetch（Node 18+），过低会静默失败并误报「token 无效」
  if (typeof fetch !== 'function') {
    console.error('[eval] 当前 Node 版本过低（缺少全局 fetch），评测需要 Node >= 18。请先执行：nvm use 20');
    process.exit(1);
  }

  if (!config.openaiApiKey) {
    console.error('[eval] 启动失败：未配置 OPENAI_API_KEY。请复制 agent-server/.env.example 为 agent-server/.env 并填入真实 Key。');
    process.exit(1);
  }

  const token = process.env.EVAL_TOKEN || process.argv[2] || '';
  if (!token) {
    console.error('[eval] 请通过环境变量 EVAL_TOKEN 或第一个命令行参数提供平台登录 token（Bearer 后的部分）。');
    process.exit(1);
  }

  const user = await resolveUser(token);
  if (!user) {
    console.error('[eval] token 无效或平台后端未启动，无法解析当前用户。请确认 backend 已运行且 token 有效。');
    process.exit(1);
  }

  const autoApprove = process.env.EVAL_AUTO_APPROVE === 'true';
  console.log(`[eval] 评测用户：${user.name}（${user.role}），autoApprove=${autoApprove}\n`);

  let passed = 0;
  for (const caseDef of EVAL_CASES) {
    const result = await runEvalCase(caseDef, { token, user, autoApprove });
    if (result.passed) passed++;
    printResult(result);
  }

  console.log(`\n[eval] 结果：${passed}/${EVAL_CASES.length} 通过`);
  process.exit(passed === EVAL_CASES.length ? 0 : 1);
}

function printResult(r: EvalResult): void {
  const status = r.passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${r.caseId} ${r.name}`);
  console.log(`  期望工具: ${r.expectedTools.join(', ') || '(无)'}`);
  console.log(`  实际工具: ${r.toolsCalled.join(', ') || '(无)'}`);
  if (r.keywordsMiss.length > 0) console.log(`  缺失关键词: ${r.keywordsMiss.join('、')}`);
  if (r.error) console.log(`  错误: ${r.error}`);
  const answer = r.finalAnswer.length > 200 ? `${r.finalAnswer.slice(0, 200)}…` : r.finalAnswer;
  console.log(`  回答: ${answer || '(空)'}`);
  console.log('');
}

main().catch((err) => {
  console.error('[eval] 运行失败：', err);
  process.exit(1);
});