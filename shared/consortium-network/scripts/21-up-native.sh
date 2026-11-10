#!/usr/bin/env bash
# 原生 Besu 单机起 4 验证者 QBFT 网（不需要 Docker）—— 适合你已把 Besu 装在 /opt/besu 的服务器。
# 用法：bash scripts/21-up-native.sh [运行目录]
#   默认运行目录 ./run；生产多机部署时把 P2P_IP 换成各主机真实内网 IP。
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${1:-$SRC/run}"
NET="$SRC/networkFiles"
P2P_IP="${P2P_IP:-127.0.0.1}"          # 单机验证用回环；跨主机必须改成可路由 IP
BASE_P2P=30311                          # 30311..30314
BASE_RPC=8551                           # 8551..8554（避开默认 8545，方便与已有节点共存）
BASE_METRICS=9551

command -v besu >/dev/null 2>&1 || { echo "找不到 besu（先 source /etc/profile 或检查 /usr/local/bin/besu）"; exit 1; }
[ -f "$NET/genesis.json" ] || { echo "缺 $NET/genesis.json，先跑：bash scripts/10-genesis.sh $NET"; exit 1; }

# ---------- 1) 收集 4 套节点密钥，并从 key.pub 构造 enode ----------
mapfile -t KEYDIRS < <(find "$NET/keys" -mindepth 1 -maxdepth 1 -type d | sort)
[ "${#KEYDIRS[@]}" -ge 4 ] || { echo "密钥目录 ${#KEYDIRS[@]} 个 < 4"; exit 1; }

enode_of() { # 兼容 128 位(x||y) 与 130 位(04||x||y) 两种公钥写法
  local f="$1" raw
  raw=$(tr -d ' \t\n\r' < "$f"); raw=${raw#0x}
  if [ "${#raw}" -eq 130 ] && [ "${raw:0:2}" = "04" ]; then raw=${raw:2}; fi
  if [ "${#raw}" -ne 128 ]; then echo "E:$(basename "$f") 长度 ${#raw} 既不是 128 也不是 130" >&2; return 1; fi
  echo "$raw"
}

BOOT=""
for i in 0 1 2 3; do
  pub="${KEYDIRS[$i]}/key.pub"
  [ -f "$pub" ] || { echo "缺 $pub —— 用 besu public-key export --to=${KEYDIRS[$i]}/key 生成"; exit 1; }
  hex=$(enode_of "$pub") || exit 1
  BOOT="$BOOT,enode://${hex}@${P2P_IP}:$((BASE_P2P + i))"
done
BOOT="${BOOT#,}"
echo "→ bootnodes 已构造（4 条 enode）"

# ---------- 2) 起 4 个节点（非破坏式：绝不 rm -rf run/） ----------
# 旧版这里有一句 `rm -rf "$RUN"`，后果是：重跑一次脚本 = 节点私钥副本 + 区块数据一起没了，
# 链头归零回到 genesis，而 genesis 里的验证者是新建的随机 key —— 老链彻底找不回来。
# 现在默认幂等续跑；要重建必须显式 FORCE=1，且只清 data、保留 key。
if [ -f "$RUN/pids" ]; then
  ALIVE=""
  for p in $(tr -d ' ,' < "$RUN/pids"); do kill -0 "$p" 2>/dev/null && ALIVE="$ALIVE $p"; done
  if [ -n "$ALIVE" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "已有节点进程在跑：$ALIVE —— 什么都不做。"
    echo "要接管请先 bash scripts/29-stop-native.sh $RUN；要重建链请 FORCE=1 bash scripts/21-up-native.sh --fresh"
    exit 0
  fi
fi

FRESH="${1:-}"
if [ "$FRESH" = "--fresh" ] || [ "${FORCE:-0}" = "1" ]; then
  [ "${FORCE:-0}" = "1" ] || { echo "--fresh 会清空区块数据（链归零）。确认请 FORCE=1 重跑。"; exit 1; }
  echo "!! FORCE=1：清理各节点 data/（保留 node-$n/key，验证者身份不变）"
  for n in 1 2 3 4; do rm -rf "$RUN/node-$n/data" "$RUN/node-$n/besu.log"; done
fi
mkdir -p "$RUN"

PIDS=""
for i in 0 1 2 3; do
  n=$((i + 1))
  node_dir="$RUN/node-$n"
  mkdir -p "$node_dir"
  # 节点私钥是链上的验证者身份，一旦存在就永不覆盖
  if [ ! -s "$node_dir/key" ]; then
    cp "${KEYDIRS[$i]}/key" "$node_dir/key"
    chmod 600 "$node_dir/key"
  fi

  # 零 gas 三件套 + QBFT 由 genesis 决定（没有 --qbft-enabled 这个选项，写了会启动失败）
  # JVM 参数只能走 BESU_OPTS 环境变量（launcher 把它拼在 java 命令行上）；
  # 直接跟在 besu 后面会被 picocli 当成未知选项而启动失败。
  # ADMIN 不在白名单里：这些 RPC 端口会被 nginx 反代到公网，admin_addPeer 谁都能调就是事故。
  nohup env BESU_OPTS="${BESU_OPTS:--Xmx140m -Xms48m -XX:+UseSerialGC -Xss512k -XX:MaxMetaspaceSize=180m -XX:ReservedCodeCacheSize=40m -XX:MaxDirectMemorySize=48m -XX:StartFlightRecording=maxsize=2m,maxage=2h}" besu \
    --data-path="$node_dir/data" \
    --genesis-file="$NET/genesis.json" \
    --node-private-key-file="$node_dir/key" \
    --p2p-host="$P2P_IP" --p2p-port=$((BASE_P2P + i)) \
    --bootnodes="$BOOT" \
    --min-gas-price=0 \
    --tx-pool-enable-balance-check=false \
    --rpc-http-enabled=true --rpc-http-host=127.0.0.1 --rpc-http-port=$((BASE_RPC + i)) \
    --rpc-http-api=ETH,NET,WEB3,QBFT \
    --host-allowlist=localhost,127.0.0.1 \
    --metrics-enabled=true --metrics-host=127.0.0.1 --metrics-port=$((BASE_METRICS + i)) \
    --logging=INFO \
    > "$node_dir/besu.log" 2>&1 &
  pid=$!
  PIDS="$PIDS $pid"
  echo "$pid" > "$node_dir/pid"
  echo "  node-$n  pid=$pid  p2p=$((BASE_P2P + i))  rpc=http://127.0.0.1:$((BASE_RPC + i))"
done
echo "$PIDS" | tr -d ' ' > "$RUN/pids"
echo "$BOOT" > "$RUN/bootnodes.txt"

echo
echo "等待 25 秒让节点互相发现并出块…"
sleep 25

# ---------- 3) 自检 ----------
RPC=http://127.0.0.1:$BASE_RPC bash "$SRC/scripts/30-smoke-test.sh" || true

cat <<EOF

节点日志：  tail -f $RUN/node-1/besu.log
单看 peer：  curl -s -X POST -H 'content-type: application/json' \\
             --data '{"jsonrpc":"2.0","id":1,"method":"net_peerCount","params":[]}' http://127.0.0.1:$BASE_RPC
验证者列表： 同上，method 换成 qbft_getValidatorsByBlockNumber，params ["latest"]
停止全部：   bash scripts/29-stop-native.sh $RUN

下一步（B04 起）：foundry.toml 里加 profile
  [profiles.consortium]
  rpc-url = "http://127.0.0.1:$BASE_RPC"
  chain-id = $(sed -n 's/.*"chainId"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$NET/genesis.json" | head -1)
EOF
