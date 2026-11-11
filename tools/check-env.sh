#!/usr/bin/env bash
# 环境自检（开发计划.md · 里程碑 M0 验收项）
# 用法：bash tools/check-env.sh
set -uo pipefail

ok=0; warn=0; miss=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

row() { # 状态 名称 版本/说明
  case "$1" in
    OK)   ok=$((ok+1));;
    WARN) warn=$((warn+1));;
    *)    miss=$((miss+1));;
  esac
  printf '%-4s %-22s %s\n' "$1" "$2" "$3"
}

have() { command -v "$1" >/dev/null 2>&1; }
ver()  { "$1" "${@:2}" 2>/dev/null | head -1; }

echo "== Web3 路线环境自检 =="
echo "仓库根目录: $ROOT"
echo

# --- 必装：Foundry 工具链 ---
if have forge; then row OK "forge" "$(ver forge --version | head -1)"; else row MISS "forge" "未安装：curl -L https://foundry.paradigm.xyz | bash && foundryup"; fi
if have anvil; then row OK "anvil" "本地测试链可用"; else row MISS "anvil" "随 foundryup 安装；缺失时重跑 foundryup"; fi
if have cast;  then row OK "cast" "CLI 交互可用"; else row MISS "cast" "随 foundryup 安装"; fi

# --- 必装：Node / Git ---
if have node; then
  NV="$(ver node -v)"
  case "${NV#v}" in
    1[89].*|2[0-9].*) row OK "node" "$NV";;
    *) row WARN "node" "$NV（建议 LTS >= 18）";;
  esac
else row MISS "node" "未安装：https://nodejs.org"; fi
have npm   && row OK "npm" "$(ver npm -v)"            || row MISS "npm" "未安装"
have git   && row OK "git" "$(ver git --version)"     || row WARN "git" "未安装（不影响本地学习，影响提交/协作）"

# --- 可选但本项目会用到 ---
have java    && row OK "java"    "$(java -version 2>&1 | head -1)" || row WARN "java" "未安装（Spring Boot BFF / 盟链 SDK 需要）"
have python  && row OK "python"  "$(ver python --version)"         || row WARN "python" "未安装（indexer 原型脚本用）"
have docker  && row OK "docker"  "$(ver docker --version)"         || row WARN "docker" "未安装（可选：起本地链/Postgres）"
if have besu; then row OK "besu" "$(besu --version 2>/dev/null | head -1)"; else row WARN "besu" "未安装（联盟网/B 线需要：下载与 sha256 校验见 shared/consortium-network/scripts/00-preflight.sh）"; fi

echo
# --- 安全门禁：私钥不得入库 ---
if [ -f "$ROOT/.env" ]; then
  row OK ".env" "存在（本地配置，切勿提交）"
else
  row WARN ".env" "缺失：cp .env.example .env 后按需填写；学习钱包与生产钱包必须分离"
fi
if have git && [ -d "$ROOT/.git" ]; then
  if git -C "$ROOT" ls-files --error-unmatch .env >/dev/null 2>&1; then
    row MISS ".env 是否被跟踪" "危险：git rm --cached .env 并立即作废该助记词"
  else
    row OK ".env 是否被跟踪" "未被 git 跟踪"
  fi
else
  row WARN "git 仓库" "尚未 git init（M0 任务：建仓库并推送计划文档）"
fi

# --- P01 前端零依赖，只需 Node 能起服务 ---
if have node; then
  row OK "P01 运行方式" "node tools/serve.mjs  → http://127.0.0.1:8787/projects/P01-区块链认知工具箱基础/frontend/"
  row OK "P01 测试方式" "node --test \"projects/P01-区块链认知工具箱基础/test/*.test.mjs\""
fi

echo
echo "== 汇总：OK $ok · WARN $warn · MISS $miss =="
[ "$miss" -eq 0 ] && echo "结论：P01–P06 均可开工；联盟网与 B 线另需 besu + JDK25（见 WARN 项）。" || echo "结论：请先补齐 MISS 项（尤其 forge/anvil）。"
exit 0
