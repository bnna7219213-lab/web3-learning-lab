# B09 · 链上数据平台（联盟网）

> 状态：**已完成，本机实测通过（Besu QBFT 4 验证者 + LabCredential/LabFaucet 真实链上数据，验收 20 项全绿）** ｜ 对应主线：[P09](../P09-链上数据平台进阶/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
> 一句话目标：把 P09 的自建索引器 + BFF + 看板接到联盟链上：权益凭证与水龙头额度的链上事实变成**可查询、可对账、可出证**的 API。

## 与 P09 的关系

**功能实现一致，链语义不同。**P09 的索引器/看板/REST 六件套在本分支原样可用（`db.js/scanner.js/server.js/run.js/frontend` 逐字节同构），
差异只在**链语义**与**事件源**，共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。

| 维度 | P09（anvil） | B09（联盟 QBFT） | 落点 |
|------|--------------|------------------|------|
| 事件源 | P07 三件套（LabNFT/LabEditions/NFTMarket） | **LabCredential（12 事件）+ LabFaucet（4 事件）** | `indexer/abi.js` 事件注册表整体换掉 |
| confirmations 深度 | 2（公链式等确认） | **0** —— QBFT 单块终结 | 「等 N 块」变「等跨节点一致性核对」 |
| 分叉测试 | anvil `evm_snapshot/evm_revert` 人为分叉 | **注入式**：篡改本地块哈希模拟被重组 | 联盟链不做人为分叉（会伤 4 验证者一致性） |
| 批次筛选 | listingId/orderHash | **`CredentialIssued.batchId`**（1000 份分 4 笔的批次号） | 看板主力筛选列 |
| 权限负例 | —（P 分支没有这个维度） | **`TransferBlocked` 审计事件可查**（被拒的转让带 reason 留痕） | 差异矩阵第 4 条 |
| 多成员 | anvil 解锁账户 | memberA/memberB 各自账户发交易，nonce 不串 | 验收 F-1 |

## 知识点

- [x] P09 全部六条（扫块过滤 / 重组与深度 / 幂等与游标分页 / 表设计 / REST 与鉴权）——代码同构，见 [P09 README](../P09-链上数据平台进阶/README.md)
- [x] **QBFT 终结性替代 confirmations 深度**：单块终结 ⇒ 不需要「等 N 块」，但需要**跨 3 节点核对同一块哈希**（验收 F-3）
- [x] **权限负例留痕入索引**：`TransferBlocked(actor, from, to, tokenId, reason)` 被拒的转让也有可查询的审计记录（验收 A/F-4）
- [x] **多成员账户体系下的数据归属**：两个成员账户的交易各自入索引、nonce 不串（验收 F-1）
- [x] **零 gas 语义**：`eth_gasPrice=0` + `baseFee=0`，但**本金检查不豁免**（余额 0 发 value>0 被节点拒；value=0 畅通）

## 技术栈

- 索引器 worker：Node ≥ 22.5（内置 `node:sqlite`）+ `ethers`（唯一依赖）
- 存储：SQLite（表设计与 P09 同构，PG DDL 对照见 [P09 docs/01](../P09-链上数据平台进阶/docs/01-设计.md)）
- 看板：零构建静态页（批次/合同号/持有人筛选 + SVG 事件分布）

## 目录

```text
B09-链上数据平台联盟网/
├── indexer/
│   ├── config.js            联盟网配置（8551/19880601，confirmations=0，合约读 B07 部署记录）
│   ├── abi.js               事件注册表：LabCredential 12 + LabFaucet 4（批次列=batchId）
│   ├── migrations/001-init.sql  与 P09 同构
│   ├── db.js / scanner.js / server.js / run.js   与 P09 同构（重组协议/游标分页/鉴权）
├── frontend/                看板（同 P09）
├── scripts/
│   ├── lib.mjs              多节点终结性核对 + 成员账户（读 B07 env/.env.local）+ 断言
│   ├── 01-gen-events.mjs    多成员活动：领水 → 互转（1 wei / 0 wei）
│   └── 02-acceptance.mjs    验收 20 项（A–F 六组）
└── docs/01-设计.md          B09 差异设计（终结性/注入式回滚/批次列/审计留痕）
```

## 运行

```bash
# 0) 前置：联盟网 4 验证者在跑（8551–8554）+ B07 已部署 LabCredential/LabFaucet
# 1) 装依赖 + 制造多成员活动
cd projects/B09-链上数据平台联盟网
npm install                     # 只装 ethers
node scripts/01-gen-events.mjs  # 领水 + 成员互转（读 B07 env/.env.local 的成员私钥）

# 2) 索引 + BFF + 看板
node indexer/run.js serve       # → http://127.0.0.1:8802 （全量同步约 28k 块，一次性）

# 3) 验收（20 项）
node scripts/02-acceptance.mjs
```

环境变量：`RPC` `RPCS`（终结性核对的节点列表）`CHAIN_ID` `DB_PATH` `CONFIRMATIONS` `LOG_CHUNK` `START_BLOCK` `CONTRACTS` `API_PORT` `API_KEY` `POLL_MS`；验收脚本另认 `REUSE_DB=1`（复用已同步的库，免重复 7 分钟全量同步）。

## 验收（实测记录，2026-11-13，20/20 全绿）

| 组 | 断言 | 结果 |
|----|------|------|
| 0. 全量同步 | 从块 0 同步到链头：blocks=28654 txs=240 logs=3171（一次性 ~7 分钟） | ✅ |
| A. 链上正确性 | `CredentialIssued` 的 count 合计 == 链上 `nextId`（3069 == 3069）；Payout 事件数与链上 `eth_getLogs` 一致（8 == 8）；TransferBlocked 审计 3 条可查 | ✅ |
| B. 分页稳定 | 首页 5 条 + nextCursor（9ms）；翻页途中出新块（memberA 调 `fund(0)` 产生新日志），第二页零重复 | ✅ |
| C. 注入式回滚重放 | 篡改游标高度块哈希 → 检测 `kind=fork` → rolledBackTo=祖先 → **该块哈希自愈（== 链上）** → 重放不丢数据 | ✅ |
| D. 筛选 < 1s | 合同号+事件 17ms（20 条）/ 批次 batchId 2ms / 持有人 12ms | ✅ |
| E. 幂等 | 重复 sync 行数不变（28654/240/3171） | ✅ |
| F. 联盟网四条 | ①多成员：memberA 20 笔 / memberB 15 笔各自入索引 ②零 gas：`eth_gasPrice=0x0` `baseFee=0x0` ③终结性：块哈希 3 节点一致 ④权限负例：TransferBlocked 带 reason 可查 | ✅ |

**合计 20 项全绿（pass=20 fail=0）**。

## 联盟网特有的坑（本轮实测）

1. **`env/.env.local` 的行内注释**：`KEY=0xabc… # 0x地址` —— 不剥 `#` 后缀会被 ethers 当成密钥的一段，
   报 `invalid BytesLike value`。解析 `.env` 必须 `value.split("#")[0].trim()`。
2. **零 gas 免手续费不豁免本金**（B03 老坑再次应验）：余额 0 的成员账户发 `value=1` 被节点直接拒
   （`-32004 Insufficient funds for transfer`）。`01-gen-events` 的顺序即演示：先领水拿本金 → 1 wei 互转 →
   零余额账户发 `value=0` 照样入块。
3. **Besu `eth_getLogs` 单次区间上限 5000 块**：`0..latest` 的复核查询会被拒
   （`Requested range exceeds maximum RPC range limit`）——**验收脚本的独立复核也要分片**，
   只有索引器分片是不够的。
4. **筛选值的大小写**：地址列入库小写（查询也小写），但 `eventName` 是大小写敏感的
   （`Transfer` ≠ `transfer`）——把所有筛选值统一 `toLowerCase` 会让事件名过滤**永远 0 条**。
   P09/B09 都修了（地址列小写、事件名原样），验收 D 组收紧为「必须返回 >0 条」。
5. **注入式回滚测试的注入点必须在游标高度**：真实分叉里「被换的块」就是索引器刚收下的那块。
   篡改游标**以下**的块属于本地 DB 损坏，`findCommonAncestor`（自顶向下找第一个分叉点）不会也
   不必去发现它——测试要贴真实语义，否则断言测的是不存在的行为。

## 复盘

- **同构复用的边界**：`db.js/scanner.js/server.js/run.js/frontend` 逐字节与 P09 相同——
  联盟网差异全部收敛在 `config.js`（链语义）与 `abi.js`（事件源）两个文件里。
  「功能一致、环境语义不同」的 B 分支原则在数据平台上兑现得很干净。
- **QBFT 的「无分叉」不是没有回滚逻辑的理由**：索引器的回滚协议仍然全量保留并实测（注入式）——
  因为**本地 DB 损坏 / 节点切换 / 快照恢复**都会走到同一条代码路径。联盟链只是让「真实分叉」这个触发源消失，
  没有让回滚能力变成多余。
- **可对账、可出证落到查询上**：`CredentialIssued.count` 合计 == 链上 `nextId` 是**事件口径与状态口径的交叉核对**
  （验收 A-1）——这类断言正是「链上数据平台」区别于普通报表的地方：任何一方被篡改都能被另一方揭穿。
- **全量同步 7 分钟是教学可接受、生产不够快**：逐块 `eth_getBlockByNumber(n, true)` 是瓶颈。
  生产化路径：并发拉块 + 只对含交易的块取详情 + 快照冷启动（BFF 的 `/admin/rollback` 已留好接口）。
- 待补：Spring Boot + web3j 消费同一 REST 契约的 Java 侧对接（P09 知识点第 6 条）。

## 验收（质量门禁）

- [x] 事件可查询且分页稳定
- [x] 分叉/损坏后索引能回滚重放（注入式，联盟链不做真实分叉）
- [x] 看板按合同号/批次筛选 <1s（实测 2–17ms）
- [x] README 可按步骤复现
- [x] 仓库零私钥（成员私钥只在 `B07/env/.env.local`，`git check-ignore` 已验证）
- [x] B 分支四条增量（多成员 / 零 gas / 终结性 / 权限负例）全部落验收

