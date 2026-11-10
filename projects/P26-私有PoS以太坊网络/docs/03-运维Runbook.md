# 03 · 运维 Runbook

> 场景化排障手册。每条给「症状 → 先看哪里 → 处置」。
> 说明：以下命令的**参数形式**依据 README 与 Foundry 实测（`cast wallet address --mnemonic ... --mnemonic-index N` 本机验证通过）；
> 涉及客户端专有子命令处，只写"看哪个日志/哪个指标"，不凭印象给 flag。

## R1 起不来 / 卡住

| 症状 | 先看 | 处置 |
|------|------|------|
| `kurtosis run` 长时间无输出 | `docker system df`、镜像拉取进度 | 国内网络拉 `ethereum/client-go:latest` 常超时：配 registry mirror，或预拉镜像后重试 |
| 报磁盘不足 | `df -h /var/lib/docker` | 调 `el_volume_size` / `cl_volume_size`；或 `kurtosis service rm` 清旧 enclave |
| enclave 存在但服务 red | `kurtosis enclave inspect <name>` | 看 `status` 列；`kurtosis service logs <enclave> <service>` 取最后 100 行 |
| 端口冲突 | `ss -ltnp \| grep -E '30303\|9000\|9090'` | 同机多 enclave 时必然撞：一个 enclave 一套端口，或分主机 |

## R2 不出块

**症状**：`eth_blockNumber` 长时间不变（`scripts/20-rpc-check.sh` 会直接报"13 秒无新块"）。

排查顺序（从最可能到最不可能）：
1. **VC 是否在跑**：`kurtosis service logs <enclave> <cl-beacon> --tail 200`，找 "no validator clients" / keystore 解锁失败。
2. **keystore 是否解锁**：`keymanager_enabled: true` 时看 keymanager API；密码错则验证者全部不参与。
3. **时钟**：`timedatectl show -p NTPSynchronized --value` 必须 `yes`。漂移几秒就表现为零星漏签。
4. **权重是否 ≥2/3**：单节点起网时如果 `num_validator_keys_per_node` 被改小又只起一个节点，检查是否所有 key 都在同一个 CL 下。
5. **JWT 不匹配**：EL 与 CL 日志同时出现认证错误 → 两个容器的 jwt 文件不是同一份（重建 enclave 时常见）。

## R3 出块但不最终化

| 检查 | 判据 |
|------|------|
| peer 数 | CL 日志里 peer 数是否 >0；只有 1 个节点时必然"自己投自己"，2/3 权重满足即可最终化 |
| 跨主机连通 | 两边都设了 `nat_exit_ip` 吗？没设 → 互相看不到（README 明确警告） |
| 防火墙 | 对端 `nc -zv <ip> 9000` 通吗？9000 被挡 = attestation 收不到 = 永不最终化 |
| 分叉 | 看 forkmon（`additional_services: [forkmon]`）是否两条链各自增长 |
| Geth 加入过晚 | `missing trie node ... layer stale` → 目标端 `--syncmode=full`（README 已知陷阱） |

## R4 节点掉线后追不上

1. 先看它是否真的重启成了同一个身份：`persistent: true` 有没有开。没开 → 卷被重建，节点身份变了。
2. A 重启导致身份变化时，**B 必须拆掉重建**（README 的 gotcha：nginx 快照只在 A 启动时生成）。
3. 追平时间经验：私有网数据量小，full sync 通常分钟级；若一直不动，看 `eth_syncing`。

## R5 交易发不出去

```bash
RPC=http://127.0.0.1:<port>
# 1) 账户有没有钱（预置账户来自默认助记词 index 0..N）
cast balance 0x8943545177806ED17B9F23F0a21ee5948eCaa776 --rpc-url $RPC
# 2) nonce 对不对
cast nonce 0x8943... --rpc-url $RPC
# 3) gas 价格（私有网可能没有市场定价，客户端会返回极低值 → 手动指定）
cast gas-price --rpc-url $RPC
```

常见原因：chainId 不匹配（钱包还连着别网）、nonce 抢跑（并发脚本）、gasPrice 为 0 被丢弃。

## R6 日常巡检（每天一次，5 分钟）

- [ ] `scripts/20-rpc-check.sh`：链 ID / 出块 / 最终性三项全 ✓
- [ ] 各节点 peer 数在正常区间（掉 0 通常是网络或对端重启）
- [ ] 磁盘余量 >30%，`docker system df` 无异常膨胀
- [ ] 验证者漏签计数（CL 指标）为 0；有增长就查时钟与网络
- [ ] 备份：`validator_keys`、JWT、genesis artifact、`network-config.tar`
- [ ] 变更留痕：谁改了参数、走没走审批（对齐 M1/M4 的治理要求）

## R7 升级与回滚

1. 私有网升级 = **硬分叉协调**：所有节点必须约定同一时间/高度换镜像，否则分裂。
2. 先在一个 enclave 演练：`--image-tag <pkg版本>` 固定包版本，别用 `main`（可复现性，对齐质量门禁）。
3. 回滚前确认链上数据是否已被新版本写过状态；不确定就**保留旧 enclave 不删**，用新 enclave 验证后再切。
4. 生产交付：包版本、客户端镜像 digest、genesis artifact 三者一起归档（这是 M4 出证里"锚点可复核"的组成部分）。
