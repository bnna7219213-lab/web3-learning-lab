# B08 · 合约工程化（联盟网）

> 状态：未开始 ｜ 对应主线：[P08](../P08-合约工程化进阶/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-10-14
> 一句话目标：在零 gas 联盟链上重做 Gas/升级/Create2/Merkle 四类工程实验，把「优化」的目标从省钱改成**省区块容量与延迟**。

## 与 P08 的关系

**功能实现一致，环境语义不同。**P08 的全部知识点在本分支都要做一遍，本 README 只记录**差异与新增验收**；
共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。

| 维度 | P08（公链/anvil） | B08（联盟 QBFT） |
|------|------------------------|----------------------|
| 优化目标 | 省 ETH | 省区块容量、降延迟、控节点资源（成员分摊成本） |
| 升级权限 | 合约 owner 单方 | **多成员窗口**：停机/灰度/回滚需协调，写进变更流程 |
| 地址可预测 | 主网/测试网通用 | chainId 变更会使 Create2 地址全变 → 链 ID 必须永久登记 |
| 新增交付 | — | 合约体积与单笔 gas 上限的实测报告（决定批量业务能否上线） |

## 知识点

- [ ] 零 gas 下为什么仍要优化：区块 gasLimit 决定吞吐与出块准点率
- [ ] contractSizeLimit 与 EIP-170/7825 对大合约的真实约束
- [ ] 代理升级在多成员链上的流程（需成员共识窗口，不是单方行为）
- [ ] Create2 地址派生与 chainId 绑定（联盟链换链 ID 会导致地址全变）
- [ ] 合约端 Merkle proof 验证 + 出证包（接 shared/evidence）

## 技术栈

- Solidity + Foundry（forge snapshot + gas report）
- Slither/Aderyn
- 脚本：升级演练 + 全成员参与窗口

## 环境准备

```bash
cd ../../shared/consortium-network
bash scripts/00-preflight.sh
bash scripts/20-up-docker.sh          # 单机 4 验证者验证；多机见 README §三
RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh
```

## 任务拆解

1. [ ] 复用 P08 的实现，切到联盟网 profile
2. [ ] 多成员账户与 nonce 管理
3. [ ] 零 gas 相关断言与负例
4. [ ] 权限（白名单/角色）正例与负例
5. [ ] 内网可观测（浏览器/日志/审计）
6. [ ] 文档与截图

## 验收

**分支共用四条增量**（B03–B08 一律适用）：

- [ ] 多成员：≥2 个成员账户各自发交易，nonce 互不干扰
- [ ] 零 gas：`eth_gasPrice == 0` 且 `baseFeePerGas == 0`，交易确实入账
- [ ] 终结性：交易所在块在 3 个节点查询一致，5 分钟后仍一致
- [ ] 权限负例：未授权账户/节点被拒且留下可审计记录

**本分支特有**：

- [ ] Gas 报告改成「区块容量占用 + 出块延迟影响」双指标
- [ ] 一次代理升级演练含全成员参与与回滚方案
- [ ] 合约端 Merkle 验证与 P01 链下实现互相验证通过
- [ ] 大合约（>24KB）在 contractSizeLimit/pertxgaslimit 配置下部署成功

- [ ] README 可按步骤复现（含联盟网准备步骤）
- [ ] 去代币化检查表通过（涉及对外交付时）

## 复盘

- 与 P08 相比最意外的差异：
- 联盟特有故障（静默丢单 / 授权遗漏 / 停链）遇到没有：
- 对客交付时客户最关心的问题：
