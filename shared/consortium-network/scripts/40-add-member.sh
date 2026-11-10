#!/usr/bin/env bash
# 新成员接入：收集 enode → 加白名单 → 热加载 → 验证同步。
# 用法：bash scripts/40-add-member.sh <enode URL> <成员名>
#   enode 由成员自己生成：besu public-key export --to=/opt/besu/nodekey 后拼
#   enode://<64位hex>@<成员IP>:30303
set -euo pipefail
ENODE="${1:?用法: 40-add-member.sh <enode://...> <成员名>}"
NAME="${2:?缺成员名}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERM="$SRC/config/permissions_config.toml"
RPC="${RPC:-http://127.0.0.1:8545}"

grep -q "nodes-allowlist" "$PERM" || { echo "白名单文件异常：$PERM"; exit 1; }
if grep -qF "$ENODE" "$PERM"; then echo "⚠️ 该 enode 已在白名单，跳过"; exit 0; fi

# 1) 先留备份（改权限文件出错会让全网连不上）
cp "$PERM" "$PERM.bak.$(date +%s)"

# 2) 追加到 nodes-allowlist 数组的右括号前
python3 - "$PERM" "$ENODE" "$NAME" <<'PY'
import sys, re
path, enode, name = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
m = re.search(r"(nodes-allowlist\s*=\s*\[)(.*?)(\])", text, re.S)
if not m: sys.exit("找不到 nodes-allowlist 数组")
entry = f'\n  # 成员：{name}（接入于 {__import__("datetime").date()}）\n  "{enode}"'
body = m.group(2).rstrip()
body = body + ("," if body.strip() else "") + entry
open(path, "w", encoding="utf-8").write(text[:m.start(2)] + body + "\n" + text[m.end(2):])
print("已写入白名单")
PY

cat <<EOF

下一步（二选一）：

A. 文件白名单 + 热加载 API（推荐先用这个，改动小）
   curl -X POST --data '{"jsonrpc":"2.0","id":1,"method":"perm_addNodesToAllowlist",
     "params":[["'$ENODE'"]]}' $RPC
   # 说明：perm_* API 需要在 rpc-http-api 里加 PERMISSIONING，且节点开了文件权限模式

B. 链上权限合约（生产推荐：授权留痕、可审计、无需重启）
   AdminContract.addNode(bytes32 enodeHash) 由运营方多签执行
   好处：谁在什么时候授权了哪个节点，本身就是 M4 存证的一部分

验证成员是否同步成功：
  在成员节点上：curl -s -X POST -H 'content-type: application/json' \\
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' <成员RPC>
  与运营侧高度对比，落后但持续增长 = 正在同步；长时间不动 = 白名单或网络问题

⚠️ 三件事必须同时确认，否则"接不上"查不到原因：
  1) 成员防火墙放行 30303 双向
  2) 成员的 bootnodes 指向的是**可达**的节点（跨网段时最容易填成内网地址）
  3) 成员的 genesis.json 与全网**逐字节相同**（chainId 一样不够，extraData 差异即分叉）
EOF
