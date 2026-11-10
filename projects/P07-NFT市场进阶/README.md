# P07 · NFT 市场（进阶）

> 状态：未开始 ｜ 里程碑：M2·W6–7 ｜ 层级：进阶 ｜ 主线：全栈 ｜ 依赖：P06
> 一句话目标：做 ERC721/1155 的铸造—挂单—成交—下架全流程，并吃透 EIP-4907 租期权限分离。

## 目标

做 ERC721/1155 的铸造—挂单—成交—下架全流程，并吃透 EIP-4907 租期权限分离。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] ERC721/1155 与元数据标准
- [ ] IPFS/对象存储与哈希锚定
- [ ] 签名订单与链下撮合
- [ ] 版税与 ERC2981 的局限
- [ ] EIP-4907 owner/user 双角色
- [ ] 市场合约的转账安全（safeTransferFrom）

## 技术栈

- Solidity + Foundry
- React 市场前端
- 数据：IPFS/Pinata 或客户 OSS + 哈希上链

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 读 `hardhat/contracts/market/RentalMarket.sol`（331 行）与 `NFTMarketplace.sol`：租期与挂单撮合实现
- 输出：`docs/S3-合约进阶与数据/lainchain对照-P07.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 完整交易路径截图
- [ ] 到期后 user 权限自动失效的测试
- [ ] 二级市场入口默认关闭（合规检查）
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
