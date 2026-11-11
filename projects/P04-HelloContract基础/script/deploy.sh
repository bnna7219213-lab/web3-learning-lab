#!/usr/bin/env bash
# 多网络 profile 部署器。
# 用法：bash script/deploy.sh <anvil|sepolia|consortium> [--dry-run]
#
# 为什么私钥走环境变量而不是 --private-key：命令行参数会出现在 ps 输出与 shell history 里，
# 环境变量不会。Deploy.s.sol 用 vm.envOr("DEPLOYER_PRIVATE_KEY") 读取，正是为此。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${1:?用法: deploy.sh <anvil|sepolia|consortium> [--dry-run]}"
MODE="${2:-}"
ENV_FILE="env/${PROFILE}.env"
[ -f "$ENV_FILE" ] || { echo "没有 $ENV_FILE（可选：anvil / sepolia / consortium）"; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export NETWORK_PROFILE RPC_URL CHAIN_ID EXPLORER_URL EXPLORER_VERIFY GAS_MODE

# profile 里没写私钥时，回落到仓库根 .env（该文件已被 .gitignore 排除）。
# 但 consortium 不回落：根 .env 里躺的是**公链真钱包**的 key，拿它去部署教学链等于
# 把生产身份公开挂在演示链上（地址、nonce 轨迹、与真实资产的关联全暴露）。
# 演示链就该用一次性 key，现场生成：
#   export DEPLOYER_PRIVATE_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  if [ "$PROFILE" = "consortium" ]; then
    echo "✗ consortium 拒绝回落到根 .env（那是公链真钱包）。请显式给一次性 key："
    echo "    export DEPLOYER_PRIVATE_KEY=\$(cast wallet new --json | jq -r '.[0].private_key')"
    exit 1
  fi
  [ -f ../../.env ] && { set -a; source ../../.env; set +a; }
fi
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "⚠️ 没有 DEPLOYER_PRIVATE_KEY：将用 forge 默认账户（只有 anvil 能用这条路径）"
fi

# anvil 无私钥路径（2026-11-11 补，与 P05 一致）：forge 默认 sender 0x1804… 不在 anvil 账户表里，
# 直接广播会被拒；改用节点解锁的 0 号账户 + --unlocked 走 eth_sendTransaction，全程零私钥。
SENDER_ARGS=()
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ] && [ "$PROFILE" = "anvil" ]; then
  SENDER_ARGS=(--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked)
  echo "   anvil 解锁账户 0xf39F…2266 + --unlocked（零私钥）"
fi

echo "== profile=$PROFILE  rpc=$RPC_URL  chainId=$CHAIN_ID  gas=$GAS_MODE =="

# 编译 profile 与网络 profile 对齐：联盟网是 London 级链，用 cancun 字节码会因 PUSH0 而部署失败。
# 复用 default 的 solc/optimizer 等设置，只覆盖 evm_version（Foundry 的 profile 继承 default）。
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
# 联盟链零 gas：必须 legacy + 显式 0。
# 2026-10-16 实测：只给 `--gas-price 0` 不够——forge 仍按 EIP-1559 发，并把
# maxFeePerGas/maxPriorityFeePerGas 定在 1 wei（它不接受 0 的费用估算）。结果交易
# gasPrice=0x1、需要 505440 wei 手续费，而部署账户余额 0；又因为节点开了
# tx-pool-enable-balance-check=false，这笔"永远付不起"的交易照样进了交易池，
# 于是拿到 hash、receipt 却永远是 null——docs/02 里预言的"静默消失"以另一种方式发生了。
# --legacy 强制走老式交易，gasPrice 才真的是 0。
if [ "${GAS_MODE:-auto}" = "zero" ]; then
  ARGS+=(--legacy --gas-price 0)
elif [ "${GAS_MODE:-auto}" = "legacy" ]; then
  ARGS+=(--legacy)
fi

forge script "${ARGS[@]}"

# ABI 自动下发前端：合约变更 → 前端不需要手抄 ABI（对齐 lainchain 的 deploy.js 做法）
mkdir -p abi
forge inspect Counter abi --json > abi/Counter.json
forge inspect Counter bytecode --json > abi/Counter.bytecode.json
forge inspect Counter methodIdentifiers --json > abi/Counter.selectors.json
echo "✓ ABI 已导出到 abi/Counter.json（前端直接 import，别手抄）"
echo "✓ 部署记录：deployments/${CHAIN_ID}/Counter.json 与 deployments/latest.json"

if [ "${EXPLORER_VERIFY:-false}" = "true" ] && [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  echo "→ 尝试在浏览器 verify（已配 ETHERSCAN_API_KEY）"
  forge verify-contract --chain-id "$CHAIN_ID" --watch \
    "$(node -p "require('./deployments/${CHAIN_ID}/Counter.json').address")" src/Counter.sol:Counter \
    || echo "verify 失败（不阻塞部署）：检查 API key 与合约源码是否含中文注释"
else
  echo "ℹ 跳过 verify：无公网浏览器时，用 deployments/*.json 的 deployedBytecodeHash 自证（B04 场景）"
fi
