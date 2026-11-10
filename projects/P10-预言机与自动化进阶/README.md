# P10 · 预言机与自动化（进阶）

> 状态：未开始 ｜ 里程碑：M2·W10 ｜ 层级：进阶 ｜ 主线：合约+数据 ｜ 依赖：P08
> 一句话目标：接入价格预言机并实现自动化任务，理解「外部数据进链」的信任与操纵风险。

## 目标

接入价格预言机并实现自动化任务，理解「外部数据进链」的信任与操纵风险。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] Chainlink Aggregator 与心跳/偏差
- [ ]  TWAP 与操纵抗性
- [ ] 自建 m-of-n 中位数 + 罚没
- [ ] Automation / keeper 与 gas 代付
- [ ] 离线签名与执行者分离
- [ ] 数据时效性判定（stale 即拒绝）

## 技术栈

- Solidity + Chainlink（测试网 feed）
- Node/Keeper 服务
- 监控：价格延迟与偏差告警

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 精读 `hardhat/contracts/attention/AttentionOracle.sol`（m-of-n 中位数 + 罚没）与 `defi/PriceOracle.sol`
- 输出：`docs/S3-合约进阶与数据/lainchain对照-P10.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] stale 价格必须拒绝使用（有测试）
- [ ] 自动化任务失败有重试与告警
- [ ] 写清操纵攻击面与缓解
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
