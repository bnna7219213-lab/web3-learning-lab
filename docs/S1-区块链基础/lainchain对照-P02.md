# lainchain 对照 · P02 ↔ `IoTBridgeForMcu.sol`

> 读的是源文件本身：`lainchain-defi/hardhat/contracts/iot/IoTBridgeForMcu.sol`（165 行，Solidity ^0.8.28，OpenZeppelin `AccessControl`）。
> 目的：把 MiniChain 里「谁写的、算没算过、能不能改」这三件事，对照真实项目怎么落地，并给出 M2 的改造清单。
> 日期：2026-10-13

## 1 信任边界：谁验设备签名？

| | MiniChain（P02） | IoTBridgeForMcu |
|--|------------------|-----------------|
| 验签位置 | **账本层**：每笔交易 `checkTx()` 验 ECDSA 签名 + 地址与公钥匹配 | **网关层**：文件注释写明「设备原始签名在网关层校验（ATECC608A SE / KMS 私钥隔离）」 |
| 合约层信任什么 | 什么都不信，重放即验 | `onlyRole(ORACLE_ROLE)` + `lainId.hasIdentity(did)` |
| 后果 | 任何节点作恶都会被其他节点拒绝 | **oracle 是单点**：拿到网关私钥即可代表任意已注册 `did` 上报 |

结论：这不是「谁更安全」，而是**两种产品形态**。公链必须自带验签；联盟链/一体机把验签前移到网关是合理的（省 gas、支持国密），但必须补两件事：
① oracle 私钥进 SE/HSM 且可轮转；② 合约侧对「同一设备」做二次约束（见第 2 点）。
> M2 交付文档里要把这句话写给客户：**"链上不验设备签名，验的是网关；所以我们把网关做成一体机并纳入等保范围。"**

## 2 防重放：账户 nonce vs 一次性指纹

```solidity
mapping(bytes32 => bool) public claimedModel;   // 模型哈希即 nonce
if (claimedModel[qModelHash]) revert ModelAlreadyClaimed();
claimedModel[qModelHash] = true;
```

| | P02 的做法 | 它的做法 | 差异与风险 |
|--|-----------|----------|-------------|
| 机制 | `tx.nonce !== account.nonce` 即拒（严格递增序列） | `qModelHash` 位图（一次性领取） | 语义不同：前者防「同一笔指令执行两次」，后者防「同一份资产被领两次」 |
| 可绕过面 | 换签名即换 txId，无法绕过 | **`qModelHash` 由上报者自己填**：换一个 hash 就能重复领 | 必须把 hash 绑定到「设备 + 内容 + 期次」，否则等于没有防重放 |
| 副作用 | 无 | 同一模型的第二批数据无法再结算 | 真实设备是持续上报的，需要 `deviceId + seq` 而不是模型指纹 |

**M2 改造**：把 `claimedModel[qModelHash]` 换成 `lastSeq[deviceId]` 单调序号 + `periodKey`（期次）唯一约束，
正是 P01 Demo 4「验签通过 + 序号单调」和 P02 实验 4「重放同一 nonce → 400」的组合。

## 3 输入校验与预算护栏（可直接复用的好做法）

```solidity
if (efficiencyBps == 0 || efficiencyBps > 1_000_000) revert BadEfficiency();
uint256 raw = (episodes * rewardPerEpisode * efficiencyBps) / 10_000;
uint256 reward = raw > maxRewardPerReport ? maxRewardPerReport : raw;
```

- **边界校验 + 自定义 error**：`revert BadEfficiency()` 比 `require(...,"msg")` 省 gas 且可读；P02 的 `checkTx` 返回 `{ok, reason}` 是同一思路的链下版本。
- **先乘后除**：`(episodes * rewardPerEpisode * efficiencyBps) / 10_000` 保留精度；若先除会直接归零。→ 定点数顺序是 P08 Gas/精度实验的教材。
- **单次封顶 `maxRewardPerReport`**：这是「预算不变式」的雏形。M5 的 `Σ 已拨付 ≤ 预算`、`单笔 ≤ 限额` 就是它的治理化版本。

## 4 权限集中（对应分析文档的 P0 红线）

`setRewardParams` / `setOracle` 均由 `DEFAULT_ADMIN_ROLE` 单地址调用即可生效，**无延迟、无多签**。
→ 一体机交付时必须改：参数变更走多签 + 生效延迟（P19 的 `Timelock` 模式），并在出证材料里保留参数变更历史。

## 5 事件即账本（P09 索引器的输入契约）

```solidity
event IntelligenceReported(address indexed did, bytes32 indexed qModelHash, uint256 efficiencyBps,
                           uint256 episodes, string visionTag, uint256 wireReward, uint256 repValue);
```
两个 `indexed` 让「按设备查」「按模型查」都能用 topic 过滤，成本极低——这是好的事件设计。
P02 的对应做法：区块里存 `txIds` 与 `merkleRoot`，出证时按叶子重算（同一理念：**链上只放可验证的骨架**）。

## 6 P02 给 M2 的最直接结论：最终性

合约的世界观是「交易已被链接受」，它不关心重组；而 P02 实验 3 实测证明：
**分区期间两条分支上的交易都算「已确认」，重连后权重 4 → 6 的分支胜出，另一笔被回滚。**

所以 M2 设备可信结算的出证规则必须写死：

| 项 | 规则 |
|----|------|
| 出证时机 | 达到 `INDEXER_CONFIRMATIONS`（盟链建议 1–3，公链 ≥12）后才出证 |
| 出证内容 | tx hash + 区块 hash + 区块高度 + （批量时）Merkle proof |
| 回滚处理 | 若发生重组，出证号作废并重新签发，事件写入审计日志 |
| 对客承诺 | 「T+X 分钟内为可回滚状态」写进 SLA，而不是笼统说「不可篡改」 |

## 7 一句话总结

`IoTBridgeForMcu` 教的是**业务合约怎么写得干净**（角色、边界、事件、封顶）；
P02 教的是**它默认成立的那一层其实并不成立**（验签在哪、重放怎么防、确认会不会被回滚）。
两者叠起来才是 M2 的完整方案：设备签名 → 网关批量 → 链上锚定 → N 确认后出证 → 重组即作废重签。
