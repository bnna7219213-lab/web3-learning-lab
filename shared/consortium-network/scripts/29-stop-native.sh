#!/usr/bin/env bash
# 停止 21-up-native.sh 起的节点。用法：bash scripts/29-stop-native.sh [运行目录]
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${1:-$SRC/run}"
[ -d "$RUN" ] || { echo "没有运行目录 $RUN"; exit 1; }

stopped=0
for f in "$RUN"/node-*/pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  if kill "$pid" 2>/dev/null; then
    # 等优雅退出，最多 10 秒；Besu 需要时间落盘，直接 -9 可能损坏 KV store
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && { echo "pid $pid 未优雅退出，发送 KILL"; kill -9 "$pid" 2>/dev/null; }
    stopped=$((stopped + 1))
  fi
done
echo "已停止 $stopped 个节点。数据保留在 $RUN/node-*/data（重启会续用，不要误删）。"
echo "彻底重来：rm -rf $RUN && bash scripts/10-genesis.sh $SRC/networkFiles"
