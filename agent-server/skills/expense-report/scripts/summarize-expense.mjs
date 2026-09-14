// 报销汇总脚本：统计笔数、总金额，并按类型分组求和
// 导出签名 (args) => result，供 run_skill_script 本地执行，不发后端请求
export default function summarizeExpense(args) {
  const items = Array.isArray(args && args.items) ? args.items : [];
  const byType = {};
  let total = 0;
  for (const item of items) {
    const type = item && item.type ? String(item.type) : '其他';
    const amount = Number(item && item.amount) || 0;
    total += amount;
    byType[type] = (byType[type] || 0) + amount;
  }
  const roundedByType = {};
  for (const [type, sum] of Object.entries(byType)) {
    roundedByType[type] = Number(sum.toFixed(2));
  }
  return {
    count: items.length,
    total: Number(total.toFixed(2)),
    byType: roundedByType,
  };
}