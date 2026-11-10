#!/usr/bin/env bash
# 联盟链部署前置自检（Linux/RedHat 目标机；本机 Windows 只能跑部分项）。
# 用法：bash scripts/00-preflight.sh
set -uo pipefail
ok=0; warn=0; miss=0
row() { case "$1" in OK) ok=$((ok+1));; WARN) warn=$((warn+1));; *) miss=$((miss+1));; esac; printf '%-4s %-24s %s\n' "$1" "$2" "$3"; }
have() { command -v "$1" >/dev/null 2>&1; }

BESU_VERSION="${BESU_VERSION:-26.9.0}"   # 2026-09-25 发布的 release（GitHub API 实测）
REQUIRED_JAVA="${REQUIRED_JAVA:-25}"     # 实测：Besu 26.9.0 要求 Java 25+（服务器安装时从 24 升上来的）
                                        # 官方 system-requirements 未写死版本号，以 besu 启动报错为准

echo "== 联盟链（Besu QBFT）部署前置检查 =="
echo

# ---------- 运行时 ----------
if have java; then
  JV=$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')
  if [ "${JV:-0}" -ge "$REQUIRED_JAVA" ]; then
    row OK "java" "$(java -version 2>&1 | head -1)（Besu $BESU_VERSION 需 ≥$REQUIRED_JAVA）"
  else
    row MISS "java" "当前 $JV，Besu $BESU_VERSION 需 ≥$REQUIRED_JAVA —— 升级 JDK 后再试（RedHat：dnf 或手动装到 /opt/jdk 并改 /etc/profile）"
  fi
else row MISS "java" "未安装：Besu 26.9.0 需 Java 25+"; fi

if have besu; then row OK "besu" "$(besu --version 2>&1 | head -1)"
else
  row WARN "besu" "未安装。当前官方发布：$BESU_VERSION"
  echo "     下载（GitHub Releases，实测 200；consensys artifacts 老路径已 404）："
  echo "       curl -LO https://github.com/hyperledger/besu/releases/download/$BESU_VERSION/besu-$BESU_VERSION.tar.gz"
  echo "       curl -LO https://github.com/hyperledger/besu/releases/download/$BESU_VERSION/besu-$BESU_VERSION.tar.gz.sha256"
  echo "       sha256sum -c besu-$BESU_VERSION.tar.gz.sha256 && tar xzf besu-$BESU_VERSION.tar.gz"
  echo "     离线内网：在外网机下载并校验后带入，不要跳过 sha256 校验。"
fi

have docker && (docker info >/dev/null 2>&1 && row OK "docker" "daemon 正常" || row WARN "docker" "已装但 daemon 未运行（多机部署可不用 docker，走 systemd）") || row WARN "docker" "未安装（仅单机验证需要）"

# ---------- 系统条件 ----------
if have timedatectl; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qi yes \
    && row OK "时钟同步" "NTP 已同步" || row WARN "时钟同步" "未同步：QBFT 对时间戳敏感，会表现为零星不出块/漏签"
fi

if have firewall-cmd; then
  firewall-cmd --list-ports 2>/dev/null | grep -qE "8545|8546" \
    && row WARN "firewalld" "8545/8546 已全局开放：确认只对内网子网（--add-source），别把 RPC 摆到可达公网的 zone" \
    || row OK "firewalld" "未发现 RPC 端口全局开放"
fi

free_gb=$(df -BG . 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}')
[ "${free_gb:-0}" -gt 60 ] && row OK "磁盘可用" "${free_gb}GB（官方：私有网 VM 10–20GB 起，验证者/RPC 用本地 SSD）" \
                          || row WARN "磁盘可用" "${free_gb:-?}GB 偏小"

mem_gb=$(awk '/MemTotal/{printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
[ "${mem_gb:-0}" -ge 8 ] && row OK "内存" "${mem_gb}GB（官方：私有网 JVM 最低 4GB，推荐 VM 6GB）" \
                        || row WARN "内存" "${mem_gb:-?}GB：JVM 需显式 -Xmx 限制，否则同步期易 OOM"

# ---------- 共识规模（这条最容易被忽略）----------
N="${VALIDATORS:-4}"
F=$(( (N - 1) / 3 )); Q=$(( 2 * F + 1 ))
row OK "QBFT 容错计算" "n=$N → f=$F，quorum=$Q：可容忍 $((N-Q)) 台离线；超过即停链"
[ "$N" -lt 4 ] && row WARN "验证者数量" "n<4 不满足 BFT 最低要求（n=3f+1, f≥1）"
[ "$N" -gt 7 ] && row WARN "验证者数量" "n>7 时 QBFT 消息复杂度 O(n²)/块 开始明显，需压测确认出块时间"

echo
echo "== 汇总：OK $ok · WARN $warn · MISS $miss =="
[ "$miss" -eq 0 ] && echo "可继续：bash scripts/10-genesis.sh" || echo "先补 MISS 项（JDK17 与 besu 是硬依赖）。"
exit 0
