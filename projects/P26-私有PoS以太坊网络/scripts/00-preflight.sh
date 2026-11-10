#!/usr/bin/env bash
# P26 前置自检：先跑这个，再谈起网。
# 用法：bash scripts/00-preflight.sh
set -uo pipefail
ok=0; warn=0; miss=0
row() { case "$1" in OK) ok=$((ok+1));; WARN) warn=$((warn+1));; *) miss=$((miss+1));; esac; printf '%-4s %-26s %s\n' "$1" "$2" "$3"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== P26 私有 PoS 网络前置检查 =="
echo

# --- 必需工具 ---
if have docker; then
  if docker info >/dev/null 2>&1; then row OK "docker" "$(docker --version | head -1)（daemon 正常）"
  else row MISS "docker" "已安装但 daemon 未运行：sudo systemctl start docker（WSL2 需启动 Docker Desktop）"; fi
else row MISS "docker" "未安装：https://docs.docker.com/engine/install/"; fi

if have kurtosis; then row OK "kurtosis" "$(kurtosis version 2>&1 | head -1)"
else row MISS "kurtosis" "未安装（官方脚本，执行前请自行核对域名）：sh -c \"\$(curl -fsSL https://get.kurtosis.com/install)\""; fi

have git && row OK "git" "$(git --version)" || row WARN "git" "未安装（拉配置与版本管理会用到）"
if have cast; then row OK "foundry/cast" "$(cast --version | head -1)"
else row WARN "foundry/cast" "未安装：派生预置账户私钥会不方便（curl -L https://foundry.paradigm.xyz | bash）"; fi

# --- 系统条件（跨主机部署最容易翻车的三项）---
if have timedatectl; then
  if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qi yes; then row OK "时钟同步" "NTP 已同步"
  else row WARN "时钟同步" "未同步：验证者会漏签、链可能不最终化（chronyc makestep）"; fi
else row WARN "时钟同步" "无 timedatectl（非 systemd 主机），自行确认 NTP"; fi

os=$(uname -s)
[ "$os" = "Linux" ] && row OK "操作系统" "Linux（Kurtosis Docker 后端支持最好）" \
                   || row WARN "操作系统" "$os —— Windows 需走 WSL2；macOS 可用但网络模式差异大"

mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "${mem_kb:-0}" -gt 12000000 ]; then row OK "内存" "$((mem_kb/1024/1024)) GB（≥12GB 可跑 2 节点）"
elif [ "${mem_kb:-0}" -gt 0 ]; then row WARN "内存" "$((mem_kb/1024/1024)) GB：偏小，建议 num_validator_keys_per_node 调低"
else row WARN "内存" "读不到 /proc/meminfo"; fi

free_gb=$(df -BG . 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}')
if [ "${free_gb:-0}" -gt 150 ]; then row OK "磁盘可用" "${free_gb} GB（EL/CL 卷默认各需数十 GB）"
else row WARN "磁盘可用" "${free_gb:-?} GB：私有网虽小，但 persistent + archive 会很快吃满"; fi

# --- 端口占用（本机跑多节点时最常见）---
for p in 9090 30303 9000 8545; do
  if have ss && ss -ltn 2>/dev/null | grep -q ":$p "; then row WARN "端口 $p" "已被占用（同机多节点会冲突）"; fi
done

# --- 公网部署必查项 ---
if [ -n "${KURTOSIS_PUBLIC_IP:-}" ]; then
  row OK "nat_exit_ip" "已设 KURTOSIS_PUBLIC_IP=$KURTOSIS_PUBLIC_IP（记得同步进 yaml）"
else
  row WARN "nat_exit_ip" "未设：跨主机部署时 README 明确警告，不设则广播的是 docker 内网地址，别人连不上"
fi

echo
echo "== 汇总：OK $ok · WARN $warn · MISS $miss =="
[ "$miss" -eq 0 ] && echo "可以进入：bash scripts/10-up-local.sh" || echo "先补齐 MISS 项（docker daemon 与 kurtosis 是硬依赖）。"
exit 0
