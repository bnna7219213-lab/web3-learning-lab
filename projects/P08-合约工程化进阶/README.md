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
