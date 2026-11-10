# P02 · MiniChain 迷你区块链（基础）

> 状态：**已完成，四条验收实验全部通过** ｜ 里程碑：M1·W2 ｜ 层级：基础 ｜ 依赖：P01 ｜ 更新：2026-10-13
> 一句话目标：用多节点本地链证明「区块结构 + 共识 + P2P 广播 + 钱包签名」如何共同产生不可抵赖的账本。

## 运行（零依赖，不需要 npm install）

```bash
cd projects/P02-MiniChain迷你区块链基础

node --test "test/*.test.mjs"     # 25 项单测（含 4 项真实 HTTP 多节点集成测试）
node bin/experiments.mjs          # 四条验收实验，打印可抄进文档的实测数字

node bin/network.mjs 1200         # 起 3 节点 PoS 轮值链（出块间隔 1200ms）
node tools/serve.mjs              # 另开一个终端
# 面板：http://127.0.0.1:8787/projects/P02-MiniChain迷你区块链基础/frontend/
```

节点 API：`GET /status · /chain · /mempool · /balance?addr= · /confirm?hash=`，
`POST /tx · /block · /sync · /mine?broadcast=false · /shutdown`。

## 目录

```text
P02-MiniChain迷你区块链基础/
├── README.md
├── package.json                 # type=module
├── src/                         # crypto · tx · block · chain · mempool · node
├── bin/                         # network.mjs（起网）· experiments.mjs（验收实验）
│   └── .network.json            # 节点身份（含私钥 JWK，已 gitignore，永不入库）
├── frontend/                    # 节点面板：与节点共用 src/crypto.js + src/tx.js
├── test/                        # 25 项：tx / block / chain / network
├── docs/                        # 01 架构与数据流 · 02 设计取舍 · 03 实验记录
└── screenshots/
```

## 知识点（对应 知识点思维导图.md §2 与 roadmap §5.2）

- [x] 区块结构与哈希链接：`hash = H(版本|index|timestamp|prevHash|merkleRoot|共识|难度|proposer|nonce|余额表)`
- [x] 交易 Merkle root：空块为 null，改一笔交易 root 即变
- [x] PoW：难度 = 前导零个数，`sealBlock` 搜 nonce；不达标块被 `validateBlock` 拒绝
- [x] PoS：`validators[height % n]` 轮值，非轮值人出块直接返回 null（实测 `未到本节点轮次`）
- [x] 简单 P2P：HTTP gossip 广播交易与区块；接不上就拉对方整条链比权重
- [x] 最长链 / 权重规则：**严格更重才切换**，等重不切（防抖动）
- [x] 重组与回滚：被丢弃区块的交易回炉，且因 nonce 已占用无法二次入账
- [x] 钱包签名：ECDSA 签名 + 地址由公钥派生 + 协议版本进签名域
- [x] 确认数：`confirmations(chain, blockHash)` = 链尖高度 − 该块高度
- [x] 冷启动追赶：重启节点从邻居拉链、重放算出账本（账本不是存出来的，是算出来的）

## 技术栈

- 链与节点：Node.js 原生 `node:http` + `fetch`（无 Express、无 ws、无框架）
- 密码学：Web Crypto（SHA-256 / ECDSA P-256 / AES 不涉及）
- 前端：原生 ES Module，直接 import `src/crypto.js`、`src/tx.js`
- 测试：`node:test` + `node:assert/strict`，集成测试真起 HTTP 节点
- 与 Java 对照：等价于 Spring Boot 里「Controller + Service + Repository」三层，但状态由重放决定

## 验收（开发计划 §五 门禁 + roadmap §5.3）

- [x] **多节点能同步**：3 节点 PoS 收敛，面板实测高度 343 / 权重 344 / 链尖唯一 / 高度差 0
- [x] **杀 1 节点后能恢复并选最长链**：实验 2，离线期间链继续增长，重启追赶后 `bob=42` 一致
- [x] **人为分叉 + 重组 + 已确认交易回滚**：实验 3，权重 4→6 切换、`first=0`、`reorgs=1`、双花永久失败
- [x] **非法签名交易被拒**：实验 4 五类篡改全部 HTTP 400，且原因可读（签名无效/冒名/字段非法/重放）
- [x] 测试：25 项通过（并发跑两次不抢端口：端口按 `process.pid` 偏移）
- [x] 文档：架构、设计取舍（12 条与真实链的对照）、实验记录齐备
- [x] 仓库零私钥：`bin/.network.json` 已加入 `.gitignore`，节点只绑 127.0.0.1，CORS 只放行本机来源
- [x] 去代币化检查：无代币发行、无交易对、无收益话术；余额仅教学计数

## lainchain 对照精读

- [x] `docs/S1-区块链基础/lainchain对照-P02.md`：精读 `hardhat/contracts/iot/IoTBridgeForMcu.sol`（165 行）
  - 信任边界：它把验签放在网关（`onlyOracle`），P02 在账本层逐笔验签 → M2 必须写清客户侧信任点
  - 防重放：它的 `claimedModel[qModelHash]` 由上报者自填 → 可换 hash 重复领，M2 要改成 `deviceId + seq`
  - 权限：`setRewardParams` 单角色即时生效 → 交付时改多签 + 生效延迟
  - 可直接复用：`efficiencyBps` 边界校验、先乘后除的定点顺序、`maxRewardPerReport` 预算封顶、双 `indexed` 事件设计

## 复盘

- 卡住的点（都是真 bug，不是环境问题）：
  1. `createServer(...).listen(port)` 之后再 `once("listening")` —— 本机端口几十微秒就就绪，事件早于监听器 → 4 个集成测试全部 25s 超时。改成 `listen(port, host, cb)`。
  2. 交易池 `remove()` 只删 `bySenderNonce` 没删 `byId` → 已上链交易被重复选中 → 下一块 nonce 冲突 → **节点永久出不了块**。修法两张表都删，并加「出块前在状态副本上预演过滤」，让同类自锁不再可能发生。
  3. 测试端口写死 → 两个测试进程同时跑互相抢端口出现假失败（我第一次自己连跑两次就撞上了）。
- 与 Java/传统后端的对照：
  - 账本不是「存在库里的事实」，而是「从事件重放出来的投影」——和 event sourcing / CQRS 同构，但这里**每个节点都各自重放**，所以任何一台改数据都会被其他节点发现。
  - `tryAppend` 的三层校验（结构 → 链接 → 状态）≈ 入站请求的 schema 校验 + 业务规则 + 事务，只不过失败后**不能回滚重来**，只能换分支。
  - 「等重不切换」这种反抖动规则，和 Spring 里幂等/去抖的设计动机一样：**没有它，系统会自己震荡**。
- 下次可压缩的时间：`src/crypto.js`、`src/merkle`（在 block.js 内）与 P01 的 `lib/` 已第三次重复 → P08 前抽到 `shared/frontend-lib/` 与 `shared/contracts-lib/`。

## 已知限制

见 `docs/02-设计取舍与已知限制.md`：12 条简化逐条对应真实链机制，另附 4 条已知 bug 面（交易池不支持多条后续 nonce、回炉交易可能滞留、广播同步等待拖慢出块、时间戳无合理性约束）。
