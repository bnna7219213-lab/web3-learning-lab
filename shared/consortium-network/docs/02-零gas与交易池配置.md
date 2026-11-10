# 02 · 零 gas 网络的完整配方（以及漏掉一步会怎样）

> 依据 Besu `docs/private-networks/how-to/configure/free-gas.md`（2026-10-14 抓取）。
> 你的原方案写了"Gas Price 设为 0 → 内部交易免费"，方向对，但**只做了六步里的半步**。

## 官方六步对照

| 步 | 官方要求 | 漏掉的后果 | 本仓库落点 |
|----|----------|------------|------------|
| 1 | `gasLimit: 0x1fffffffffffff`（Hardhat 可接受最大值） | 块太小，批量分账/大批存证塞不进 | `genesis/qbft-genesis.json.tpl` ✅ |
| 2 | 需要大交易时设 `pertxgaslimit`（EIP-7825 把单笔压到 16,777,216 gas） | **P08 的大合约 / P07 的批量铸造交易直接发不进去** | 同上，设 0 = 解除 |
| 3 | `contractSizeLimit: 2147483647` | 合约超过 EIP-170 的 24KB 就部署失败（lainchain 的 `LainLendingPool` 这类很容易超） | 同上 ✅ |
| 4 | `--min-gas-price=0`，**每个节点都要** | 见下方 danger | `config/*.toml` ✅ |
| 5 | `--tx-pool-enable-balance-check=false` | 零余额成员账户的交易进不了 txpool 优先层 | `config/*.toml` ✅ |
| 6 | 启用 `londonBlock` 时必须 `"zeroBaseFee": true` | baseFee 非零 → 交易实际仍要花钱 | 同上 ✅ |

官方 danger 原文：

> "In a free gas network, ensure the minimum gas price is set to zero for **every node**.
> Any node with a minimum gas price set higher than zero will **silently drop** transactions with a zero gas price."

**这是联盟链最容易发生、最难查的故障**：4 个验证者里 1 个配置漂移，部分交易就凭空消失，
客户端只看到"pending 然后超时"，日志里没有错误。

### 交付时怎么防

- [ ] 配置一致性检查进 CI：`scripts/30-smoke-test.sh` 会断言 `eth_gasPrice == 0` 与 `baseFeePerGas == 0`
- [ ] 每台节点的 `config.toml` 由同一份模板渲染（Ansible/compose 单一来源），禁止手改
- [ ] 监控项：`besu_txpool_added_total` 与 `eth_sendRawTransaction` 计数差值，差值持续增大 = 有节点在丢
- [ ] 变更流程：改 gas 相关参数属于**全网一致变更**，必须停机窗口或灰度验证

## 零 gas ≠ 无成本（对客户要说清）

| 表面 | 实际 |
|------|------|
| 交易免费 | 算力/存储/运维成本由成员分摊 → 这正是"年维保"收费的依据 |
| 无 gas 限制 | `gasLimit` 仍在，防死循环；`rpc-http-gas-cap` 限单请求 |
| 无需经济激励 | 需要**法律与合同激励**：违约成本、保证金、退出条款 |

> 报价话术：`联盟链年费 = 节点资源摊销 + 运维值守 + 治理服务（授权/参数变更/出证）`，
> 而不是"我们不收 gas 所以免费"。

## 一个容易忽略的副作用

零 gas + `tx-pool-enable-balance-check=false` 会让**任何人都能无成本刷交易**（只要过了白名单）。
所以必须配套：

1. `nodes-allowlist` 严格（见 `docs/03`）
2. RPC 侧 `rpc-http-gas-cap`、`rpc-http-max-active-connections`、反向代理限流
3. txpool 上限监控（Besu 有 txpool 指标，压测时看内存增长）

这三条缺一条，"免费链"就会变成"自我 DoS 链"。
