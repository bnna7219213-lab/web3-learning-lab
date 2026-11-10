#!/usr/bin/env bash
# 单机 4 验证者起网：生成密钥 → 分发到 docker/keys/node-N → 算 bootnodes → 起容器。
# 用法：bash scripts/20-up-docker.sh
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="$SRC/docker"
NET="$SRC/networkFiles"

[ -d "$DOCKER/keys/node-1" ] || [ ! -t 1 ] && echo "（提示：首次运行会先生成创世与密钥）"
if [ ! -f "$NET/genesis.json" ]; then bash "$SRC/scripts/10-genesis.sh" "$NET"; fi
[ -f "$NET/genesis.json" ] || { echo "没有 $NET/genesis.json，无法起网"; exit 1; }

# 1) 把生成的 4 套节点密钥按目录序号分发（生成器按 address 命名目录，这里排序对齐）
mapfile -t KEYDIRS < <(find "$NET/keys" -mindepth 1 -maxdepth 1 -type d | sort)
[ "${#KEYDIRS[@]}" -ge 4 ] || { echo "密钥目录数 ${#KEYDIRS[@]} < 4，检查 10-genesis.sh 的 blockchain.nodes"; exit 1; }

rm -rf "$DOCKER/keys"; mkdir -p "$DOCKER/keys"
for i in 0 1 2 3; do
  n=$((i + 1))
  mkdir -p "$DOCKER/keys/node-$n"
  cp "${KEYDIRS[$i]}/key"     "$DOCKER/keys/node-$n/key"
  [ -f "${KEYDIRS[$i]}/key.pub" ] && cp "${KEYDIRS[$i]}/key.pub" "$DOCKER/keys/node-$n/key.pub"
done
chmod -R 600 "$DOCKER/keys" 2>/dev/null || true
cp "$NET/genesis.json" "$DOCKER/genesis.json"
cp "$SRC/config/permissions_config.toml" "$DOCKER/permissions_config.toml"

# 2) 组 bootnodes：enode://<pubkey 去 0x>@<固定 IP>:30303
#    注意：enode 里的公钥是**节点密钥**公钥（64 字节未压缩，去掉开头 04），不是账户公钥。
BOOT=""
for i in 1 2 3 4; do
  pub_file="$DOCKER/keys/node-$i/key.pub"
  [ -f "$pub_file" ] || { echo "缺 $pub_file（besu 版本可能不产出 .pub，改用 besu public-key export --to=... 取）"; exit 1; }
  pub=$(tr -d '\n' < "$pub_file" | sed 's/^0x//; s/^04//')
  BOOT="$BOOT,enode://${pub}@172.30.0.$((10 + i)):30303"
done
BOOT="${BOOT#,}"
echo "BOOTNODES=$BOOT" > "$DOCKER/.env"
echo "→ docker/.env 写入 BOOTNODES（4 个 enode）"

# 3) 起网
cd "$DOCKER"
docker compose up -d
sleep 20
echo
echo "== 容器状态 =="
docker compose ps
cat <<EOF

下一步：
  RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh
  看日志：cd docker && docker compose logs -f node-1
  拆网：  cd docker && docker compose down -v && rm -rf keys .env genesis.json
EOF
