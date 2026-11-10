# lainchain 对照 · P04 ↔ `core/Faucet.sol`

> 读的是源文件：`lainchain-defi/hardhat/contracts/core/Faucet.sol`（134 行，pragma ^0.8.24，OpenZeppelin `Ownable` + `ReentrancyGuard` + `SafeERC20`）。
> 对照物：本项目 `src/Counter.sol`（约 80 行）。目的不是比谁复杂，而是看**同一个基础件在真实项目里会长出什么**。
> 日期：2026-10-14

## 1 权限的归属：`owner = msg.sender` 是默认值，不是设计

```solidity
contract Faucet is Ownable, ReentrancyGuard {
    constructor(address _lain, address _wire, address admin) Ownable(admin) { … }
```

我的 `Counter` 用 `owner = msg.sender`，Faucet 把 admin 作为**构造参数显式传入**。
差别在部署脚本里才显现：lainchain 的 `deploy.js` 末尾会把所有权 handover 给 Timelock（分析文档 §2.1 记为"部署即去中心化演练"）。
如果合约写死 `msg.sender`，那 owner 就是部署脚本用的那个 EOA，移交要额外一步。

**改进 P04**：`Counter` 的构造应接受 `admin` 参数（`constructor(uint256 initial, address admin)`），
`Deploy.s.sol` 从 `OWNER_ADDRESS` 读——这样 B04 部署到联盟网时，可以直接把 owner 设成客户方的多签地址，而不是我们运营账户。

## 2 自定义 error 带上下文，但真实项目也混用 require

```solidity
error CooldownActive(uint256 secondsRemaining);
…
require(to != address(0), "Faucet: zero address");
```

同一个文件里两种风格并存：状态类失败给带参数的 error（前端能直接显示"还剩 X 秒"），
参数校验仍用字符串 require。
这修正了我一个隐含偏见——不是"新代码必须全 error"，而是**需要给用户的失败给结构化数据，纯程序员错误给字符串即可**。
我的 `NotOwner(address caller)` / `Overflow(previous, by)` 属于前者，写法正确。

## 3 外部调用前写状态（checks-effects-interactions 的正面样本）

```solidity
lastDrip[to] = block.timestamp;   // ← 先写状态
totalDrips += 1;
…
(bool ok, ) = payable(to).call{value: gasSent}("");   // ← 后交互
```

加上 `nonReentrant`，双保险。`Counter` 没有外部调用所以用不上，但 **B05/B07 一旦涉及转账就必须照这个顺序写**。

## 4 最值得学的一条：部分成功，而不是整体 revert

```solidity
uint256 gasSent;
if (gasDrip > 0 && address(this).balance >= gasDrip && to.balance < gasDrip) { gasSent = gasDrip; … }
uint256 lainSent;
if (lainDrip > 0 && lain.balanceOf(address(this)) >= lainDrip) { … }
emit Dripped(to, gasSent, lainSent, wireSent);
```

三种资产各自判额度、够才发、发多少记多少，最后**一次性 emit 实际结果**。
`Counter` 的世界是"要么成功要么全失败"；对客系统里大量场景是 Faucet 这种：
**余额不足以发满时，宁可发一部分并如实记录，也不要让整笔交易回滚。**

直接可迁移到：
- **M5 补贴直达**：预算不足时按剩余额度发放并留痕，比整批失败更好向审计解释（但必须配 `Σ 已拨付 ≤ 预算` 不变式）
- **M1 分账**：某收款方拒收/地址异常时，其余分账照常，异常部分进待处理队列
- 代价：调用方必须读事件才知道实际发生了什么，`tx.status == 1` 不再等于"完全成功"——这一点必须写进接口文档

## 5 反女巫"刻意做弱"，并写明不得上公网

```solidity
 * Sybil resistance is intentionally weak (cooldown only) because this is a
 * testing-network faucet. It MUST NOT be deployed to a public network.
```

这是我很想学的一句注释：**把设计边界写进源码**，防止后人误用。
对照我们的合规线：
- 公网上 cooldown 挡女巫 = 不够（对应 M0 演示轨，只在测试网/港方）
- 联盟网里根本不需要靠合约挡女巫 → **账户白名单 + 实名成员**（`shared/consortium-network/docs/03`）
- 若做 M5 补贴直达，防冒领靠资格数据与银行侧核验，合约只做条件判定

## 6 `dripTo` 的冷却记在受益人身上

```solidity
function dripTo(address to) external nonReentrant { _drip(to); }   // 冷却按 to 计
```

为 burner wallet 代付（relayer 模式）：新账户没有 gas 发不出第一笔交易，由别人替它触发。
**冷却对象是 `to` 而不是 `msg.sender`** —— 这个细节写错就等于给代付方开了无限刷的口子。
与 M5 的"经办方代提交"结构完全同构，也是 P08 之后账户抽象/Gas 代付的现实动机。

## 7 view 函数是为面板设计的

`timeUntilNextDrip(user)`、`reserves()` 都明确注释"for the dapp status panel"。
我的 `previousCount()` / `history()` 同样动机（view 不花 gas）。
差别在于：Faucet 把"还剩多久""还剩多少额度"做成**接口的一部分**，前端不需要自己算时间差。
→ P06 做面板时照这个方式设计合约视图接口，而不是把状态全丢给前端算。

## 8 两个必须对客披露的中心化点

| 位置 | 风险 | 交付时怎么处理 |
|------|------|----------------|
| `rescue(token, to, amount)` onlyOwner | 运营方可提走误转入资产（运维需要）也是资金出口 | 写进信任边界；配多签 + 事件监控（P21） |
| `configure(...)` onlyOwner 即时生效 | 额度与冷却可被单方改动 | 联盟网里改为多签 + 生效延迟（P19 的 Timelock 模式） |

这正好是 `shared/consortium-network/docs/03` 说的"运营方一旦能单方改参数，客户会问这跟给你一台数据库有什么区别"。

## 9 版本与依赖

`pragma ^0.8.24` + OZ（版本未在此文件体现，分析文档记为 v5）；我的 P04 锁 `solc = 0.8.28`。
按开发计划 §八"工具链锁死一个季度"，B 系列与 lainchain 拆件时**统一到同一 solc + OZ 版本**，
否则同一份源码在两个环境里 bytecode 不同，`deployedBytecodeHash` 自证就失效了。

## 一句话总结

`Counter` 教的是"一个合约怎么长"；`Faucet` 教的是"一个合约在真实系统里必须长出什么"——
**权限外置、部分成功、代付与冷却归属、可观测的 view、以及写进注释的设计边界**。
其中"部分成功 + 如实 emit"是我这次最大的收获，它会直接改变 M1/M5 的合约与对账设计。
