# P14 · BTC 资产协议画廊（进阶）

> 状态：未开始 ｜ 里程碑：M3·W13（选修） ｜ 层级：进阶 ｜ 主线：生态-BTC ｜ 依赖：P13
> 一句话目标：做一个 Ordinals/Runes 小索引工具，理解「在不可执行脚本的链上做资产协议」的取舍。

## 目标

做一个 Ordinals/Runes 小索引工具，理解「在不可执行脚本的链上做资产协议」的取舍。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] inscription/envelope 结构
- [ ] Runes 代币与整数除法陷阱
- [ ] 索引器与链重组
- [ ] 客户端验证与数据集
- [ ] RGB/Atomicals 概念定位

## 技术栈

- Rust 或 Node 索引脚本
- Ord/Runes 解析库
- 数据：PostgreSQL + 查询 API

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 对照 `indexer/` 的扫块模型，写「BTC 索引 vs EVM 日志索引」差异
- 输出：`docs/S4-生态专项/lainchain对照-P14.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 能索引并查询 ≥100 条 inscription
- [ ] 文档说明该协议的信任假设
- [ ] 选修结论：是否继续投入
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
