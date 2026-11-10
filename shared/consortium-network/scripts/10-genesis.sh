#!/usr/bin/env bash
# 生成 QBFT 创世文件 + 4 套节点密钥。
# 命令与参数逐字依据 docs/private-networks/reference/subcommands.md（2026-10-14）。
# 用法：bash scripts/10-genesis.sh [输出目录]
set -euo pipefail
OUT="${1:-./networkFiles}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$SRC/genesis/qbftConfigFile.json"

command -v besu >/dev/null 2>&1 || { echo "需要先装 besu（见 scripts/00-preflight.sh 的下载与校验步骤）"; exit 1; }

if [ ! -f "$CFG" ]; then
  echo "找不到 $CFG —— 先从模板复制并填好 admin 地址与链 ID："
  echo "  cp genesis/qbftConfigFile.json.tpl genesis/qbftConfigFile.json"
  exit 1
fi
grep -q "REPLACE_ADMIN_ADDRESS" "$CFG" && echo "⚠️  alloc 里还是占位符地址，生成出来的链将没有预存账户（零 gas 网络下不影响发交易，但影响需要余额的场景）"

rm -rf "$OUT"
echo "+ besu operator generate-blockchain-config --config-file=$CFG --to=$OUT --genesis-file-name=genesis.json --private-key-file-name=key --public-key-file-name=key.pub"
besu operator generate-blockchain-config \
  --config-file="$CFG" \
  --to="$OUT" \
  --genesis-file-name=genesis.json \
  --private-key-file-name=key \
  --public-key-file-name=key.pub

echo
echo "产物："
ls -1 "$OUT" 2>/dev/null | sed 's/^/  /'
echo "  $OUT/keys/<address>/key        各验证者节点私钥（一台一份，拷到对应主机 /etc/besu/key）"
echo "  $OUT/keys/<address>/key.pub    公钥 → 拼 enode://<64位hex>@<ip>:30303 用"
echo "  $OUT/genesis.json              已自动写入 extraData（不要手填）"

chmod 700 "$OUT" 2>/dev/null || true
find "$OUT" -name key -exec chmod 600 {} \; 2>/dev/null || true

cat <<'EOF'

下一步：
  1) 把 genesis.json 里的 chainId / alloc 再核一遍（生成器不会替你决定链 ID）
  2) 收集 4 个节点的 enode URL → 填进 config/*.toml 的 bootnodes 与 permissions_config.toml
  3) 单机验证：bash scripts/20-up-docker.sh   ｜  多机部署：见 README §三
私钥处理守则：只在生成机与目标主机之间存在，不进 git、不进镜像层、不打日志。
EOF
