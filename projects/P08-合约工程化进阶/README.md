# P08 · 合约工程化进阶包（进阶）

> 状态：未开始 ｜ 里程碑：M2·W8 ｜ 层级：进阶 ｜ 主线：合约 ｜ 依赖：P05
> 一句话目标：把「贵、能改、可预测地址、批量证明」四件事各做一个可复现实验，形成工程判断力。

## 目标

把「贵、能改、可预测地址、批量证明」四件事各做一个可复现实验，形成工程判断力。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] 存储布局与 slot 手工计算
- [ ] Gas 报告与优化（calldata/packing/缓存）
- [ ] Create2 确定性地址
- [ ] UUPS/Transparent 代理与升级迁移脚本
- [ ] 合约端 Merkle proof 验证
- [ ] ERC-4337 账户抽象概念落地

## 技术栈

- Solidity + Foundry（forge snapshot/gas-report）
- Slither/Aderyn
- 脚本：升级演练

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## 零 gas 语义校准（先立住，再做 Gas 优化）

> 本节把 [B03](../B03-链上交互实战联盟网/README.md) 与 [shared/consortium-network/docs/02](../../shared/consortium-network/docs/02-零gas与交易池配置.md)
> 已校准的零 gas 表述接到 P08——因为 P08 的第一件事就是「Gas 优化」，而**零 gas 链上的 Gas 优化动机和公链完全不同**。做实验前先把这几条说清，否则对比表会立不住。

### 一句话

**零 gas 免的是手续费（gas 成本），不是本金（转账面值），也不是无成本。**

### 三层拆开（这是最常被混为一谈的地方）

| 语义 | 零 gas 链上是否成立 | 对 P08 实验的意义 |
|------|-------------------|------------------|
| **手续费 = 0** | ✅ `gasPrice=0`、`baseFeePerGas=0`（`zeroBaseFee=true`） | Gas 优化**不再省钱**——用户发交易不花 token |
| **本金照收** | ✅ `value > balance` 照样被拒（`-32004 Insufficient funds for transfer`） | 涉及转账/支付的合约，余额检查逻辑不能因为"零 gas"就省掉 |
| **gasLimit 仍在** | ✅ 块 gasLimit=`0x1fffffffffffff`，单笔受 `pertxgaslimit`、合约受 EIP-170 的 24KB 约束 | 区块容量是**稀缺资源**——Gas 优化在这里动机是**塞得进、跑得快、状态不膨胀**，不是省钱 |

### P08 的 Gas 优化在零 gas 链上到底优化什么

公链上「Gas 优化 = 省用户的钱」；零 gas 联盟链上这句话不成立，真实动机是：

1. **区块容量是共享稀缺资源**：块 gasLimit 有上限（尽管很大），一个吞 gas 的合约会挤占同块其它交易——存储布局、calldata/packing、缓存读写的优化，优化的是**单位区块吞吐**。
2. **合约体积受 EIP-170 硬约束（24KB）**：这是 `contractSizeLimit` 管不到的以太坊协议层限制，超了部署直接失败——这是 P08 大合约真实会撞的墙，也是 docs/02 步 3 存在的原因。
3. **执行仍有成本，只是不记账到 gas**：算力/存储/运维由成员分摊（年维保收费的依据）。优化执行路径 = 优化成员的真实运维成本。
4. **`forge snapshot` / `gas-report` 依然有效**：报告的是 gas 消耗量（度量执行开销），与 gasPrice 是否为 0 无关——这是 P08 做对比表的技术前提。

### 与 B03 表述的一致性核对

- B03：「零 gas 免的是手续费，不是本金」——本节三层表第一条+第二条与之逐字对齐。
- B03 存证锚点用 `value=0` + 专门新生成的密钥，**不动运营方水龙头资金**——正是利用「零 gas 链上 0 值交易不需要账户有钱」；P08 若做需要面值的操作，此结论**不适用**，须回到 `value > balance` 被拒。
- docs/02「零 gas ≠ 无成本」表——本节第 3 条动机直接引用，客户报价话术不写「不收 gas 所以免费」。

> **做对比表时的口径**：列名写「gas 消耗（gasUsed）」，不要写「成本」或「费用」；结论落在吞吐/体积/执行开销，不落「省了多少钱」。

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 精读 `hardhat/contracts/defi/LainStaking.sol`（Synthetix 累加器，本金/奖励解耦）与 `market/SplitPayment.sol` 的 `_accPerShare`
- 输出：`docs/S3-合约进阶与数据/lainchain对照-P08.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] Gas 对比表入 docs/
- [ ] 代理升级演练含存储槽冲突检查
- [ ] 合约端 Merkle 验证与 P01 链下实现互相验证通过
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
