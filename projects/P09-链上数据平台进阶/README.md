# P09 · 链上数据平台（进阶）

> 状态：**已完成，本机实测通过（anvil + P07 三件套事件源，验收 20/20 全绿）** ｜ 里程碑：M2·W9 ｜ 层级：进阶 ｜ 主线：数据 ｜ 依赖：P07 ｜ 更新：2026-11-13
> 一句话目标：自建索引器 + BFF + 看板，把链上事件变成可查询、可对账、可出证的 API（你的 Java 主战场）。

## 目标

自建索引器 + BFF + 看板，把链上事件变成可查询、可对账、可出证的 API（你的 Java 主战场）。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [x] 扫块与日志过滤（address/topics）—— `indexer/scanner.js`：`eth_getLogs` 按合约地址过滤、按高度分片（`LOG_CHUNK`，Besu 单次区间上限 5000 块），未知 topic0 不猜语义、原始数据照存
- [x] 区块重组与 confirmations 深度 —— `scanner.js` 三步协议：链回卷 / parentHash 不连续找公共祖先回滚 / 只扫 `safe = head - confirmations`；anvil `evm_snapshot+evm_revert` 人为分叉实测回滚重放
- [x] 幂等写入与游标/分页 —— 主键=链上不可变标识（`blockHash+logIndex` / `txHash`），重复扫描不重复计数；API 游标=`blockNumber:index` 倒序，翻页途中出新块不打乱已翻页
- [x] 表设计（tx/log/asset/holder）—— `migrations/001-init.sql`；SQLite 落地 + [docs/01-设计.md](docs/01-设计.md) 给出 PostgreSQL DDL 对照与索引选择
- [x] REST 与鉴权 —— `indexer/server.js`：游标分页 + 六维筛选 + `X-API-Key` 管理口（同步/回滚）+ `x-response-ms` 延迟观测；GraphQL 作为可替换的读层（同一 Store 查询函数，见设计文档）
- [ ] Spring Boot + web3j 对接 —— **后续项**：BFF 的 REST 契约已固定（见设计文档 §4），Java 侧消费同一 API 即可，无需重复造索引器

## 技术栈

- 索引器 worker：Node ≥ 22.5（内置 `node:sqlite`，零原生编译）+ `ethers`（唯一依赖：keccak/ABI 解码）
- 存储：SQLite（教学口径对齐 PostgreSQL 表设计，DDL 对照见 docs/01）
- 看板：零构建静态页（HTML+JS+手写 SVG 图表；与 B03 内网浏览器同风格）

## 目录

```text
P09-链上数据平台进阶/
├── indexer/
│   ├── config.js            RPC/合约清单/confirmations/端口（全环境变量）
│   ├── migrations/001-init.sql  blocks/txs/logs/assets/holders/cursor + 索引
│   ├── db.js                数据层：幂等写入 / 回滚 / 派生状态重放 / 游标分页查询
│   ├── abi.js               事件注册表（P07 三件套 14 个事件）+ 解码 + 过滤列抽平
│   ├── scanner.js           扫块 + 重组协议（回滚重放）+ confirmations 深度
│   ├── server.js            BFF：REST + 游标分页 + 筛选 + X-API-Key + 静态看板
│   └── run.js               CLI：sync | watch | serve
├── frontend/                零构建看板（卡片 + SVG 事件分布 + 筛选表 + 持有人）
├── scripts/
│   ├── lib.mjs              RPC / anvil 快照回退 / 断言（零私钥：解锁账户）
│   ├── 01-gen-events.mjs    制造 P07 事件流：铸造/转移/授权/挂单/成交/租期
│   └── 02-acceptance.mjs    验收 20 项（A-F 六组）
├── docs/01-设计.md          表设计 / 重组协议 / 游标分页 / PG DDL 对照 / REST 契约
└── data/                    SQLite 落盘（gitignore）
```

## 运行（他人 30 分钟内可复现）

```bash
# 1) 链 + 事件源（P07 三件套）
anvil                                          # 终端 1
cd ../P07-NFT市场进阶 && bash script/deploy.sh anvil    # 部署 LabNFT/LabEditions/NFTMarket
# Windows 无 bash 时等价：
#   forge build --quiet
#   forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast --slow \
#     --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked

# 2) P09 索引器
cd ../P09-链上数据平台进阶
npm install                                    # 只装 ethers
node scripts/01-gen-events.mjs                 # 制造事件流（铸造/挂单/成交/租期）
node indexer/run.js serve                      # 索引 + BFF + 看板 → http://127.0.0.1:8801

# 3) 验收（20 项）
node scripts/02-acceptance.mjs
```

环境变量（均有默认值）：`RPC` `CHAIN_ID` `DB_PATH` `CONFIRMATIONS` `LOG_CHUNK` `START_BLOCK` `CONTRACTS` `API_PORT` `API_KEY` `POLL_MS`。

## 验收（实测记录，2026-11-13）

| 组 | 断言 | 结果 |
|----|------|------|
| A. confirmations 深度 | `confirmations=2` 游标停在 safe（137）不追链头（139）；挖 3 块后跟进 | ✅ |
| B. 查询 + 分页稳定 | 首页 5 条 + nextCursor（10ms）；**翻页途中出新块**，第二页与第一页零重复、整体单调 | ✅ |
| C. 人为分叉回滚重放 | `evm_snapshot`→2 mint→`evm_revert`→换 3 mint：旧分叉事件/交易**全部消失**、新分叉**重放入库**、游标回安全区、Σ持仓==资产数 | ✅ |
| D. 筛选延迟 | 合同号+事件 16ms（20 条）/ 批次 1ms（2 条）/ 地址 12ms（9 条），均 < 1000ms 且**必返回数据** | ✅ |
| E. 幂等 | 重复 sync 两次，blocks/txs/logs 行数不变（152/126/182） | ✅ |
| F. BFF 鉴权 | 无 `X-API-Key` 调 `/admin/*` → 401；带密钥 → 200 | ✅ |

**合计 20 项全绿（pass=20 fail=0）**；`node indexer/run.js serve` 实测：看板 200、`/api/stats` 事件分布 Transfer 62 / UpdateUser 42 / MetadataUpdate 30 / Listed 16…、`/api/logs` 响应 1ms。

## 复盘

- **卡住的点**：
  1. 分叉测试最初用 `decoded LIKE '%fork-a%'` 找事件——**mint 的 URI 在交易 input 里，事件 decoded 里根本没有**；
     改为按交易哈希归属后才测出真实行为。教训：断言要贴数据实际存放的位置，不要贴「直觉上的位置」。
  2. confirmations 语义差点被绕过：mint 后不补块，事件永远进不了安全区（safe = head - N）。
     settle() = 补 N 个空块再扫，这才是深度语义的真实用法。
  3. 派生状态不变式最初写成「Σ持仓 == 资产数」全局成立——**1155 是数量语义**（一笔 TransferSingle 加 N），
     和 721 的「一 token 一 owner」不是一回事；限定到 721 合约后不变式才精确成立。
  4. 筛选接口把所有筛选值统一 `toLowerCase`——地址列确实存小写，但 `eventName` 大小写敏感
     （`Transfer` ≠ `transfer`），事件名过滤**永远 0 条**而延迟断言照样「通过」。
     教训：延迟类断言必须同时断言「查到的东西 > 0」，否则测的是空查询的速度。
- **与 Java/传统后端的对照**：
  | 索引器概念 | 传统后端对应 | 迁移注意 |
  |---|---|---|
  | 扫块 + 日志过滤 | CDC/消息消费的分片拉取 | 拉取要幂等：以链上不可变标识做主键（像 Kafka offset 不能当主键、消息 ID 才行） |
  | confirmations 深度 | 消费延迟容忍（at-least-once） | 链上「最终」= 深度够了才叫 at-least-once 的确认位 |
  | 重组回滚重放 | 乱序/回放消息的对账 | 链上回滚是**显式协议**（parentHash 断链），比消息乱序更好判定 |
  | 游标分页 | keyset pagination | 千万别用 OFFSET——链上数据只追加，keyset 才能翻页稳定 |
  | 派生状态重放 | 事件溯源 + 快照 | 回滚后全量重放派生态（holders），与 ES 重建索引同构 |
  | BFF + API key | 网关鉴权 | 管理口（回滚/重扫）必须单独鉴权，读口可公开 |
- **下次可压缩的时间**：事件注册表直接从 `abi/*.json` 生成（本次手写 14 条签名再对拍），可省 40 分钟排查。
- **lainchain 对照精读**：待补（源件不在本机）——输出 `docs/S3-合约进阶与数据/lainchain对照-P09.md`。

## 验收（质量门禁）

- [x] 事件可查询且分页稳定
- [x] 人为制造分叉后索引能回滚重放
- [x] 看板按合同号/批次筛选 <1s（实测 2–16ms）
- [x] README 可按步骤复现（他人 30 分钟内跑起来）
- [x] 仓库零私钥（anvil 解锁账户 + `.env` 不入库；`git check-ignore` 已验证）
- [x] 去代币化检查表通过（无对外交付，仅本地教学）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 读 `indexer/`（Python + SQLite 手写扫块）与 `backend/`（Ktor MVP）：列出重组处理缺失项，规划 Spring Boot 重写
- 输出：`docs/S3-合约进阶与数据/lainchain对照-P09.md`

