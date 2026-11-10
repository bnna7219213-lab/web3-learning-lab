# P18 · 借贷质押协议（高级）

> 状态：未开始 ｜ 里程碑：M4·W14–15 ｜ 层级：高级 ｜ 主线：DeFi ｜ 依赖：P17
> 一句话目标：实现存借/清算/利率模型，把「不变式」当成一等公民（**仅研发演示**）。

## 目标

实现存借/清算/利率模型，把「不变式」当成一等公民（**仅研发演示**）。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] borrowIndex 懒结算
- [ ] 健康因子与清算激励
- [ ] 利率模型（利用率驱动）
- [ ] 预言机依赖与操纵
- [ ] 坏账与偿付隔离（treasury vs lockedStake）
- [ ] 不变式测试

## 技术栈

- Solidity + Foundry invariant
- 前端：仓位与清算面板
- 数据：风险指标看板

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 以 `hardhat/contracts/defi/LainLendingPool.sol` 为主教材精读，并复现其 `Invariant.t.sol`
- 输出：`docs/S5-高级应用/lainchain对照-P18.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 不变式 `Σ debt ≤ Σ supply`、`totalStaked == Σ balances` 挂进 CI
- [ ] 清算路径有集成测试
- [ ] 利率模型有数值表与边界测试
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
