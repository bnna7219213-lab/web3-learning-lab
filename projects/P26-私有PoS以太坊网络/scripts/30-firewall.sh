#!/usr/bin/env bash
# 公网主机防火墙模板（ufw）。只放行 P2P，其余一律默认拒绝。
# 用法：sudo bash scripts/30-firewall.sh            # 执行
#       DRY_RUN=1 bash scripts/30-firewall.sh       # 只看要跑什么
#
# 端口依据：EL P2P 30303 tcp+udp、CL P2P 9000 tcp+udp（Kurtosis port_publisher 发布的就是这两个），
# nginx 配置分发 9090（跨 enclave 同步时才需要，且建议限源）。
# RPC(8545/8546)、CL API(5052)、指标(9090 prometheus)、签名接口(3500) 一律不对公网开放。
set -uo pipefail
DRY="${DRY_RUN:-0}"
SSH_PORT="${SSH_PORT:-22}"
ADMIN_CIDR="${ADMIN_CIDR:-}"      # 例：203.0.113.0/24，管理网段（留空表示不额外放行）
PEER_CIDR="${PEER_CIDR:-}"        # 例：已知合作节点 IP 列表时用；开放准入则留空

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

command -v ufw >/dev/null 2>&1 || { echo "需要 ufw（Ubuntu/Debian：apt install ufw）。CentOS 请用 firewalld，逻辑同本文件注释。"; exit 1; }
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "请用 sudo 运行（或 DRY_RUN=1 预览）"; exit 1; }

run ufw default deny incoming
run ufw default allow outgoing
run ufw allow "$SSH_PORT"/tcp comment 'p26 ssh'

# 节点 P2P：只有你真的要做「开放准入的私有网」时才全开
run ufw allow 30303/tcp comment 'p26 EL p2p'
run ufw allow 30303/udp comment 'p26 EL p2p discv4'
run ufw allow 9000/tcp  comment 'p26 CL p2p'
run ufw allow 9000/udp  comment 'p26 CL p2p attestation subnet'

# 跨主机同步时，B 需要拉 A 的 genesis/enodes（nginx 9090）——务必限源到合作方
if [ -n "$PEER_CIDR" ]; then
  for cidr in $PEER_CIDR; do run ufw allow from "$cidr" to any port 9090 proto tcp comment 'p26 network-config from peers'; done
fi
if [ -n "$ADMIN_CIDR" ]; then
  run ufw allow from "$ADMIN_CIDR" to any port 3000:9500 proto tcp comment 'p26 admin: grafana/prometheus'
fi

echo
echo "明确不放行（保持默认 deny）：8545/8546 JSON-RPC、5052 CL API、3500 validator API、9090 Prometheus"
echo "如果运维必须访问，走 SSH 隧道而不是开公网端口："
echo "  ssh -N -L 3000:127.0.0.1:3000 -L 8545:127.0.0.1:8545 user@<host>"
echo
[ "$DRY" = 1 ] || run ufw --force enable
echo "== 当前规则 =="
ufw status verbose 2>/dev/null || echo "（DRY_RUN 模式，未查询）"
