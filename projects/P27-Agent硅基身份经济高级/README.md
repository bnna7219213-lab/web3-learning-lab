# P27 · Agent 硅基身份经济（高级）

> 状态：**已完成，本机实测通过（anvil 部署 + 26 项端到端验收）** ｜ 层级：高级（S5）｜ 主线：合约 + Agent 运行时 ｜ 依赖：P05 / P07 / P08 ｜ 更新：2026-11-15
> 一句话目标：给链上与支付流程中的 Agent 一个**可认定、可积累、可授权、可问责**的经济身份——碳基与硅基同一套规则。
> 机制参考：属主仓库 nexalink 的 CPHS 实名 Agent 支付嵌入机制（`contracts/cphs/` + docs/15），逐行对照见 [docs/02](./docs/02-nexalink对照-CPHS.md)。
> 合规边界：LabUSD 是**学习记账单位**，零价值、无行情/兑换/募资语义；「KYC」为链下模拟，PII 永不上链。

## 运行

```bash
cd projects/P27-Agent硅基身份经济高级
forge build                      # solc 0.8.28 + OZ v5.0.2（vendored，与 P05 同源）
forge test                       # 78 项：6 suites，fuzz 500 轮 + invariant 64×32
forge coverage                   # 行/函数覆盖率 100%

anvil                            # 另开终端
bash script/deploy.sh anvil      # 零私钥：anvil 解锁账户 + --unlocked；四合约 + 角色布线 + deployments/ 记录

npm install                      # ethers（与 B03 同版本口径）
npm run acceptance               # 26 项端到端验收（结束回退快照，可重复跑）
npm run agent-demo               # Agent 运行时演示：边界内自主支付 + 超界升级回用户
```

联盟网 profile（`env/consortium.env`，london 编译避开 PUSH0）与 sepolia profile 配置就绪，
沿用 P05 的两层 profile 设计；本项目实测在 anvil 完成。

## 目录

```text
P27-Agent硅基身份经济高级/
├── foundry.toml              default/test/release/consortium(london) + fuzz/invariant（沿用 P05）
├── src/
│   ├── LabID.sol             soulbound 身份：一地址一 ID / PII 只存承诺 / isAgent 同构 / tier 阈值推导
│   ├── SignalRegistry.sol    信号哈希承诺 + 3/5 EIP-191 阈值确认 → 声誉入账 + ResonanceUnlocked 钩子
│   ├── PaymentAgent.sol      mandate 四道锁 ∩ tier 双闸门；执行时点二次校验（单笔+累计）；reasonRef 留痕
│   └── LabUSD.sol            6 位小数学习记账单位（零价值）
├── test/                     78 项：LabID 16 / SignalRegistry 24 / PaymentAgent 22 / Isomorphism 9 / Invariant 4 / LabUSD 3
├── script/Deploy.s.sol       四合约部署 + 角色布线 + DeploymentRecorder（指纹随编译参数落盘）
├── script/deploy.sh          网络分发器；anvil 零私钥路径；consortium 拒绝回落根 .env
├── scripts/
│   ├── lib.mjs               ethers + anvil 解锁账户公共层（零私钥）+ 信号管线 + 选择器级断言
│   ├── acceptance.mjs        26 项验收：A 身份 / B 信号 / C 同构 / D 支付 / E 运行时审计
│   └── agent-demo.mjs        Agent 运行时：六步决策日志（agent_run）↔ 链上事件对账
├── env/{anvil,sepolia,consortium}.env   无密钥入库
├── abi/ · deployments/       自动生成（四合约 ABI + selectors；按 chainId 分目录 + latest.json）
├── docs/                     01 三层机制与双闸门 · 02 nexalink 对照精读（含一处真实缺陷修复）
└── data/agent-runs/          运行时决策日志（gitignore）
```

## 知识点

- [x] **soulbound 身份与女巫抗性**：`_update` 单漏斗、一地址一 ID、仅 REGISTRAR 铸造、PII 只存哈希承诺
- [x] **碳基/硅基同构**：`isAgent` 是标签不是特权——同一信号协议、同一 tier 表，T0 的 Agent 一样不能代付
- [x] **信号承诺 → 阈值确认 → 声誉**：去重键 `(subject, domain, sigHash)`、24h 新鲜度、3/5 EIP-191、防重签
- [x] **双闸门授权**：`min(mandate, tier)`；创建即钳制；四道锁（限额/限对象/限时/一次性登记）
- [x] **动态风控**：执行时点二次校验 tier，降级 → 单笔**与累计**额度同时收紧（相对参考实现的加固，docs/02 §3.1）
- [x] **条件语义链下化**：conditionHash 锚定 + reasonRef 指向 agent_run 决策日志；条件判错，损失有界
- [x] **硬边界不可省**：超界 → escalate-to-user，零交易回到用户签名
- [x] **选择器级安全断言**：mustRevert 解析 revert data 比对错误名，拒绝「失败了就行」的假阳性

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1 + forge-std + OpenZeppelin v5.0.2（vendored，非 submodule）
- 验收/运行时：Node + ethers ^6.17.0，anvil 解锁账户（零私钥，与 B03/P09 同口径）
- 网络：anvil（cancun，已实测）· Besu QBFT（london，配置就绪）· Sepolia（配置就绪）

## 验收（实测记录，2026-11-15）

| 项 | 结果 |
|----|------|
| forge test | **78 passed / 0 failed**（6 suites）；fuzz 3 项各 500 轮；invariant 4 条 × 64 runs × depth 32 |
| forge coverage | 四合约 **100% 行 / 100% 函数**；语句 98.68% / 分支 92.73% |
| anvil 部署 | LabUSD `0x5FbD…0aa3` · LabID `0xe7f1…0512` · SignalRegistry `0x9fE4…a6e0` · PaymentAgent `0xCf7E…0Fc9`；admin=0xf39F…2266；指纹随记录落盘 `deployments/31337/P27.json` |
| 端到端验收 | **26/26 全绿**（A 身份 4 / B 信号 6 / C 同构 3 / D 支付 9 / E 运行时审计 4）；结束回退快照可重复跑 |
| 硅基端到端 | Agent 指纹信号 ×100（真实 3/5 签名管线）→ rep 2000 → T3 → mandate 10000/30000 → 运行时免用户操作代付，双向余额对账 ✓ |
| Agent 运行时 | 边界内账单 1200：`outcome=paid`，tx `0x1878df70…`，六步决策日志 ↔ 链上事件（reasonRef/金额/条件哈希）一致；超界账单 50000：`outcome=escalate-to-user`，**零交易** |
| 双闸门负例 | 单笔 10001→ExceedsPerTxLimit / 付满 30000+1→ExceedsTotalLimit / 降级后累计收紧→ExceedsTierLimit / 撤销→MandateInactive / 过期→MandateExpired / 冒用→UnauthorizedPayer，全部选择器级断言 |
| 同构负例 | T0 碳基与 T0 硅基均 TierTooLow；无身份 NoLabID；硅基身份 soulbound 转让被拒 |
| 仓库零私钥 | env/*.env 无密钥；部署/验收/签名全走 anvil 解锁账户；consortium 拒绝回落根 .env |
| 去代币化 | LabUSD 零价值记账单位，NatSpec 写明边界；无行情/兑换语义 |

## 过程中修掉的真实缺陷（都有教学价值）

1. **`vm.expectRevert` 被中间外部 view 调用消耗**：`_sig()` 内部调 `commitmentOf()`，
   expectRevert 作用到了它而不是 `confirm()`——5 个负例假失败。修法：先算签名再设期望。
   （P05 坑 #5 的变体：那次是 `vm.prank` 被消耗，这次是 `expectRevert`。）
2. **`vm.prank(admin)` 被 `id.SIGNAL_ROLE()` 消耗**：Invariant setUp 的 grantRole 以默认 sender 执行被拒。
   修法：角色常量先读进状态变量（P05 坑 #5 原样复现，说明它值得反复踩）。
3. **验收 B05 的 AlreadyConfirmed 掩盖 NotVerifier**：对已确认承诺测非验证者签名，
   先命中 `AlreadyConfirmed`——「被另一层拦截也算失败」的假阴性。修法：用新承诺测验签层。
   与 nexalink docs/15 §6.5 的 AA21 掩盖陷阱同源：**断言必须钉到预期的那层**。
4. **happy path 金额与 tier 表不自洽**：T2 单笔上限 1000 却付 1500。测试设计要先对表再写数。

## nexalink 对照精读（已完成）

- [x] [docs/02-nexalink对照-CPHS.md](./docs/02-nexalink对照-CPHS.md)：源件逐行对照 + 一处真实缺陷修复
  （参考实现执行时点只校验 tier 单笔、漏了累计——视图与执行不一致）+ 错误语义显式化 + 未搬部分边界说明
- 机制设计详解：[docs/01-三层机制与双闸门.md](./docs/01-三层机制与双闸门.md)

## 复盘

- 卡住的点：三层合约的**层间语义一致性**比单层正确性更难——视图（remainingAllowance）与执行（pay）
  对 tier 累计上限的口径必须一致，参考实现恰好在这里留了缝。跨层不变式（invariant suite）是抓这类缝的网。
- 与 Java/传统后端的对照：mandate ≈ 预授权委托（限额/限对象/限时），tier ≈ 风控等级，
  reasonRef ≈ 审计日志外键；区别在于边界由合约强制执行，不依赖运行时自律。
- 下次可压缩的时间：信号管线的签名辅助函数（lib.mjs pushSignal）可直接复用到 B 线联盟网版。