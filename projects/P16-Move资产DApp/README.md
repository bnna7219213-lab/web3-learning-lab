# P16 · Move 资产 DApp（进阶）

> 状态：未开始 ｜ 里程碑：M3·W13（选修） ｜ 层级：进阶 ｜ 主线：生态-Sui ｜ 依赖：S2 或并行
> 一句话目标：用 Move 的资源模型表达「权益/凭证」，理解对象所有权与 Capability 对权限建模的简化。

## 目标

用 Move 的资源模型表达「权益/凭证」，理解对象所有权与 Capability 对权限建模的简化。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] Move 资源与 copy/drop 能力
- [ ] Sui 对象模型与所有权
- [ ] Capability 授权模式
- [ ] 泛型与集合
- [ ] Transfer/Dewy 式市场
- [ ] Sui SDK / dApp Kit 前端

## 技术栈

- Move + Sui CLI / Aptos
- Sui dApp Kit + React
- 数据：Sui Indexer / RPC

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 无对应件；对照 `SubscriptionNFT.sol` 写「NFT 权益 vs Move 对象权益」
- 输出：`docs/S4-生态专项/lainchain对照-P16.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] devnet 发行 + 转授权 + 过期演示
- [ ] 权限模型对照笔记
- [ ] 选修结论 1 篇
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
