# 01 · 授权模型：approve 竞态、permit 与舍入方向

> 配套代码：`src/LabToken.sol` · 配套测试：`test/ApproveRace.t.sol`、`test/Permit.t.sol`、`test/LabToken.t.sol`
> 日期：2026-11-11（OZ v5.0.2，solc 0.8.28）

## 1. allowance 模型与事件覆盖

ERC20 的授权是「owner 允许 spender 动自己多少余额」的一张可变欠条：`approve` 写欠条，`transferFrom` 兑欠条。
本合约所有改状态的外部调用都有事件（验收门禁），映射如下：

| 外部调用 | 事件 | 来源 |
|----------|------|------|
| transfer / transferFrom | Transfer(from, to, value) | ERC20 |
| mint | Transfer(0x0, to, value) | ERC20._mint |
| burn / burnFrom | Transfer(from, 0x0, value) | ERC20Burnable |
| approve | Approval(owner, spender, value) | ERC20 |
| permit | Approval(owner, spender, value) | ERC20Permit（签名即授权） |
| grantRole / revokeRole / renounceRole | RoleGranted / RoleRevoked | AccessControl |

索引器（P09）只靠 Transfer/Approval 两个 topic0 就能重建全部余额与授权轨迹——mint/burn 不需要额外事件，
因为它们在 Transfer 里以 0x0 端点表达。

## 2. approve 竞态：改授权不是原子意图

事故复现（`test_Race_DirectChangeLetsSpenderStackOldAndNew`）：

```text
owner: approve(spender, 100)            ← 已落块
owner: approve(spender, 50)             ← 还在 mempool，意图是「降到 50」
spender: 抢跑 transferFrom(owner, spender, 100)   ← 用旧欠条
owner 的降价交易落块
spender: transferFrom(owner, spender, 50)         ← 用新欠条
结果：spender 拿走 150，而 owner 的意图上限是 50（原始授权也只有 100）
```

根因：**mempool 是公开的，旧授权在新授权落块前仍然有效**，两笔授权可以被叠加兑现。

### 2.1 为什么 decreaseAllowance 救不了（OZ v5 移除它的原因）

v4 的 `decreaseAllowance(50)` 语义就是 `approve(100-50)`——delta 写法没有改变「旧欠条仍有效」这个事实，
竞态窗口原样存在（`test_DecreaseAllowanceDoesNotFixRace` 用裸 approve 模拟其语义，依旧被提走 150）。
它给人「我在安全地减授权」的错觉，所以 v5 直接移除。**API 的存在不等于安全的存在。**

### 2.2 真正有效的两条缓解

1. **撤销→等确认→授新**（`test_Mitigation_RevokeConfirmedThenGrant`）：
   `approve(0)` 落块后旧欠条已死（此时 `transferFrom(100)`  revert `ERC20InsufficientAllowance`），
   再 `approve(50)`。 spender 最多兑现「撤销前已授权的额度」+「新额度」，但前者本就是 owner 授出去的，
   不存在「意图之外」的叠加。代价：两笔交易、两个确认等待。
2. **permit 从零授权**（`test_Mitigation_PermitFromZeroIsExactAndSingleUse`）：
   owner 不发交易，链下签一张「精确金额 + nonce + deadline」的授权；没有旧欠条就没有抢跑对象，
   nonce 保证单张签名只能兑一次。适合「首次授权 / 一次性精确授权」场景。

注意 permit 也不是万能：若链上已有一张非零旧欠条，permit 落块前旧欠条仍可被抢跑——
**竞态的根源是「可变授权 + 公开 mempool」，不是某个函数写错了**。

## 3. EIP-2612 permit 与 EIP-712 域分隔

签名结构：`keccak256("\x19\x01" ‖ DOMAIN_SEPARATOR  keccak256(Permit struct))`，其中

```text
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("Learning Lab Token"), keccak256("1"), chainId, address(token)))
Permit struct   = (owner, spender, value, nonce, deadline)
```

防重放三件套在测试里逐条钉死：

| 攻击 | 测试 | 结果 |
|------|------|------|
| 同签名重放 | test_PermitReplayFails | nonce 已推进 → ERC2612InvalidSigner |
| 旧 nonce 签新金额 | test_PermitWithStaleNonceFails | 拒 |
| 跨链重放（别的 chainId 上签的） | test_PermitSignedOnOtherChainFails | 域分隔含 chainId → 拒 |
| 签名后链切换 | test_PermitAfterChainSwitchFails | DOMAIN_SEPARATOR 随链变 → 拒 |
| 过期 | test_PermitExpiredDeadlineFails | ERC2612ExpiredSignature |
| 别人私钥代签 | test_PermitWrongSignerFails | 恢复地址 ≠ owner → 拒 |
| 中继篡改金额 | test_PermitTamperedValueFails | 签名覆盖全字段 → 拒 |

`test_DomainSeparatorTracksChainId` 直接断言 `vm.chainId` 切换后 DOMAIN_SEPARATOR 改变。
这套「域分隔」思想与 P03 手册 §5 的 EIP-155 同源：**把上下文绑进签名，签名就只在上下文内有效**。

## 4. 角色设计：AccessControl 而非 Ownable

- `DEFAULT_ADMIN_ROLE`：管角色的角色（授/撤 MINTER_ROLE）。构造参数外置 admin（P04 教训：不写死 msg.sender）。
- `MINTER_ROLE`：唯一增发入口；与 admin 分离——运营多签持 admin，热钱包持 minter，泄露热钱包不丢治理权。
- burn 不设角色：持币人烧自己的币是产权的一部分（ERC20Burnable），治理不该能阻止销毁。
- 上限 CAP 是 immutable：构造后任何人（包括 admin）改不了——**把「不能作恶」写进代码比写进制度便宜**。

## 5. 舍入方向：quoteProRata 向下取整

`quoteProRata(pool, account) = pool × balance / totalSupply`（Math.mulDiv, Rounding.Floor）。
按持仓分摊奖励池时，向下取整让 dust 留在池里：`Σ quotes ≤ pool` 恒成立
（`testFuzz_QuoteProRataNeverOverpays` 500 轮钉死）。反方向（向上取整）会超发——
P17/P18 里「协议侧有利 vs 用户侧有利」的舍入选择是同一枚硬币的两面，这里先建立直觉。