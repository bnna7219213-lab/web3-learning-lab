# B08 · 合约工程化（联盟网）

> 状态：✅ 已完成实测（2026-11-13，40 条 forge 单测 + 8 个验收脚本全绿） ｜ 对应主线：[P08](../P08-合约工程化进阶/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
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

- [x] 零 gas 下为什么仍要优化：区块 gasLimit 决定吞吐与出块准点率（[docs/01](docs/01-Gas双指标报告.md)）
- [x] contractSizeLimit 与 EIP-170/7825 对大合约的真实约束（[docs/02](docs/02-大合约体积与单笔gas上限.md)）
- [x] 代理升级在多成员链上的流程（需成员共识窗口，不是单方行为）（[docs/03](docs/03-多成员升级演练.md)）
- [x] Create2 地址派生与 chainId 绑定（联盟链换链 ID 会导致地址全变）（[docs/05](docs/05-Create2与chainId登记.md)）
- [x] 合约端 Merkle proof 验证 + 出证包（接 shared/evidence）（[docs/04](docs/04-Merkle双向互验.md)）

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

1. [x] 复用 P08 的实现，切到联盟网 profile（`FOUNDRY_PROFILE=consortium`，40 条 forge 单测全绿）
2. [x] 多成员账户与 nonce 管理（[scripts/02](scripts/02-multi-member.js)；踩坑记录见其注释：Besu txpool RPC 关闭时同账户连发必须显式管理 nonce）
3. [x] 零 gas 相关断言与负例（[scripts/03](scripts/03-zero-gas.js)）
4. [x] 权限（白名单/角色）正例与负例（[scripts/05](scripts/05-permission-negative.js)）
5. [x] 内网可观测（审计：[scripts/04](scripts/04-finality.js) 3 节点一致性 + [scripts/05](scripts/05-permission-negative.js) revert 进块可查；浏览器复用 B03 explorer）
6. [x] 文档与证据（[docs/](docs/) 5 篇 + `deployments/*.json` 实测记录 4 份）

## 验收

**分支共用四条增量**（B03–B08 一律适用）：

- [x] 多成员：≥2 个成员账户各自发交易，nonce 互不干扰（[scripts/02](scripts/02-multi-member.js) ALL PASS）
- [x] 零 gas：`eth_gasPrice == 0` 且 `baseFeePerGas == 0`，交易确实入账（[scripts/03](scripts/03-zero-gas.js) ALL PASS）
- [x] 终结性：交易所在块在 3 个节点查询一致，5 分钟后仍一致（[scripts/04](scripts/04-finality.js) ALL PASS）
- [x] 权限负例：未授权账户/节点被拒且留下可审计记录（[scripts/05](scripts/05-permission-negative.js) ALL PASS）

**本分支特有**：

- [x] Gas 报告改成「区块容量占用 + 出块延迟影响」双指标（[scripts/06](scripts/06-gas-report.js) + [docs/01](docs/01-Gas双指标报告.md)）
- [x] 一次代理升级演练含全成员参与与回滚方案（[scripts/07](scripts/07-upgrade-drill.js) 六步 13 断言 + [docs/03](docs/03-多成员升级演练.md)）
- [x] 合约端 Merkle 验证与 P01 链下实现互相验证通过（[scripts/08](scripts/08-merkle-crosscheck.js) 四方向互验 + [docs/04](docs/04-Merkle双向互验.md)）
- [x] 大合约（>24KB）在 contractSizeLimit/pertxgaslimit 配置下部署成功（[scripts/09](scripts/09-big-contract.js) 30KB 实测 + [docs/02](docs/02-大合约体积与单笔gas上限.md)）

- [x] README 可按步骤复现（含联盟网准备步骤：见「环境准备」+ 各 docs「复现」节）
- [x] 去代币化检查：本项目不含任何代币发行/交易功能（Vault 仅为零 gas 联盟链的升级实验载体，deposit 不含真实价值转移）

## 复盘

- 与 P08 相比最意外的差异：**整笔交易口径会稀释组间差异**——组2 calldata vs memory 在 P08 同交易口径省 14%，
  上链后整笔 gasUsed 口径只剩 2.1%（128 元素 calldata 的固定成本把执行段差异摊薄）；联盟链看容量必须用整笔口径，
  看「写法差多少」才用同交易口径（[docs/01](docs/01-Gas双指标报告.md) §1）。
- 联盟特有故障（静默丢单 / 授权遗漏 / 停链）遇到没有：**遇到了「静默丢单」**——Besu txpool RPC 关闭时
  `eth_getTransactionCount(pending)` 看不到池中交易，同账户连发 2 笔 ethers 取到同一 nonce，后一笔顶掉前一笔，
  `wait()` 永远挂住且**无任何报错**（scripts/02 注释已钉死；修法=显式 nonce 本地递增）。授权遗漏由 05 负例覆盖；
  停链未遇到（QBFT 5s 出块全程稳定）。
- 对客交付时客户最关心的问题：① 升级回滚方案——**代码可回滚、存储不回滚**，回滚必须配套数据订正（docs/03 §2）；
  ② 批量业务能否上线——卡点是单笔 gas 预算（8M ≈ 39.9KB 合约），不是 EIP-170（docs/02 §3）；
  ③ 换链 ID 后地址作废范围——Create2 预计算地址必须列入迁移变更项（docs/05 §2）。
