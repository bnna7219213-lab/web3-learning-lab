#!/usr/bin/env bash
# 起本地私有 PoS 网。先跑 00-preflight.sh。
# 用法：bash scripts/10-up-local.sh [enclave名] [配置文件]
set -uo pipefail
ENCLAVE="${1:-my-testnet}"
ARGS="${2:-network_params/minimal-2nodes.yaml}"
PKG="github.com/ethpandaops/ethereum-package"

command -v kurtosis >/dev/null 2>&1 || { echo "缺 kurtosis，先跑 scripts/00-preflight.sh"; exit 1; }
[ -f "$ARGS" ] || { echo "找不到配置 $ARGS（请在项目根目录执行）"; exit 1; }

grep -q "giant issue aisle" "$ARGS" && {
  echo "⚠️  配置里仍是 README 公开的默认测试助记词。"
  echo "   本机演示可以接受；任何能被外部访问的网络都必须换掉（见 README §五 红线 1）。"
}

echo "→ kurtosis run --enclave $ENCLAVE $PKG --args-file $ARGS"
kurtosis run --enclave "$ENCLAVE" "$PKG" --args-file "$ARGS" || { echo "起网失败：看上面最后 20 行，通常是镜像拉取超时或磁盘不足"; exit 1; }

echo
echo "== 服务与端口 =="
kurtosis enclave inspect "$ENCLAVE"

cat <<'EOF'

下一步：
  bash scripts/20-rpc-check.sh            # 验证链 ID / 高度 / 最终性
  kurtosis service shell <enclave> geth   # 进容器看客户端日志
  kurtosis enclave rm -f <enclave>        # 拆网（enclave 会一直驻留直到显式删除）
EOF
