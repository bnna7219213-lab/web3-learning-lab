#!/usr/bin/env bash
# P08 多网络部署器（沿用 P04/P05 设计：编译 profile 与网络 profile 分两层）。
# 用法：bash script/deploy.sh <anvil|sepolia|consortium> [--dry-run]
#
# 私钥走环境变量而非 --private-key：命令行参数会进 ps 输出与 shell history。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${1:?用法: deploy.sh <anvil|sepolia|consortium> [--dry-run]}"
MODE="${2:-}"
ENV_FILE="env/${PROFILE}.env"
[ -f "$ENV_FILE" ] || { echo "没有 $ENV_FILE（可选：anvil / sepolia / consortium）"; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export NETWORK_PROFILE RPC_URL CHAIN_ID EXPLORER_URL EXPLORER_VERIFY GAS_MODE

# consortium 不回落根 .env（根 .env 是公链真钱包身份）——与 P05 同款防线
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  if [ "$PROFILE" = "consortium" ]; then
    echo "✗ consortium 拒绝回落到根 .env（那是公链真钱包）。请显式给一次性 key："
    echo "    export DEPLOYER_PRIVATE_KEY=\$(cast wallet new --json | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>console.log(JSON.parse(d)[0].private_key))')"
    exit 1
  fi
  [ -f ../../.env ] && { set -a; source ../../.env; set +a; }
fi
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "⚠️ 没有 DEPLOYER_PRIVATE_KEY：将用 forge 默认账户（只有 anvil 能用这条路径）"
fi

# anvil 无私钥路径：0 号账户是节点解锁账户，--unlocked 走 eth_sendTransaction
SENDER_ARGS=()
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ] && [ "$PROFILE" = "anvil" ]; then
  SENDER_ARGS=(--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked)
  echo "   anvil 解锁账户 0xf39F…2266 + --unlocked（零私钥）"
fi

echo "== profile=$PROFILE  rpc=$RPC_URL  chainId=$CHAIN_ID  gas=$GAS_MODE =="

# 联盟网 genesis 只到 London：cancun 字节码含 PUSH0 会部署 status=0（B04 实测）
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

ARGS=(script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast --slow -vv "${SENDER_ARGS[@]}")
# 零 gas 链必须 legacy + 显式 0：forge 的 EIP-1559 估算会给 1 wei 下限（B04 教训）
if [ "${GAS_MODE:-auto}" = "zero" ]; then
  ARGS+=(--legacy --gas-price 0)
elif [ "${GAS_MODE:-auto}" = "legacy" ]; then
  ARGS+=(--legacy)
fi

forge script "${ARGS[@]}"

mkdir -p abi
for C in MerkleAirdrop GasLab; do
  forge inspect "$C" abi --json > "abi/${C}.json"
  forge inspect "$C" methodIdentifiers --json > "abi/${C}.selectors.json"
done
echo "✓ ABI 已导出到 abi/"
echo "✓ 部署记录：deployments/${CHAIN_ID}/ 与 deployments/latest.json"
echo "→ 代理升级演练：见 README §升级演练（script/Upgrade.s.sol 两步）"
