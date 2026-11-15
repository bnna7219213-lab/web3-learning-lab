# 02 · nexalink 对照精读：CPHS 实名 Agent 支付嵌入机制

> 源件：属主仓库 nexalink `contracts/cphs/{LainID,CPHSRegistry,PaymentAgent}.sol`
> 与设计文档 `docs/15-CPHS实名Agent支付嵌入机制.md`（2026-10-06）。
> 源件在本机可得，本篇是**逐行对照**，不是凭印象转述。
> CPHS = Cross-Platform Human-Signal / Cognitive-Physiological Hash Signature（用户自定义缩写，非标准术语）。

## 1. 合约 correspondence

| nexalink（生产语境） | P27（学习语境） | 职责 |
|----------------------|-----------------|------|
| `LainID.sol` | `src/LabID.sol` | soulbound 实名身份（信任根），碳基/硅基同构 |
| `CPHSRegistry.sol` | `src/SignalRegistry.sol` | 信号哈希承诺 + 3/5 阈值确认 → 声誉入账 |
| `PaymentAgent.sol` | `src/PaymentAgent.sol` | mandate 四道锁 ∩ tier 双闸门代付 |
| USDT（6 位小数） | `src/LabUSD.sol` | 零价值学习记账单位（6 位小数，精度口径一致） |
| `test/cphs.test.js`（hardhat，21 例） | `test/*.t.sol`（forge，78 例）+ `scripts/acceptance.mjs`（26 项） | 安全属性钉死 |

## 2. 保留的核心机制（逐条同构）

- soulbound `_update` 单漏斗；一地址一 ID；仅 REGISTRAR 铸造；PII 只存 `kycCommit` 哈希
- tier 阈值 rep 100/500/2000 → T1/T2/T3；负 delta 钳制到 0
- 信号去重键 `(subject, domain, sigHash)`；24h 新鲜度 + 1h 时钟容差
- EIP-191 阈值签名 3/5；同一验证者防重签；权重表 10/30/40/20
- `ResonanceUnlocked` 共鸣钩子事件（GameFi 接口留而未实现）
- mandate 四道锁；创建即钳制到 tier；执行时点二次校验 tier；撤销/过期即时生效
- `reasonRef` 决策留痕（借鉴智慧医院 `agent_run/agent_step` 全程留痕模式）
- 调用者语义：`payer` 本人 **或** `AGENT_ROLE`（nexalink 在 AA 集成中发现并修正的缺陷，P27 直接采用修正后语义）

## 3. 差异与加固（每条都有测试证据）

### 3.1 执行时点补上 tier **累计**闸门（真实缺陷修复）

参考实现 `pay()` 只二次校验 tier 单笔上限：

```solidity
// nexalink PaymentAgent.pay()
if (amount > tierPerTxLimit[tier]) revert ExceedsTierLimit(amount, tierPerTxLimit[tier]);
```

缺口：T3 主体创建 mandate（累计 30,000）并支出 10,000 后降级到 T1（累计上限 300），
仍可以每笔 ≤100 继续付到 30,000——`remainingAllowance()` 视图早已归零，但 `pay()` 不查它。
**视图与执行不一致**：动态风控只收紧了单笔，没收紧累计。

P27 补上第二道：

```solidity
if (amount > tierPerTxLimit[tier]) revert ExceedsTierLimit(amount, tierPerTxLimit[tier]);
if (m.spent + amount > tierTotalLimit[tier]) revert ExceedsTierLimit(m.spent + amount, tierTotalLimit[tier]);
```

证据：`PaymentAgent.t.sol:test_Pay_TierDowngradeTightensPerTxAndTotal`（降级后单笔 500 被拒、
单笔合规的 100 也因累计 600 > 300 被拒）、`Isomorphism.t.sol:test_DowngradeAppliesToAgentToo`。

### 3.2 错误语义显式化（不复用、不隐藏）

| 场景 | nexalink | P27 | 理由 |
|------|----------|-----|------|
| 重复添加验证者 | `AlreadySigned(0, v)` 复用 | `VerifierAlreadyAdded(v)` | 复用错误让审计日志歧义 |
| 查询不存在身份 | `NoIdentity(msg.sender)` | `UnknownIdentity(tokenId)` | 参考实现报的是调用者而非查询对象 |
| 非授权人撤销 | `MandateNotFound`（隐藏存在性） | `UnauthorizedRevoker(caller)` | 学习项目优先可诊断性；生产若需隐藏存在性可改回 |
| T0 创建授权 | 钳制后 `ExceedsTierLimit(0, 0)` | `TierTooLow(tier)` | (0,0) 参数无信息量 |
| 零 sigHash | `ZeroAddress()` 复用 | `ZeroSigHash()` | 语义分离 |
| 非法 kind | enum 转换 panic（0x21） | `BadSignalKind(kind)` | 自定义错误可被测试选择器级断言 |

### 3.3 权重治理入口 + int256 上界

参考实现权重表构造时固定。P27 增加 `setKindWeight(kind, weight)`（DEFAULT_ADMIN），
并钳制 `weight ≤ int256.max`——否则 `int256(weight)` 转换在极端治理值下溢出。
证据：`SignalRegistry.t.sol:test_SetKindWeight_GovernanceAndInt256Bound`。

### 3.4 命名与域分隔

- digest 前缀 `"CPHS-Confirm"` → `"LabSignal-Confirm"`（学习项目独立域，防与生产签名跨域重放）
- `CPHS_ROLE` → `SIGNAL_ROLE`；`lainId` → `labId`；`usdt` → `token`
- 铸造增加显式 `subject != address(0)` 检查（参考依赖 OZ `_mint` 内部拒绝）

### 3.5 测试体系升级

- hardhat 21 例 → **forge 78 例**（6 suites：身份 16 / 信号 24 / 支付 22 / 同构 9 / 不变式 4 / 记账单位 3，
  含 fuzz 500 轮与 invariant 64×32），行/函数覆盖率 100%
- 新增 **26 项 anvil 端到端验收**（零私钥解锁账户 + 真实 EIP-191 签名管线）
- 新增 **Agent 运行时演示**：六步决策日志 ↔ 链上事件对账 + 超界 escalate 零交易路径
- 断言口径吸收 nexalink docs/15 §6.5 的教训：**选择器级断言**，不写「失败了就行」——
  `mustRevert` 解析 revert data 比对错误名，避免「被另一层拦截也算通过」的假阳性

## 4. 未搬过来的部分（边界说明）

| nexalink 已有 | P27 状态 | 原因 |
|---------------|----------|------|
| AA 会话密钥 × `executeAgentPayment` 双路径白名单 | 未搬 | 依赖 NexaLinkSmartAccount/EntryPoint/Paymaster 全家桶；P27 聚焦合约层机制，AA 集成属 B 线后续 |
| Paymaster 跨账户盗用补贴四层隔离 | 未搬 | 同上 |
| EIP-712 用户直签 mandate | 未搬（接口留） | 当前 payer 地址登记 + approve 是真实同意锚点 |
| EIP-1271 合约签名验证者 | 未搬（接口留） | 验证者当前为 EOA 多签 |
| 罚没治理合约 | 未搬 | `addReputation` 负 delta 能力已留，测试中由治理角色演练 |

## 5. 精读路径建议

1. 先读 nexalink `docs/15` §0–§3（需求 → 三层设计答案 → 安全属性），建立问题意识
2. 对照读 `LainID.sol` ↔ `LabID.sol`（最短，信任根）
3. 读 `CPHSRegistry.sol` ↔ `SignalRegistry.sol`，重点看 confirm 的 digest 重构与阈值入账
4. 读 `PaymentAgent.sol` ↔ `PaymentAgent.sol`，**重点看 §3.1 的累计闸门差异**
5. 跑 `forge test --match-contract IsomorphismTest -vv`，看硅基主体走完整管线到 T3 自主支付
6. 最后读 nexalink `docs/15` §6（AA 集成），理解合约层之上还有一层账户层作用域——
   以及为什么「账户层管选择器白名单、Agent 层管金额对象时效」的职责分离是必要的