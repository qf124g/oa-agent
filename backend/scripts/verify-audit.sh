#!/bin/bash
# FAQ 审核流程验证脚本：覆盖 提交→待审→通过/驳回→权限→同义词增删 全链路
# 用法：bash backend/scripts/verify-audit.sh
BASE=http://localhost:8080
# 提取 JSON 字段的辅助函数
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

ADMIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"123456"}' | J "d['data']['token']")
EMP=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"zhangwei","password":"123456"}' | J "d['data']['token']")

echo "===== 1. 提交候选 A（将审核通过） ====="
A=$(curl -s -X POST "$BASE/api/knowledge/faqs" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"question":"如何申请年假？","source":"user_query"}')
echo "$A"
AID=$(echo "$A" | J "d['data']['id']")

echo ""
echo "===== 2. 提交候选 B（将驳回） ====="
B=$(curl -s -X POST "$BASE/api/knowledge/faqs" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"question":"测试驳回问题","source":"user_query"}')
echo "$B"
BID=$(echo "$B" | J "d['data']['id']")

echo ""
echo "===== 3. 审核前：默认列表（应不含 A/B） ====="
curl -s "$BASE/api/knowledge/faqs" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 4. 审核前：status=PENDING（应含 A/B） ====="
curl -s "$BASE/api/knowledge/faqs?status=PENDING" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 5. 普通员工查 PENDING（应 403 拒绝） ====="
curl -s "$BASE/api/knowledge/faqs?status=PENDING" -H "Authorization: Bearer $EMP"
echo ""

echo ""
echo "===== 6. 通过候选 A ====="
curl -s -X POST "$BASE/api/knowledge/faqs/$AID/approve" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 7. 驳回候选 B ====="
curl -s -X DELETE "$BASE/api/knowledge/faqs/$BID" -H "Authorization: Bearer $ADMIN"
echo ""

echo ""
echo "===== 8. 审核后：默认列表（应含 A 且 APPROVED） ====="
curl -s "$BASE/api/knowledge/faqs" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 9. 审核后：status=PENDING（应为空） ====="
curl -s "$BASE/api/knowledge/faqs?status=PENDING" -H "Authorization: Bearer $ADMIN"
echo ""

echo ""
echo "===== 10. 同义词：新增「打车」 ====="
S=$(curl -s -X POST "$BASE/api/knowledge/synonyms" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"term":"打车","synonyms":["叫车","出租车"]}')
echo "$S"
SID=$(echo "$S" | J "d['data']['id']")

echo "===== 11. 同义词列表（应含新增「打车」） ====="
curl -s "$BASE/api/knowledge/synonyms" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 12. 同义词：删除「打车」 ====="
curl -s -X DELETE "$BASE/api/knowledge/synonyms/$SID" -H "Authorization: Bearer $ADMIN"
echo ""

echo "===== 13. 同义词列表（应恢复为 3 条 seed） ====="
curl -s "$BASE/api/knowledge/synonyms" -H "Authorization: Bearer $ADMIN"
echo ""
