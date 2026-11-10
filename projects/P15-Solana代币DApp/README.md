# P15 · Solana 代币 DApp（进阶）

> 状态：未开始 ｜ 里程碑：M3·W13（选修） ｜ 层级：进阶 ｜ 主线：生态-Solana ｜ 依赖：S2 或并行
> 一句话目标：用 Anchor 写一个 SPL 代币 + PDA 程序并接前端，体会账户模型与高吞吐的代价。

## 目标

用 Anchor 写一个 SPL 代币 + PDA 程序并接前端，体会账户模型与高吞吐的代价。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] 账户模型与 rent
- [ ] PDA 派生与约束
- [ ] CPI 与程序升级
- [ ] Token-2022 扩展
- [ ] 交易确认与 finality
- [ ] Rust 所有权在合约里的体现

## 技术栈

- Rust + Anchor + SPL
- wallet-adapter + Next.js
- 数据：Helius/getProgramAccounts 或自建索引

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 无对应件；写「EVM 合约 vs Solana 程序」状态模型对照
- 输出：`docs/S4-生态专项/lainchain对照-P15.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] devnet 程序 + 前端全流程
- [ ] PDA 权限边界有测试
- [ ] 选修结论 1 篇
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
