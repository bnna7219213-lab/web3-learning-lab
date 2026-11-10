#!/usr/bin/env bash
# 链健康检查：只用标准 JSON-RPC 方法（eth_chainId / eth_blockNumber / eth_getBlockByNumber）。
# 用法：RPC=http://127.0.0.1:PORT bash scripts/20-rpc-check.sh
#   RPC 地址来自：kurtosis enclave inspect <enclave>（EL 服务的 forwarded URL）
set -uo pipefail
RPC="${RPC:-http://127.0.0.1:8545}"
EXPECT_CHAIN_ID="${EXPECT_CHAIN_ID:-3151908}"

call() { # method [params-json]
  curl -s -m 8 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "$RPC"
}
result() { sed -n 's/.*"result":"\([^"]*\)".*/\1/p'; }
num_of() { sed -n 's/.*"number":"\([^"]*\)".*/\1/p'; }
dec()    { echo "$((16#${1#0x}))"; }

echo "== 目标 RPC：$RPC =="

chain=$(call eth_chainId | result)
if [ -z "$chain" ]; then
  echo "✗ 取不到 eth_chainId —— RPC 未起或端口不对。先跑：kurtosis enclave inspect <enclave>"
  exit 1
fi
if [ "$(dec "$chain")" = "$EXPECT_CHAIN_ID" ]; then
  echo "✓ eth_chainId      $chain = $(dec "$chain")（与配置一致）"
else
  echo "⚠️ eth_chainId     $chain = $(dec "$chain")，与期望 $EXPECT_CHAIN_ID 不符（配置没生效？连到别的网了？）"
fi

h1=$(call eth_blockNumber | result)
sleep 13   # 默认 seconds_per_slot=12，等一个 slot 以上
h2=$(call eth_blockNumber | result)
if [ "$h1" != "$h2" ]; then
  echo "✓ 出块             $(dec "$h1") → $(dec "$h2")（在增长）"
else
  echo "✗ 出块             停在 $(dec "$h1")：13 秒无新块，验证者大概率没跑起来（看 VC 日志）"
fi

# 最终性：EL 侧标准做法是块标签 "safe" / "finalized"（不是某个 getFinalized 方法）
latest=$(call eth_getBlockByNumber '"latest",false'   | num_of)
safe=$(call eth_getBlockByNumber '"safe",false'       | num_of)
finalized=$(call eth_getBlockByNumber '"finalized",false' | num_of)
if [ -n "$finalized" ]; then
  echo "✓ 最终性           latest=$(dec "$latest") safe=$(dec "${safe:-0}") finalized=$(dec "$finalized")"
  echo "                   滞后 $(( $(dec "$latest") - $(dec "$finalized") )) 个区块（约 2 个 epoch 是正常量级）"
else
  echo "✗ 最终性           取不到 finalized 块：链还没最终化任何东西（起网不足 ~13 分钟属正常，再等）"
fi

echo
echo "== 暴露面自查（公网部署必做）=="
if echo "$RPC" | grep -qE "127\.0\.0\.1|localhost"; then
  echo "✓ RPC 指向本机回环"
else
  echo "⚠️ RPC 非回环地址：确认防火墙已按 scripts/30-firewall.sh 限制来源"
fi
if command -v ss >/dev/null 2>&1; then
  leaked=0
  for p in 8545 8546 5052 9090 3500; do
    ss -ltn 2>/dev/null | grep -qE "0\.0\.0\.0:$p |\*:$p " && { echo "✗ 端口 $p 监听 0.0.0.0（RPC/指标/签名接口不该对全网开放）"; leaked=1; }
  done
  [ "$leaked" = 0 ] && echo "✓ 未发现 RPC/指标端口对全网监听"
else
  echo "（无 ss 命令，跳过端口检查）"
fi
