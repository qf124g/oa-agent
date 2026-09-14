---
name: 报销汇总
description: 汇总用户的报销申请数据并进行金额统计
---

## 步骤
1. 调用 get_my_approvals 查询当前用户的报销（EXPENSE）申请列表。
2. 将返回的报销明细整理为 items 数组，每一项包含 type（类型）与 amount（金额）两个字段。
3. 调用 run_skill_script 执行本地汇总脚本，参数为：
   - skillId: expense-report
   - script: summarize-expense.mjs
   - args: { items: [...] }
4. 根据脚本返回的笔数、总金额与按类型分组的统计结果，用列表向用户汇报。