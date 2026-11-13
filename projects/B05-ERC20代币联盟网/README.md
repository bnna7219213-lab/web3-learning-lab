# B05 · 代币与权限（联盟网）

> 状态：**已完成，本机实测通过（forge 49 项 + 链上验收 20 项全绿）** ｜ 对应主线：[P05](../P05-ERC20代币基础/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
> 一句话目标：在联盟环境实现「内部积分/权益代币」，重点不是发币，而是**谁能发行、谁能销毁、跨成员如何授权**。

## 与 P05 的关系

**功能实现一致，环境语义不同。**P05 的全部知识点在本分支都要做一遍（合约**零改动**，36 项测试原样全绿），
本 README 只记录**差异与新增验收**；共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P09-vs-B03-B09.md)。

| 维度 | P05（公链/anvil） | B05（联盟 QBFT） |
|------|------------------------|----------------------|
| 代币定位 | 公链可流通资产 | **联盟内部记账单位**：不可对外转让、不可兑换法币、无二级（依据见 [docs/01](docs/01-合规三条依据.md)） |
| 发行权 | 合约 owner | **角色治理**：DEFAULT_ADMIN（运营方）与 MINTER（发行方）分离，变更打事件留痕 |
| 合规 | 面向公众即触碰红线 | 限定成员范围 + 合同依据（去代币化检查表口径） |
| 技术新增 | — | 角色矩阵测试（8 负例 + 4 正例）+ 链上对账验收（100 笔零差异） |

## 知识点

- [x] AccessControl 角色与成员组织的映射（运营方/审计方/成员）—— `deployments/roles.json` 五身份矩阵 + `test/RoleMatrix.t.sol`
- [x] mint/burn 的治理：谁可 mint（MINTER_ROLE）、谁可 burn（持币人自毁 + allowance 代销毁）、改角色只认 DEFAULT_ADMIN
- [x] EIP-2612 permit 在无 gas 环境的意义变化——免签名单据语义不变（`Permit.t.sol` 原样全绿）；gas=0 反而让「代付 gas」不再是 permit 的卖点，**签字授权本身**才是
- [x] 内部积分与「变相代币」的合规边界——[docs/01 合规三条依据](docs/01-合规三条依据.md)（用途限定/发行受控/无投机属性）
- [x] 精度与四舍五入方向（联盟对账口径必须一致）——向下取整、dust 留池、不超发（invariant 测试钉死）

## 技术栈

- Solidity 0.8.28 + OpenZeppelin v5 + Foundry（`FOUNDRY_PROFILE=consortium` → `evm_version=london`，B04 坑 2）
- 链上验收：node + ethers v6（显式 `gasPrice=0 / type=0`，零私钥入库——读 `B07/env/.env.local`）
- 角色配置：`deployments/roles.json`；审计流水：`data/audit.jsonl`（被拒操作双路留痕）

## 目录

```text
B05-ERC20代币联盟网/
├── src/LabToken.sol            与 P05 逐字节相同（合约零改动）
├── test/                       P05 四件套原样 + RoleMatrix.t.sol（角色矩阵 13 项）
├── script/                     Deploy.s.sol + deploy.sh（consortium profile 自动 london）
├── scripts/
│   ├── lib.mjs                 RPC/多节点终结性/成员账户/断言（B09 同款）
│   ├── 01-acceptance.mjs       链上验收 20 项（角色矩阵/对账/四条增量/跨成员授权）
│   └── export-transfers.mjs    Transfer 事件导出（P05 同款）
├── docs/01-合规三条依据.md      「本代币不是虚拟货币」的三条依据
├── deployments/roles.json      角色矩阵配置
└── data/audit.jsonl            应用层审计流水（gitignore）
```

## 运行

```bash
cd projects/B05-ERC20代币联盟网
npm install                                # 只装 ethers
FOUNDRY_PROFILE=consortium forge test      # 49 项（36 基座 + 13 角色矩阵）
node scripts/01-acceptance.mjs             # 链上验收 20 项（需本地联盟网 8551–8553 在跑）
node scripts/export-transfers.mjs          # （可选）导出 Transfer 事件流水
```

**分支共用四条增量**：多成员 ✅（A/B 两账户 100 笔互转、nonce 31→81 与 23→73 各自独立）· 零 gas ✅ · 终结性 ✅（3 节点块哈希一致）· 权限负例 ✅（未授权 mint/transferFrom 的 status=0 回执 + `data/audit.jsonl` 双路留痕）。

**本分支特有**：角色矩阵 ≥6 条负例 ✅（8 条，forge + 链上双跑）· 文档三条依据 ✅（[docs/01](docs/01-合规三条依据.md)）· 跨成员 100 笔零差异 ✅ · README 可复现 ✅ · 去代币化口径 ✅（合规文档即检查表落点）。

## 联盟网特有的坑（本轮实测）

1. **revert 的交易 `wait()` 会抛出而不是返回 receipt**：负例要的恰恰是那个 receipt（status=0）——
   必须 `try { tx.wait() } catch (e) { e.receipt }`。不包 try 的脚本会在第一条负例上崩掉，看起来像"负例失败"。
2. **`CapExceeded(cap, attempted)` 的 attempted 是 `totalSupply + value`**：setUp 里已铸过币时，
   期望值要按当前总量算，写死 `CAP+1` 会 diff 失败（含义没错、算式错）。
3. **部署者不需要余额**：`value=0 + gasPrice=0 ⇒ 成本 0`，零余额账户照样部署合约（B04 零 gas 语义的正面演示）；
   但**转账面值**照扣本金——mint 出来的 LAB 不影响原生余额。
4. **100 笔并发不会等 100 个块**：带显式 nonce 并发发出后，打包器把它们塞进少数几个块
   （实测 4.9s 全部入块）——「对账脚本很慢」是误区，慢的是逐笔 wait，不是链。

## 复盘

- **与 P05 相比最意外的差异**：不是功能，而是**「谁能发」从代码问题变成了治理问题**。
  P05 里 `onlyRole(MINTER_ROLE)` 是一个测试断言；B05 里它是「运营方/发行方/成员」三方职责的映射，
  测试矩阵的每个格子都要回答"这个身份该不该有这个动作"——合约一行没改，语义却换了验收口径。
- **负例的价值在留痕**：`expectRevert` 只证明"挡住了"；B05 追加的预检（可读原因给前端）+
  status=0 回执（链上留块）+ `audit.jsonl`（应用流水）才是**可审计**的三件套。
- **对客交付时客户最关心的问题**：「这东西会不会变成变相融资工具」。答案不是技术承诺，
  而是三条依据（用途/发行/价格锚定）+ 可核验手段（holder ⊆ 成员集合、事件对账）——合规文档按这个结构写。
- 待补：mint/burn 治理的多签 + 时间锁演进（P08 的 UUPS/时间锁工具可直接套）、
  合约级转让白名单（若客户要求，B07 的 `_update` 策略移植即可）。

## 验收（质量门禁）

- [x] `FOUNDRY_PROFILE=consortium forge test` 49/49（含角色矩阵 8 负例）
- [x] 链上验收 20/20（对账零差异、多成员 nonce 不串、零 gas、3 节点终结性、负例留痕）
- [x] 文档写清「本代币不是虚拟货币」的三条依据（docs/01）
- [x] README 可按步骤复现
- [x] 仓库零私钥（读 `B07/env/.env.local`，gitignore 覆盖）
- [x] 去代币化检查表口径通过（合规文档即落点；无对外交付场景）

## 验收（实测记录，2026-11-13，forge 49/49 + 链上 20/20）

**forge 测试**：49 项全绿——P05 原 36 项（含 4×500 fuzz + invariant 64×32）+ 角色矩阵 13 项
（8 条负例：未授权 mint×2 / 越权 grant×2 / 越权 revoke×2 / 无授权 burnFrom / 超 CAP 铸造，全部 revert 且错误数据带 (account, role)）。

**链上验收（`scripts/01-acceptance.mjs`）**：

| 组 | 断言 | 结果 |
|----|------|------|
| A. 角色矩阵 | grantRole 打 `RoleGranted` 留痕；未授权 mint **预检可读原因**（`AccessControlUnauthorizedAccount(0xB4e2…, 0x9f2d…)`）+ 交易 **status=0 入块留痕**；revoke 打 `RoleRevoked` 且**收回即生效**（再铸 revert + 失败交易留块） | ✅ 7 项 |
| B. 对账 | 运营方各铸 500 → 两成员并发 **100 笔互转**（4.9s 全部入块）→ **链上余额 == 链下台账（500.0 = 500.0）**；事件重放净额 == 余额；100 笔来源交易可追溯（102 条 Transfer）；**nonce 各自连续不串**（A 31→81，B 23→73） | ✅ 7 项 |
| C. 四条增量 | 零 gas（`eth_gasPrice=0x0` `baseFee=0x0`）；终结性（块哈希 3 节点一致） | ✅ 2 项 |
| D. 跨成员授权 | approve 入块 → transferFrom 代扣成功 → 授权额度精确扣减至 0；**无授权 transferFrom 被拒且留块** | ✅ 4 项 |

## 与 B09 联动

`deployments/19880601/LabToken.json` 是 B09 的联盟网事件源（不能用 anvil 的 `latest.json` 代替）。B09 索引 `Transfer/Approval/RoleGranted` 等事件，按 ERC20 日志布局解码，独立重放 `fungibleBalances` 并与链上 `balanceOf` 对账；不会把 ERC20 金额误计为 NFT tokenId。联动断言与看板证据见 [B09 验收记录](../B09-链上数据平台联盟网/docs/02-验收记录.md)和[全联盟链路全景](../../shared/consortium-network/docs/06-全联盟链路全景.md)。
