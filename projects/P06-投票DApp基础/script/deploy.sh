#!/usr/bin/env bash
# 多网络 profile 部署器（P04/P05 同款）。用法：bash script/deploy.sh <anvil|sepolia|consortium> [--dry-run]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${1:?用法: deploy.sh <anvil|sepolia|consortium> [--dry-run]}"
MODE="${2:-}"
ENV_FILE="env/${PROFILE}.env"
[ -f "$ENV_FILE" ] || { echo "没有 $ENV_FILE"; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export NETWORK_PROFILE RPC_URL CHAIN_ID EXPLORER_URL EXPLORER_VERIFY GAS_MODE

if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  if [ "$PROFILE" = "consortium" ]; then
    echo "✗ consortium 拒绝回落到根 .env（那是公链真钱包）。请显式给一次性 key。"
    exit 1
  fi
  [ -f ../../.env ] && { set -a; source ../../.env; set +a; }
fi

SENDER_ARGS=()
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ] && [ "$PROFILE" = "anvil" ]; then
  SENDER_ARGS=(--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked)
  echo "   anvil 解锁账户 0xf39F…2266 + --unlocked（零私钥）"
fi

echo "== profile=$PROFILE  rpc=$RPC_URL  chainId=$CHAIN_ID  gas=$GAS_MODE =="

if [ "$PROFILE" = "consortium" ]; then
  export FOUNDRY_PROFILE=consortium
  export EVM_VERSION_RECORD=london
fi

forge build --quiet
echo "✓ 编译完成"

if [ "$MODE" = "--dry-run" ]; then
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" -vv
  exit 0
fi

ARGS=(script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast --slow -vv "${SENDER_ARGS[@]}")
if [ "${GAS_MODE:-auto}" = "zero" ]; then
  ARGS+=(--legacy --gas-price 0)
elif [ "${GAS_MODE:-auto}" = "legacy" ]; then
  ARGS+=(--legacy)
fi

forge script "${ARGS[@]}"

# ABI 自动下发前端（禁止手抄）：frontend 直接 import abi/Voting.json
mkdir -p abi
forge inspect Voting abi --json > abi/Voting.json
forge inspect Voting bytecode --json > abi/Voting.bytecode.json
forge inspect Voting methodIdentifiers --json > abi/Voting.selectors.json
echo "✓ ABI 已导出到 abi/Voting.json"
echo "✓ 部署记录：deployments/${CHAIN_ID}/Voting.json 与 deployments/latest.json"