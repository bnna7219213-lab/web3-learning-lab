# P05 · ERC20 代币（基础）

> 状态：未开始 ｜ 里程碑：M1·W3–4 ｜ 层级：基础 ｜ 主线：合约 ｜ 依赖：P04
> 一句话目标：实现带权限与 Permit 的 ERC20，理解授权模型的安全含义与「计价载体」的合规选择。

## 目标

实现带权限与 Permit 的 ERC20，理解授权模型的安全含义与「计价载体」的合规选择。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] ERC20 事件与精度（decimals）
- [ ] approve/transferFrom 竞态与 decreaseApproval
- [ ] EIP-2612 permit 与 EIP-712 域分隔
- [ ] Ownable/AccessControl 角色设计
- [ ] 铸造/销毁与供应量治理
- [ ] 整数运算与四舍五入方向

## 技术栈

- Solidity + OpenZeppelin v5 + Foundry
- 前端：授权/转账演示页（P06 再做完整）
- 数据：Transfer 事件表

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 读 `hardhat/contracts/core/LainToken.sol` 与 `GameGold.sol`：两个代币的职责差异与 emission 逻辑
- 输出：`docs/S2-智能合约入门/lainchain对照-P05.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] permit 测试含签名重放用例（改 chainId/nonce 必须失败）
- [ ] 所有外部调用有事件
- [ ] forge fuzz 通过
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
