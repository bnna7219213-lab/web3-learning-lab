# B06 · 审批/投票 DApp（联盟网）

> 状态：**已完成，本机实测通过（Besu QBFT + 多成员审批台，链上验收 21/21）** ｜ 对应主线：[P06](../P06-投票DApp基础/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
> 一句话目标：把投票 DApp 升级为**多成员审批流**：不同成员独立签名、双人复核、生效延迟、撤销窗口，业务事件统一进入 B09。

## 与 P06 的关系

功能闭环一致，环境语义不同。P06 的知识点在本分支重做为多成员审批；共性差异见[差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P09-vs-B03-B09.md)。

| 维度 | P06（公链/anvil） | B06（联盟 QBFT） |
|------|------------------|------------------|
| 交互主体 | 单个学习钱包 | 成员 A / B 各有提案与复核角色，管理员执行，外部账户无角色 |
| 钱包 | MetaMask | 零构建页面 + BFF 代签；密钥只在服务端，显式 `gasPrice=0 / type=0` |
| 业务语义 | 一人一票 | **提案 → 他人复核 → 生效延迟 → 执行**，提案人不能复核自己的提案 |
| 审计 | 合约事件 | 事件 + 失败交易 `status=0` + 本地审计流水；B09 可跨项目对账 |
| 并发 | 单账户顺序 | 两成员各 10 笔显式 nonce 并发，验证账户间 nonce 不串 |

## 已实现

- [x] `ApprovalFlow.sol`：AccessControl 角色、双人复核、驳回、生效延迟、撤销窗口、执行。
- [x] 多成员前端：身份切换、发起提案、复核/驳回/撤销/执行，可读拒绝原因。
- [x] 持久部署：`deployments/latest.json` 记录 chainId、合约地址、角色与生效延迟。
- [x] B09 联动：`Proposed / Reviewed / Revoked / Executed` 进入统一索引，可在看板按 B06 筛选。
- [x] 可重复验收：撤销窗口按**链上区块时间**判断，不用固定睡眠猜测出块进度。

## 目录与运行

```text
src/ApprovalFlow.sol          审批状态机
frontend/                    零构建多成员审批台
scripts/01-deploy.mjs        部署并授角色，写 deployments/latest.json
scripts/serve.mjs            BFF + 前端，默认 8803
scripts/02-acceptance.mjs    独立实例端到端验收（21 项）
docs/01-审批状态机.md         状态与权限说明
```

```bash
# 前置：shared/consortium-network 的 4 验证者已启动，B07/env/.env.local 含成员密钥。
cd projects/B06-投票DApp联盟网
npm install

# 持久实例：默认生效延迟 60s；本机联动实例用 APPROVAL_DELAY=15 部署。
APPROVAL_DELAY=15 node scripts/01-deploy.mjs
npm run serve                  # http://127.0.0.1:8803

# 验收：脚本自建 delay=8s 的独立实例，不覆盖持久部署。
node scripts/02-acceptance.mjs
```

## 实测记录（2026-11-13，21/21）

| 组 | 结果 |
|----|------|
| A. 多成员并发 | 两成员各 10 笔提案全部 `status=1`；每账户提案顺序与 nonce 一致，A/B nonce 各自连续 |
| B. 双人复核 | 他人复核成功；自审返回 `ProposerCannotReview` 且失败交易入块；过早执行返回 `TooEarly`；延迟后执行进入 `Executed` |
| C. 撤销窗口 | 窗口内撤销成功，撤后不可执行；链上时间越过 `executeAfter` 后返回 `WindowClosed` |
| D. 权限负例 | 外部账户提案预检返回 `AccessControlUnauthorizedAccount`，失败交易 `status=0` 留痕并写审计 |
| E. 联盟增量 | 零 gas；执行块在 8551–8553 三个节点哈希一致；多成员与权限负例均由前述组覆盖 |

**B09 联动实测**：B09 在持久实例上再实际创建并处理三组提案，覆盖复核、撤销和执行；四类事件数与链上 `eth_getLogs` 对账，页面按 B06 业务域可查。完整数字见 [B09 验收记录](../B09-链上数据平台联盟网/docs/02-验收记录.md)与[全联盟链路图](../../shared/consortium-network/docs/06-全联盟链路全景.md)。

## 边界与复现注意

- BFF 是本机教学环境的代签适配层，不等于生产身份认证；生产应补成员登录鉴权、会话与签名策略。
- 页面事件轮询有 5 秒延迟，B09 还提供独立的历史索引与跨项目对账，不把页面刷新当作链上证明。
- 持久合约地址以 `deployments/latest.json` 为准；验收脚本的临时合约不会覆盖它。
