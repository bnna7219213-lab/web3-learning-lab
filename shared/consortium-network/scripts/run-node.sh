#!/usr/bin/env bash
# 单个 QBFT 验证者的前台启动器（给 systemd 用，也可手工跑）。
# 用法：run-node.sh <1..4>
# 与 21-up-native.sh 的区别：不生成密钥、不清空数据、不后台化——只做"把一个节点起来"这一件事。
set -euo pipefail

N="${1:?用法: run-node.sh <1..4>}"
SRC="${CONSORTIUM_HOME:-/root/consortium-network}"
RUN="$SRC/run"
NET="$SRC/networkFiles"
NODE_DIR="$RUN/node-$N"

P2P_IP="${P2P_IP:-127.0.0.1}"          # 多机部署时改成该主机可路由内网 IP
BASE_P2P="${BASE_P2P:-30310}"
BASE_RPC="${BASE_RPC:-8550}"
BASE_METRICS="${BASE_METRICS:-9550}"

[ -f "$NET/genesis.json" ] || { echo "缺 $NET/genesis.json" >&2; exit 1; }
[ -f "$NODE_DIR/key" ]     || { echo "缺 $NODE_DIR/key（先跑 10-genesis.sh 并由 21-up-native.sh 分发）" >&2; exit 1; }
BOOTNODES="$(cat "$RUN/bootnodes.txt" 2>/dev/null || true)"
[ -n "$BOOTNODES" ] || { echo "缺 $RUN/bootnodes.txt（bootnodes 为空会导致节点互相找不到）" >&2; exit 1; }

# 小内存主机的 JVM 瘦身（实测对象：1.88GB 机器跑 4 验证者）
#   SerialGC   : 140MB 小堆下 G1 的 remember set 与卡表开销不划算
#   Xss512k    : Besu 线程数多，默认 1MB 栈 × 约 200 线程 = 大量保留内存
#   Metaspace/CodeCache 上限：防止 4 个 JVM 各自无限膨胀
#   StartFlightRecording 覆盖：/opt/besu/bin/besu 的 DEFAULT_JVM_OPTS 里挂着默认 jfc，
#                写在这里会在 java 命令行上排最后而生效（BESU_OPTS 在 DEFAULT 之后拼接）
# 关键：这些是 *JVM* 参数，必须走 BESU_OPTS 环境变量。把它们直接跟在 besu 后面当命令行
# 参数传，picocli 会报 Unknown option 而拒绝启动 —— 自己交付的脚本里踩过这个坑。
JVM_OPTS="${BESU_JVM_OPTS:--Xmx140m -Xms48m -XX:+UseSerialGC -Xss512k -XX:MaxMetaspaceSize=180m -XX:ReservedCodeCacheSize=40m -XX:MaxDirectMemorySize=48m -XX:StartFlightRecording=maxsize=2m,maxage=2h -Djava.io.tmpdir=/var/lib/besu-tmp}"

# /tmp 是 tmpfs，inode 上限 241728；被邻居的 tomcat 临时目录占满时（2026-11-11 实测 IFree=0，
# 而空间还剩 683M），JFR 与 sdkman 都建不出临时文件，JVM 直接初始化失败。
# 所以本节点的一切临时文件都走磁盘目录，不依赖 /tmp 的可用性。
mkdir -p /var/lib/besu-tmp

# RPC 白名单只留对外解析需要的命名空间：ADMIN 会让公网 /b03-rpc/ 上的
# admin_addPeer / admin_removePeer 可被任意人调用；PERM 会泄露节点准入策略。
# 权限治理（B08）请用 SSH 本机端口或独立的内网 RPC，不要走这个反代。
exec env BESU_OPTS="$JVM_OPTS" besu \
  --data-path="$NODE_DIR/data" \
  --genesis-file="$NET/genesis.json" \
  --node-private-key-file="$NODE_DIR/key" \
  --p2p-host="$P2P_IP" --p2p-port=$((BASE_P2P + N)) \
  --bootnodes="$BOOTNODES" \
  --min-gas-price=0 \
  --tx-pool-enable-balance-check=false \
  --rpc-http-enabled=true \
  --rpc-http-host=127.0.0.1 \
  --rpc-http-port=$((BASE_RPC + N)) \
  --rpc-http-api=ETH,NET,WEB3,QBFT \
  --host-allowlist=localhost,127.0.0.1 \
  --metrics-enabled=true \
  --metrics-host=127.0.0.1 \
  --metrics-port=$((BASE_METRICS + N)) \
  --logging=INFO
