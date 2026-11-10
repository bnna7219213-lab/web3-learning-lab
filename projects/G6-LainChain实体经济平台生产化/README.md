# G6 · LainChain 生产化改造（旗舰）（毕业）

> 状态：未开始 ｜ 里程碑：M6 ｜ 层级：毕业 ｜ 主线：综合 ｜ 依赖：全部主线
> 一句话目标：**把 lainchain-defi 当零件库做生产化改造**：仓库净化 → 静态分析门禁 → Spring Boot BFF → 索引重组处理 → 测试网部署 → 拆件产出 M1/M2/M3。

## 目标

**把 lainchain-defi 当零件库做生产化改造**：仓库净化 → 静态分析门禁 → Spring Boot BFF → 索引重组处理 → 测试网部署 → 拆件产出 M1/M2/M3。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] 仓库卫生与脚本分层（scripts vs scripts/debug）
- [ ] 质量门禁 verify：forge + invariant + e2e + build + Slither
- [ ] BFF 生产化（web3j + 部署产物驱动）
- [ ] 索引器重组与确认深度
- [ ] 多签与所有权移交
- [ ] 去代币化改造

## 技术栈

- Solidity + Foundry + Slither/Aderyn
- Spring Boot 4.1 + Java 21 + web3j
- Next.js 前端 + PostgreSQL 索引

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 全项目本体：按 `lainchain-defi-分析与并入路线.md` 的 P0/P1/P2 改进清单逐条落地
- 输出：`docs/S7-毕业项目/lainchain对照-G6.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 5 个立刻可做改造任务全部有 PR 级记录
- [ ] verify 门禁常驻
- [ ] M1/M2 拆件可脱离原仓库编译
- [ ] Sepolia 部署 + 监控 + 出证演示
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
