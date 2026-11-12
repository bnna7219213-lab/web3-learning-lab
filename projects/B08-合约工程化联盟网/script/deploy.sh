#!/usr/bin/env bash
# B08 联盟网部署器（沿用 P05/P08 设计：编译 profile 与网络 profile 分两层）。
# 用法：bash script/deploy.sh <consortium|anvil|sepolia> [--dry-run]
#
# 联盟网三条硬规矩（B07 踩出来的）：
#   1. 零 gas：legacy + 显式 gas-price 0（forge 的 EIP-1559 估算会给 1 wei 下限）
#   2. 编译必须 london（consortium profile）：cancun 字节码含 PUSH0 → 部署 status=0
#   3. 私钥走环境变量而非 --private-key（命令行参数会进 ps/历史）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${1:?用法: deploy.sh <consortium|anvil|sepolia> [--dry-run]}"
MODE="${2:-}"
ENV_FILE="env/${PROFILE}.env"
[ -f "$ENV_FILE" ] || { echo "没有 $ENV_FILE（可选：consortium / anvil / sepolia）"; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export NETWORK_PROFILE RPC_URL CHAIN_ID EXPLORER_URL EXPLORER_VERIFY GAS_MODE

# consortium 不回落根 .env（那是公链真钱包身份）
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  if [ "$PROFILE" = "consortium" ]; then
    echo "✗ consortium 拒绝回落到根 .env。请显式给一次性 key："
    echo "    export DEPLOYER_PRIVATE_KEY=<env/.env.local 里的某成员私钥>"
    exit 1
  fi
  [ -f ../../.env ] && { set -a; source ../../.env; set +a; }
fi

echo "== profile=$PROFILE  rpc=$RPC_URL  chainId=$CHAIN_ID  gas=$GAS_MODE =="

if [ "$PROFILE" = "consortium" ]; then
  export FOUNDRY_PROFILE=consortium
  export EVM_VERSION_RECORD=london
  echo "   FOUNDRY_PROFILE=consortium（evm_version=london，避开 PUSH0）"
fi

forge build --quiet
echo "✓ 编译完成"

if [ "$MODE" = "--dry-run" ]; then
  echo "（dry-run：只模拟不上链）"
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" -vv
  exit 0
fi

ARGS=(script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast --slow -vv)
if [ "${GAS_MODE:-auto}" = "zero" ]; then
  ARGS+=(--legacy --gas-price 0)
elif [ "${GAS_MODE:-auto}" = "legacy" ]; then
  ARGS+=(--legacy)
fi

forge script "${ARGS[@]}"

mkdir -p abi
for C in MerkleAirdrop GasLab Create2Factory; do
  forge inspect "$C" abi --json > "abi/${C}.json"
done
echo "✓ ABI 已导出到 abi/（前端直接读，别手抄）"
echo "✓ 部署记录：deployments/${CHAIN_ID}/all.json 与 deployments/latest.json"
echo "→ 升级演练：bash scripts/07-upgrade-drill.js（全成员参与窗口）"
