# P03 · 链上交互实战（基础）

> 状态：未开始 ｜ 里程碑：M1·W2 ｜ 层级：基础 ｜ 主线：基础 ｜ 依赖：P01
> 一句话目标：在测试网完成「建钱包 → 领水 → 转账 → 浏览器逐字段解析」，形成可复用的交易生命周期手册。

## 目标

在测试网完成「建钱包 → 领水 → 转账 → 浏览器逐字段解析」，形成可复用的交易生命周期手册。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 前置条件：测试币（2026-10-14 实测）

本项目**只有「浏览器逐字段解析」一节必须有公网测试网**，其余环节可在本地 anvil 完成（anvil 自带 10 个账户 × 10000 ETH，不需要任何领水）。

| 渠道 | 实测 | 门槛 |
|------|------|------|
| `sepolia-faucet.pk910.de` | 200 可达 | 无账号无验证码，浏览器 PoW 挖矿换测试币，需挂机一段时间 |
| `cloud.google.com/application/web3/faucet/ethereum/sepolia` | 200 可达 | 人机验证，约 0.05 ETH / 天 |
| `faucet.quicknode.com/ethereum/sepolia` | 200 可达 | 需登录 |
| `sepoliafaucet.com` → Alchemy | 200 可达 | 需注册，额度较高 |
| `faucets.chain.link/sepolia` | 200 可达 | 需 GitHub/Google 登录，**每日额度会被领光**（"无法领取"通常是这个原因） |

> 教训记录：不要凭印象写 URL。此前给出的 `www.quicknode.com/404` 是错误路径，正确路径见上表。
> 领水地址：`.env` 里的 `DEPLOYER_ADDRESS`（`cast wallet new` 生成的一次性学习地址）。
> 若改用你自己的 MetaMask 学习钱包，替换 `.env` 的 `DEPLOYER_PRIVATE_KEY` 即可，两者不要混用。

## 知识点

- [ ] 助记词与派生路径
- [ ] nonce / gas / gasPrice 与 EIP-1559
- [ ] input data 选择器解码
- [ ] logs/topics 与事件解码
- [ ] 交易状态、回执与确认数
- [ ] 失败交易与 gas 消耗

## 技术栈

- MetaMask（学习钱包）+ Sepolia/Base Sepolia
- viem 或 cast 脚本
- 数据：Etherscan API 拉取交易与日志

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 读 `hardhat/scripts/deploy.js` 与 `deployments/420.json`：部署录制 + ABI 自动下发前端的工程做法
- 输出：`docs/S1-区块链基础/lainchain对照-P03.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 手册含 ≥5 笔真实测试网交易的逐字段解析（含 1 笔失败）
- [ ] 能手工用 cast/viem 复现其中一笔
- [ ] 截图与 tx hash 可核
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
