# B04 · HelloContract（联盟网）

> 状态：**已完成（合约部署 + 卡单观测与处置台；2026-11-13 前端/链上端到端 36/36）** ｜ 对应主线：[P04](../P04-HelloContract基础/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
> 一句话目标：把 Foundry 写-测-部署闭环平移到 QBFT 联盟链，验证「合约零改动」这个卖点是否真成立。
>
> **结论先说：「合约零改动」这句话不成立。** 源码确实一行没改，但**编译与发交易参数必须按网络分档**，
> 否则在联盟网上要么部署交易进块却 `status=0` 烧光 gas，要么交易拿到 hash 却永远等不到 receipt。
> 这两个坑在 anvil 上永远撞不到——这正是 B04 存在的价值。详见下面「实跑踩到的两个硬坑」。

## 部署结果（2026-10-16 实测）

| 项 | 成员 A | 成员 B |
|----|--------|--------|
| 部署者（余额 0 的新账户） | `0x0BD6D54Ad98120c6Ae1dAF751899B8b5C423263A` | `0xc2e431212ea43F7537aF6caE2cCaeeEC8f6EBaE6` |
| 合约地址 | `0x87e71e4D6fAB849166b231A68050736062f9f340` | `0xb32798cC81B043C6DD332d6dCf608A4cFdD1D5de` |
| 入块高度 | #2549 | #2554 |
| runtime 字节码 | 1371 B | 1371 B |
| `keccak(deployedBytecode)` | `0x7d31d4ad0b800a4c2198a4e538aa5db8022ba369b936c0dea5eb82a9ec8e62b8` | **同上，逐字符相同** |
| 部署者 nonce | 0 → 1 | 0 → 1 |

链上可读验证：`count()` = 7（构造初值）、`owner()` = 各自部署者、`VERSION()` = `"1.0.0"`、`HISTORY_LEN()` = 8。
两份部署已由 B03 索引器登记（`register.js`），在浏览器「合约」区可查指纹与独立复核命令。

## 实跑踩到的两个硬坑（anvil 上不可能复现）

### 坑 1：`--gas-price 0` 不等于零 gas，且交易池不会拦你

只给 `--gas-price 0` 时 forge 仍按 **EIP-1559** 发交易，并把费用上限定在 **1 wei**：

```
gasPrice: "0x1"   maxFeePerGas: "0x1"   maxPriorityFeePerGas: "0x1"
```

于是这笔部署需要 `505440 × 1 = 505440 wei` 手续费，而部署账户余额 0。正常链上这该被拒，
但我们为了零 gas 体验开了 `tx-pool-enable-balance-check=false` —— **节点让它进池**。
结果就是 `docs/02` 里预言的那个"交易静默消失"，只是成因完全不同：

```
eth_getTransactionByHash → 有，blockNumber: null
eth_getTransactionReceipt → null
eth_getCode(合约地址)     → 0x
```

拿到 hash、看起来"已广播"、永远不入块。而且它占住了该账户的 nonce 0，后续同 nonce 低价交易
还会被当作"无法替换"丢弃。

**修法**：零 gas 链必须 `--legacy --gas-price 0`。`deploy.sh` 的 `GAS_MODE=zero` 分支已改。

> **运维结论（2026-10-23 受控实验，两阶段均实测；脚本 `scripts/observe-stuck-tx.js`，证据 `docs/evidence/`）**
>
> 这种"付不起但已进池"的交易**不会自行消失**，而且**重启单节点也清不掉**。
>
> **阶段 1（不重启，15 分钟 / 16 次采样）**：零余额账户发一笔 legacy / `gasPrice=1` / `value=0` /
> `gas=505440` 的交易（需 505440 wei，余额 0）。`in_pool` 恒 `true`、receipt 恒 `null`、
> nonce 恒 `latest=0 / pending=1`，同期链高 77825→77933 持续推进（排除"链停了的假象"）。
>
> **阶段 2（带同期对照组）**：先确认该交易在**三个节点的池里都在**，然后只重启 node-1：
>
> | 节点 | 是否重启 | 重启后 19 秒 | pending nonce |
> |---|---|---|---|
> | 8551 | ✅ | **消失** | `0x0` |
> | 8552 | ❌ | 仍在池 | `0x1` |
> | 8553 | ❌ | 仍在池 | `0x1` |
>
> 同一笔交易、同一时刻、唯一自变量是重启 —— **"重启会清池"被证实**。
> 但 **4 分钟后复查，node-1 的池被邻居 gossip 重新填满**，三节点再次都是 `tx_seen=1 / pending=0x1`。
>
> 所以准确的表述是：**重启单节点只是临时清池，gossip 会在几分钟内回填；要真正清掉必须重启所有
> 仍持有它的节点**（即整个集群）。这也解释了 10-19 观察到"那笔交易消失了"——那天所有节点都被
> 重启过、没有邻居能回填，而不是"重启一台就够"。
>
> 两层教训。一是实验设计：只做"重启前后各查一次"会得出**错误**结论，是同期对照组 + 延时复查
> 才把"清掉"和"回填"分开。二是别把早期推断当事实：我原先写的"重启节点才会清出交易池"方向对、
> 强度错，被下游文档原样引用后就成了"重启一台即可清理"的错误运维指引。
>
> **对界面设计的含义**：`卡单待人工` 不应提供"重启节点"作为一键清理（既无效又有停链风险）。
>
> **已实测可行的处置路径**（`scripts/verify-stuck-tx-replacement.js`）：给该账户注入**最小余额**，
> 再用**同 nonce、更高 gasPrice、更低 gas** 的空交易替换它。实测：卡单 `gasPrice=1/gas=505440`
> 在池、账户余额 0 → 注入 100000 wei → 发 `nonce=0 / gasPrice=2 / gas=21000 / value=0` 替换交易
> → **块 #78142 入块 status=1、原卡单从池中消失、账户 nonce 0→1**；随后新交易在 #78143 正常入块，
> 账户确认恢复。最终余额 57999 wei，与算术吻合（100000 − 替换成本 21000×2=42000 = 58000，
> 再扣后续交易的 value=1）—— 顺带复证了零 gas 下"手续费不花钱、本金照扣"。
>
> ⚠ **这条路径有个必须写进 Runbook 的前提**：注入额要落在
> `替换成本 ≤ 注入额 < 卡单成本` 的窗口内。若按水龙头固定额度直接打 10 B03（1e19 wei），
> 卡单本身立刻变成可执行、会在 nonce 0 上直接入块 —— 账户"看起来解锁了"，实际测的是
> 原交易能否执行，**与替换是否生效无关**。窗口没设计好，实验会给出一个看似成功实则无效的
> 操作指引。排障时也别只盯着 receipt 为 null 就断言"节点丢了单"。
>
> 观测手段上没用 `txpool_content`：Besu 只有一个 HTTP RPC 端口且被 nginx 公网反代，开 txpool
> 等于把全链待处理交易（地址/nonce/金额）暴露公网。改用三个等效信号：`tx` 非 null 且
> `blockNumber==null`、`pending nonce > latest nonce`、`eth_getBlockByNumber("pending")` 存在。

### 坑 2：genesis 只到 London，而 foundry 默认按 Cancun 编 → PUSH0 直接烧光 gas

本链 genesis 的 `chains` 段只有 `berlinBlock: 0` 和 `londonBlock: 0`，**没有 `shanghaiBlock`**。
PUSH0（`0x5f`，EIP-3855）是 Shanghai 才引入的。而 P04 的 `foundry.toml` 写的是
`evm_version = "cancun"`，solc 0.8.28 理所当然地往字节码里发 PUSH0：

```
部署交易进块了，但 status=0，518995 gas 全部消耗，合约地址有值而 eth_getCode 返回 0x
```

anvil 默认跑 Cancun，所以 P04 全程绿。

**修法**：新增编译 profile `[profile.consortium] evm_version = "london"`，`deploy.sh` 在
`PROFILE=consortium` 时自动 `export FOUNDRY_PROFILE=consortium`。

**旁证（很有说服力的一条）**：本次修复后 `abi/Counter.json` 与 `abi/Counter.selectors.json`
**一字未改**，只有 `abi/Counter.bytecode.json` 变了 —— 接口相同、字节码不同，
正是"同一份合约在不同网络不能直接搬"的实物证据。

### 坑 2 的衍生坑：`forge inspect` 也必须带 profile

不带 `FOUNDRY_PROFILE=consortium` 直接 `forge inspect Counter deployedBytecode`，
forge 会用 **default** profile 重新编译，算出 `0x135b9ae5…`，与链上的 `0x7d31d4ad…` 对不上，
看起来像"指纹被篡改"。我自己踩了一次。交付规范里应写死：**任何产物比对都要与部署时同一个 profile。**

## 四个风险点的实测判定

| 风险点（`docs/02` 的预测） | 判定 | 实测依据 |
|------|------|---------|
| ① 部署账户不在账户白名单 | **移交 B08** | 本链根本没启用 `accounts-allowlist`（native 起网路径不加载 `permissions_config.toml`）。要测就得改 genesis 并全链重启，而当前 3/4 验证者是零容错态，不该为一条负例冒停链风险 |
| ② 单笔 gas 上限（EIP-7825） | **未触发** | genesis `pertxgaslimit=0` 已放开；本次 518995 gas 远低于 16,777,216。真正咬人的是 PUSH0 而不是上限 |
| ③ 某节点 `min-gas-price` 漂移 → 静默丢单 | **PASS（无漂移）** | 逐节点实测 8551/8552/8553 `eth_gasPrice` 全为 0，漂移节点列表为空。**注意**：静默丢单确实发生了，但成因是坑 1 的 1559 费用下限，不是节点配置漂移 |
| ④ chainId 与地址派生 | **PASS** | 部署交易 `v=0x25eb556=39761238`，`(v-35)/2 = 19880601` ✓；`eth_chainId` = `0x12f5a99` |
| ⑤ 无 verify 通道 → 指纹自证 | **PASS** | `cast code --rpc-url … <addr> \| cast keccak` = 部署记录 `deployedBytecodeHash` = 索引器登记值，三方一致；浏览器合约页直接展示该命令供客户复跑 |

## 零 gas 语义在 B04 的正面演示

两个**从未在链上出现过、余额 0** 的账户，**没有领过任何币**，各自完成了一次合约部署。
因为部署交易 `value=0`、`gasPrice=0`，intrinsic cost = `gas × 0 + 0 = 0`，所需余额为 0。

配合 B03 的结论一起看才是完整语义：**零 gas 免的是手续费，不免本金**——
0 余额能部署合约、能发 `value=0` 的调用，但不能转出多于余额的币。

## 与 P04 的关系

**功能实现一致，环境语义不同。**P04 的全部知识点在本分支都要做一遍，本 README 只记录**差异与新增验收**；
共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P09-vs-B03-B09.md)。

| 维度 | P04（公链/anvil） | B04（联盟 QBFT） |
|------|------------------------|----------------------|
| 部署目标 | anvil / Sepolia | 联盟网 RPC（内网地址 + 可选 mTLS 代理） |
| gas | 真实 gasPrice，需领水 | `min-gas-price=0` + `zeroBaseFee=true`，MetaMask 会异常，需脚本发交易 |
| 验证合约 | Etherscan verify | 本地登记源码哈希 + 出证（进 M4） |
| 失败面 | revert / out of gas | 新增：账户未授权、单笔超 EIP-7825 上限 |

## 知识点

- [x] foundry.toml 多 profile：**编译 profile 与网络 profile 是两回事**，且必须成对（`[profile.consortium]` ↔ `env/consortium.env`）
- [x] 私钥来源：环境变量（`deploy.sh` 拒绝 consortium 回落根 `.env`，因为那里面是公链真钱包）
- [x] 零 gas 链上的 gas 估算：`--gas-price 0` 不够，必须 `--legacy`（见坑 1）
- [ ] 账户白名单导致的「部署被拒」：移交 B08（本链未启用 permissioning）
- [x] verify 流程在无公网浏览器时的替代：`register.js` 登记 + 浏览器指纹自证页 + 客户 `cast` 复跑

## 技术栈

- Besu 26.9.0 QBFT（`shared/consortium-network`，systemd 托管 `besu-node@1..3`）
- Foundry 1.7.1 —— **在笔记本上跑，服务器没装也不用装**：node-1 RPC 已由 nginx 反代到公网 `/b03-rpc/`
- 自研索引器 + 合约登记表（B03 `indexer/`）

## 环境准备

```bash
# 服务器侧（若链已在跑可跳过；见 shared/consortium-network/README.md 的 systemd 路径）
ssh -i <YOUR_SSH_KEY_PATH> root@<YOUR_SERVER_IP>
systemctl is-active besu-node@1 besu-node@2 besu-node@3   # 3/4 在线，quorum=3
curl -s http://<your-domain.example>/b03-api/api/v1/nodes          # 看在线数与 gasPrice 漂移

# 本机侧（B04 实际就在这台机器上跑）
cd projects/P04-HelloContract基础
export DEPLOYER_PRIVATE_KEY=$(cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))")
bash script/deploy.sh consortium          # 自动 FOUNDRY_PROFILE=consortium + --legacy --gas-price 0

# 登记到浏览器（在服务器上）
cd /opt/b03-indexer && node register.js --backfill
node register.js --addr <合约地址> --name Counter --source sources/p04/Counter.sol \
     --abi sources/p04/Counter.abi.json --git-commit <sha>
```

## 任务拆解

1. [x] 复用 P04 的实现，切到联盟网 profile（源码零改动，编译 profile 换 london）
2. [x] 多成员账户与 nonce 管理（A/B 两账户各部署一次，nonce 各自 0→1）
3. [x] 零 gas 相关断言与负例（坑 1：`--gas-price 0` 不带 `--legacy` 的卡单；坑 2：PUSH0）
4. [ ] 权限（白名单/角色）正例与负例 —— 移交 B08（本链未启用 permissioning）
5. [x] 内网可观测（浏览器登记 + 卡单观测器 + 三信号判定，见 `scripts/observe-stuck-tx.js`）
6. [x] 文档与证据（`docs/evidence/`：观测 JSONL + 窗口公式 + 服务器两阶段实验记录）

**2026-11-13 补齐**：`scripts/make-stuck-tx.js`（复现）+ `scripts/observe-stuck-tx.js`（多节点采样）
+ `scripts/verify-stuck-tx-replacement.js`（窗口校验 + 同 nonce 替换处置）三脚本入库并在本地联盟链
首尾贯通实测（卡单 → 3 节点观测 4 轮 → 替换成立）；证据与复现步骤见 `docs/evidence/README.md`。
处置脚本默认 `--dry-run`，且**内置窗口校验**（注入额必须落在 `替换成本 ≤ 注入额 < 卡单成本`），
防止「注入过多 → 卡单自己变可执行」的假阳性实验。

### 卡单观测与处置台（2026-11-13 补齐）

```bash
cd projects/B04-HelloContract联盟网
npm install
npm run serve        # 默认 http://127.0.0.1:8804；可用 PORT=8814 避开其他项目
npm run smoke        # 独立端口可用 node scripts/12-console-smoke.js --port 8814
```

页面真实执行：随机账户造卡单 → 三节点 `in_pool/receipt/nonce` 观测 → 小额及 10 B03 超额注入拒绝 → 100000 wei 合法注入与同 nonce 替换。最新冒烟 **36/36**，浏览器实测替换交易在块 30507 `status=1`、原卡单无回执且 nonce `0→1`；证据见 [docs/evidence/](docs/evidence/README.md)。

**不提供重启节点按钮**：单节点重启会被 gossip 回填，全集群重启等同停链。处置台的密钥仅服务端读取，实验私钥只在内存，不提供停链动作。

## 验收

**分支共用四条增量**（B03–B08 一律适用）：

- [x] 多成员：≥2 个成员账户各自发交易，nonce 互不干扰 —— A、B 各部署一次，nonce 各自 0→1，互不干扰
- [x] 零 gas：`eth_gasPrice == 0` 且 `baseFeePerGas == 0`，交易确实入账 —— 三节点 `eth_gasPrice` 全 0，两笔部署均入块且 `status=1`
- [x] 终结性：交易所在块在 3 个节点查询一致 —— 索引器 `/api/v1/consistency` 与 `/api/v1/nodes` 自动比对，余额/nonce/高度三节点一致
- [ ] 权限负例：未授权账户/节点被拒且留下可审计记录 —— **移交 B08**（本链未启用 permissioning，启用需全链重启，当前零容错不宜冒这个风险）

**本分支特有**：

- [x] 同一份合约在 anvil 与联盟网部署成功且地址可复现 —— 源码零改动；但**必须换编译 profile**（`evm_version=london`），否则 PUSH0 导致 `status=0`。未用 Create2，故地址不可预计算，B08 再验 salt
- [x] `forge test` 全绿（P04 的 11 项，编译 profile 不影响测试结果）；「未授权账户部署被拒」负例移交 B08
- [x] 部署产物自动导出 ABI 给前端 —— `abi/Counter.json` 16 项，已由 `register.js` 灌进浏览器合约登记，前端不再手抄
- [x] README 可按步骤复现 —— 本文件「环境准备」即本次实跑命令
- [ ] 去代币化检查表通过（涉及对外交付时）
- [x] **新增验收项（本次实测逼出来的，已实现）**：`deployments/*.json` 现在记录 `evmVersion` 与 `foundryProfile`。
  指纹自证的前提是"客户用同一套编译参数重编译"，不记这两项，客户算出的 hash 必然对不上。
  第三次部署的记录已带 `"evmVersion": "london", "foundryProfile": "consortium"`，
  字节码 hash 仍是 `0x7d31d4ad…`——同参数可复现，这一点现在是有记录的

## 复盘

- **与 P04 相比最意外的差异**：不是"没有 Etherscan"，而是**编译目标必须跟着网络走**。
  我们原本把 foundry 的 profile 当成"编译设置"、网络当成"rpc 设置"，两件事互不相干——
  实测证明这个假设是错的：网络决定 EVM 能力，EVM 能力决定编译产物，编译产物决定指纹。
  另一个意外是**失败模式的隐蔽性**：坑 1 里交易拿到了 hash、看起来成功广播，receipt 却永远为 null，
  而根因是我们自己为了零 gas 体验关掉的余额检查。为方便性做的妥协，最后变成最难排的一类故障。
- **联盟特有故障遇到没有**：遇到"静默丢单"，但成因不是文档预测的节点 gasPrice 漂移，
  而是 1559 费用下限 + 余额检查关闭的组合。文档里的排障口诀（看高度别看进程）本次也再次验证有效。
- **对客交付时客户最关心的问题**：「我怎么知道链上这个合约就是你给我的那份源码」。
  本次给出的答案是三方比对（本地编译 keccak == 链上 getCode keccak == 交付记录里的 hash），
  并把 `cast` 命令直接印在浏览器合约页上让客户自己跑。前提是交付时说明白用哪个 profile 编译——
  这也是上面新增验收项的来处。
