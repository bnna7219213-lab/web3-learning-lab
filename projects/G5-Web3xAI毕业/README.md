# G5 · Web3 × AI（毕业）

> 状态：未开始 ｜ 里程碑：M6 ｜ 层级：毕业 ｜ 主线：综合 ｜ 依赖：合约 + AI 服务 + 索引
> 一句话目标：链上 Agent 资产与行为存证：AI 决策留痕、可审计、可追责（与 LangChain4j 技术栈衔接）。

## 目标

链上 Agent 资产与行为存证：AI 决策留痕、可审计、可追责（与 LangChain4j 技术栈衔接）。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] Agent 身份与授权边界
- [ ] 行为日志上链与哈希锚定
- [ ] 模型输出可验证性（含 ZK 远期）
- [ ] AI 调用成本与链上结算

## 技术栈

- Spring Boot + LangChain4j
- Solidity（AgentNFT/存证）
- 数据：调用日志索引

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 精读 `identity/AgentNFT.sol` 与 `attention/*`（多源验证、反女巫）
- 输出：`docs/S7-毕业项目/lainchain对照-G5.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 一次 AI 任务全链路留痕并可出证
- [ ] 权限边界测试（Agent 不能越权花钱）
- [ ] 复盘：哪些是噱头、哪些真有用
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
