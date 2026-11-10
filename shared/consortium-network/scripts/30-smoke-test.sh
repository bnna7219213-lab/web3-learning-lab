#!/usr/bin/env bash
# 冒烟测试：验证「这是一条真的 QBFT 联盟链」而不是一个单机假链。
# 用法：RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh
set -uo pipefail
RPC="${RPC:-http://127.0.0.1:8545}"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1（期望 $3，实际 $2）"; fail=$((fail+1)); fi; }
say() { echo "  · $1"; }
call() { curl -s -m 8 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "$RPC"; }
res() { sed -n 's/.*"result":"\([^"]*\)".*/\1/p'; }
hex2dec() { echo "$((16#${1#0x}))"; }

echo "== Besu QBFT 联盟链冒烟：$RPC =="

raw=$(call eth_chainId); chain=$(echo "$raw" | res)
[ -n "$chain" ] || { echo "  ✗ 连不上 RPC，终止"; exit 1; }
say "chainId = $chain ($(hex2dec "$chain"))"

# 1) 出块在推进
h1=$(call eth_blockNumber | res); sleep 7; h2=$(call eth_blockNumber | res)
if [ "$h1" != "$h2" ]; then echo "  ✓ 出块推进 $(hex2dec "$h1") → $(hex2dec "$h2")（blockperiodseconds=5）"; pass=$((pass+1));
else echo "  ✗ 7 秒无新块：验证者没组起来（查 bootnodes/enode/防火墙）"; fail=$((fail+1)); fi

# 2) peer 数：只有 1 个节点时这条必失败 —— 这正是"单机假链"与"联盟网"的区别
peers=$(call net_peerCount | res)
if [ -n "$peers" ]; then pd=$((16#${peers#0x})); else pd=0; fi
if [ "$pd" -ge 1 ]; then echo "  ✓ net_peerCount = $pd（已连上其他节点）"; pass=$((pass+1));
else echo "  ✗ net_peerCount = 0：节点之间没连上，检查 bootnodes 的 enode 公钥与 IP:端口"; fail=$((fail+1)); fi

# 3) 零 gas 三件套是否真的生效
gp=$(call eth_gasPrice | res); gpd=$(hex2dec "${gp:-0x0}")
chk "eth_gasPrice 为 0（free gas）" "$gpd" "0"

# 4) baseFee 为 0（London + zeroBaseFee=true 的证据）
bf=$(call eth_getBlockByNumber '"latest",false' | sed -n 's/.*"baseFeePerGas":"\([^"]*\)".*/\1/p')
chk "latest.baseFeePerGas 为 0" "$(hex2dec "${bf:-0x0}")" "0"

# 5) 验证者集合：qbft_getValidatorsByBlockNumber（键名 QBFT 已在 rpc-http-api 中开放）
vals=$(call qbft_getValidatorsByBlockNumber '"latest"' | sed -n 's/.*"result":\(\[[^]]*\]\).*/\1/p')
n=$(echo "$vals" | grep -o '0x[0-9a-fA-F]\{40\}' | wc -l | tr -d ' ')
chk "QBFT 验证者数量" "$n" "4"

# 6) 块常量（Post-Merge 要求，写错会生成非法块）
mix=$(call eth_getBlockByNumber '"latest",false' | sed -n 's/.*"mixHash":"\([^"]*\)".*/\1/p')
diff=$(call eth_getBlockByNumber '"latest",false' | sed -n 's/.*"difficulty":"\([^"]*\)".*/\1/p')
say "mixHash=${mix:-?} difficulty=${diff:-?}（Merge 后 difficulty 必须为 0x0）"

# 7) 零余额账户能发交易（tx-pool-enable-balance-check=false 的效果）
if command -v cast >/dev/null 2>&1; then
  say "手工验证：用无余额账户签一笔 0 gasPrice 交易 → eth_sendRawTransaction 应成功"
  say "  cast wallet new 生成一次性账户；cast send --rpc-url $RPC --gas-price 0 ..."
else
  say "（未装 foundry，跳过发交易验证）"
fi

echo
echo "== 通过 $pass · 失败 $fail =="
[ "$fail" = 0 ] || echo "失败项排查见 docs/02-零gas与交易池配置.md 与 docs/03-成员接入与权限治理.md"
exit $((fail > 0))
