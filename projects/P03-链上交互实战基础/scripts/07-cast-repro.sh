#!/usr/bin/env bash
# 验收项：能手工用 cast 复现其中一笔转账（不依赖 ethers 脚本）。
# 用法：bash scripts/07-cast-repro.sh
# 私钥从本项目 .env 读（环境变量传递，不进命令行参数——ps/history 看不到）。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] || { echo "缺 .env：先跑 node scripts/01-new-wallet.mjs"; exit 1; }
set -a; source .env; set +a

RPC="${RPC:-http://127.0.0.1:8551}"
echo "== cast 手工复现：LEARNER → PAYEE 1 B03（legacy + gasPrice 0）=="
# --legacy 必须：零 gas 链上 EIP-1559 费用估算会给出 1 wei 的下限（B04 实测教训）
OUT=$(cast send --rpc-url "$RPC" --private-key "$LEARNER_PK" \
  --legacy --gas-price 0 --gas-limit 21000 \
  --value 1ether "$PAYEE_ADDRESS" --json)
HASH=$(node -e "console.log(JSON.parse(process.argv[1]).transactionHash)" "$OUT")
echo "tx=$HASH"
echo
node scripts/06-parse-tx.mjs "$HASH" "T8 · cast 手工复现的原生转账（1 B03）"