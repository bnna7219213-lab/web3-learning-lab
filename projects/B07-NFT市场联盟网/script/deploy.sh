#!/usr/bin/env bash
# B07 部署器（联盟网 profile）
# 用法：bash script/deploy.sh [consortium] [--dry-run]
#
# 联盟网三条硬规矩（B04/P07 实测踩出来的）：
#  1. 必须 FOUNDRY_PROFILE=consortium（london）：genesis 只开到 london，用 cancun 会发 PUSH0，
#     部署交易**进块但 status=0**、gas 全烧光——看起来"部署成功"其实没生效。
#  2. 必须 --legacy --gas-price 0：零 gas 网络。
#  3. 必须显式 --gas-limit：成员账户余额为 0，eth_estimateGas 会以"余额不足"直接失败，
#     gas 估算这一步过不去 → 用固定上限跳过估算。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${1:-consortium}"
MODE="${2:-}"
ENV_FILE="env/${PROFILE}.env"
[ -f "$ENV_FILE" ] || { echo "没有 $ENV_FILE"; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export NETWORK_PROFILE RPC_URL CHAIN_ID EXPLORER_URL EXPLORER_VERIFY GAS_MODE PER_TX_GAS_LIMIT

LOCAL_ENV="env/.env.local"
if [ -f "$LOCAL_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; source "$LOCAL_ENV"; set +a
fi

if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  DEPLOYER_PRIVATE_KEY="${ISSUER_PRIVATE_KEY:-}"
  export DEPLOYER_PRIVATE_KEY
fi
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "✗ 没有 DEPLOYER_PRIVATE_KEY / ISSUER_PRIVATE_KEY。请在 $LOCAL_ENV 里放一次性成员私钥（该文件不入库）。"
  exit 1
fi

export FOUNDRY_PROFILE=consortium
export EVM_VERSION_RECORD=london

echo "== profile=$PROFILE  rpc=$RPC_URL  chainId=$CHAIN_ID  gas=$GAS_MODE  evm=london =="

forge build --quiet
echo "✓ 编译完成（london 指令集）"

if [ "$MODE" = "--dry-run" ]; then
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" -vv
  exit 0
fi

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --broadcast --slow -vv \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --legacy --gas-price 0 --gas-limit "$PER_TX_GAS_LIMIT"

# ABI 自动下发前端（禁手抄）
mkdir -p abi
forge inspect LabCredential abi --json > "abi/LabCredential.json"
forge inspect LabCredential methodIdentifiers --json > "abi/LabCredential.selectors.json"
echo "✓ ABI 已导出：abi/LabCredential.json"
echo "✓ 部署记录：deployments/${CHAIN_ID}/B07.json 与 deployments/latest.json"
echo "ℹ 成员白名单默认空：发行前先用 setMember 登记成员（见 scripts/02-members-transfer.sh）"
