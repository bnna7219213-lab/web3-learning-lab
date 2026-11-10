# P13 · BTC 脚本 UTXO 实验室（进阶）

> 状态：未开始 ｜ 里程碑：M3·W13（选修） ｜ 层级：进阶 ｜ 主线：生态-BTC ｜ 依赖：S1
> 一句话目标：用脚本、多签与时间锁做实验，理解 UTXO 模型与「条件支付」的另一种表达。

## 目标

用脚本、多签与时间锁做实验，理解 UTXO 模型与「条件支付」的另一种表达。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] UTXO 与账户模型对比
- [ ] Script 操作码与 P2PKH/P2WSH
- [ ] m-of-n 多签
- [ ] CSV/CLTV 时间锁
- [ ] PSBT 与离线签名流程
- [ ] 测试网（signet/testnet4）操作

## 技术栈

- Bitcoin Core + 描述符钱包
- Python/Node 脚本（bitcoinlib / viem 风格）
- 数据：UTXO 查询

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 无对应件；写「EVM vs UTXO 条件支付」对照笔记
- 输出：`docs/S4-生态专项/lainchain对照-P13.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 完成 2-of-3 多签与 24h 时间锁各一笔
- [ ] PSBT 离线签名流程可复现
- [ ] 对照笔记 1 篇
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
