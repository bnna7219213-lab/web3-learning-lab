# P03 · 链上交互实战（基础 · 联盟网接管版）

> 状态：**已完成，本机实测通过** ｜ 里程碑：M1·W2 ｜ 层级：基础 ｜ 主线：基础 ｜ 依赖：P01 ｜ 更新：2026-11-11
> 一句话目标：完成「建钱包 → 领水 → 转账 → 浏览器逐字段解析」，形成可复用的交易生命周期手册。
> **环境替换（2026-11-11 用户授权）**：公网测试网 faucet 多轮实测不可用（接口被禁 / 需注册充值 / 额度领光），
> 领币环节由 [B03](../B03-链上交互实战联盟网/README.md) 联盟网水龙头接管，全流程在本机 Besu QBFT 完成；
> 验收口径从「≥5 笔真实测试网交易」改为「≥5 笔真实联盟网交易（含 1 笔失败）」。Sepolia 流程保留为可选附录。

## 运行

前置：Besu 26.9+（JDK 25+）、Node 20+、Foundry（cast 复现用）。全程 `127.0.0.1`。

```bash
# 1) 起联盟网（幂等，重跑不洗链）
cd shared/consortium-network
bash scripts/10-genesis.sh ./networkFiles     # 首次：先把 genesis/qbftConfigFile.json.tpl 复制为 .json 并填 admin 地址
bash scripts/21-up-native.sh                  # 4 验证者 QBFT，零 gas，出块 5s
bash scripts/30-smoke-test.sh                 # 5 项断言

# 2) 起 B03 三服务（另开终端；依赖装在 B03 项目根）
cd projects/B03-链上交互实战联盟网
npm install
DB_PATH="$PWD/indexer/data/index.db" PUBLIC_BASE="http://127.0.0.1:8080" node indexer/server.js   # 8570
FAUCET_PK=<仓库根 .env 里的运营私钥> node faucet/server.js                                          # 8560
cd ../.. && node tools/serve-lab.mjs                                                               # 8080 + 反代

# 3) P03 全流程
cd projects/P03-链上交互实战基础
npm install
node scripts/run-all.mjs          # 建钱包→领水→转账→ERC20 成功/失败→零 gas 正负例→逐字段解析
bash scripts/07-cast-repro.sh     # 验收：cast 手工复现一笔
node scripts/06-parse-tx.mjs <txHash>   # 任意一笔的字段解析（手册附录生成器）
```

浏览器核对：`http://127.0.0.1:8080/b03/wallet.html`（六步流水线）与 `http://127.0.0.1:8080/b03/?tx=<hash>`（逐字段解析）。
**用 serve-lab.mjs 而非 serve.mjs**（同源反代 + Host/CORS 处理，原因见根 README §3）。

## 目录

```text
P03-链上交互实战基础/
├── scripts/
│   ├── lib.mjs               RPC/解析核心：ecrecover 对账、selector/事件解码、revert 重放、Markdown 渲染
│   ├── 01-new-wallet.mjs     三个一次性钱包（私钥只进 .env，不打印）
│   ├── 02-claim.mjs          B03 水龙头领币 + 429 冷却负例（含冷却等待重试）
│   ├── 03-transfer.mjs       原生转账 + 双向对账
│   ├── 04-token-lab.mjs      DemoToken 部署/mint/成功 transfer/超余额 revert（status=0）
│   ├── 05-zero-value.mjs     零 gas 语义：value=0 正例 / value>balance 池层拒
│   ├── 06-parse-tx.mjs       单笔逐字段解析 CLI
│   ├── 07-cast-repro.sh      cast 手工复现（--legacy --gas-price 0）
│   └── run-all.mjs           编排 + 证据落盘 + 附录生成
├── docs/
│   ├── 交易生命周期手册.md    七阶段生命周期 / 字段字典 / 失败分类学 / 终结性差异 / 验收自检
│   └── 实测附录-逐字段解析.md  自动生成：T1–T7 全字段表 + 拒绝记录
├── evidence/transactions.json  机器可读证据（hash/字段/拒绝，无私钥）
└── screenshots/               01 失败交易解析 · 02 钱包页双向对账 · 03 流水线 6/6
```

## 知识点

- [x] 助记词与派生路径（ethers `createRandom()` = BIP-44 `m/44'/60'/0'/0/0`；与 `cast wallet new` 等价）
- [x] nonce / gas / gasPrice 与 EIP-1559（本链 legacy+0；type-2 在零 gas 链的估算坑见 B04）
- [x] input data 选择器解码（`0xa9059cbb`=transfer、`0x40c10f19`=mint，ABI 参数解码实测）
- [x] logs/topics 与事件解码（Transfer topic0、indexed 进 topics、mint 的 from=0x0）
- [x] 交易状态、回执与确认数（QBFT 入块即最终；confirmations 只是链头距离）
- [x] 失败交易与 gas 消耗（status=0 烧 24419 gas；revert reason 用入块高度 eth_call 重放取得）
- [x] 签名防重放三件套：chainId / nonce / 签名覆盖全字段；每笔 ecrecover==from 对账 ✓
- [x] 零 gas 准确语义：免手续费不免本金（value=0 正例 + value>balance 池拒负例）

## 技术栈

- Node 22 + ethers 6.17（脚本）；cast（手工复现）；Besu 26.9.0 QBFT（链）；B03 索引器/水龙头/解析页（基础设施）
- 零公链依赖：不需要 MetaMask、Etherscan、公共 faucet

## 验收（实测记录，2026-11-11）

| 项 | 结果 |
|----|------|
| ≥5 笔真实交易逐字段解析（含 1 笔失败） | **8 笔脚本交易 T1–T8 + 2 笔 UI 交易 T9/T10**；T6 status=0（revert "balance"，gasUsed 24419） |
| 拒绝负例 | 2 条：faucet 429 冷却；`INSUFFICIENT_FUNDS` 池层拒（无 hash） |
| 签名恢复对账 | 全部交易 ecrecover == from ✓ |
| 双向对账 | 脚本：-2.5/+2.5 ✓；UI：10→9 / 8.5→9.5 ✓ |
| cast 手工复现 | T8 `0xf40496da…`（#134，status=1） |
| 浏览器 UI 全流程 | 钱包页六步流水线 **6/6**；解析页失败交易深链逐字段展示 |
| 截图与 hash 可核 | screenshots/ 3 张；附录 hash 全部链上可查（`06-parse-tx.mjs` 复核） |
| 仓库零私钥 | .env 被 gitignore；脚本不打印私钥；evidence 只含地址与链上数据 |
| 去代币化 | B03/DEMO 为链内零价值记账单位；无行情/兑换/募资语义 |

## 过程中修掉的真实缺陷（都有教学价值）

1. **Besu 26.9.0 在 Windows 上 `--bootnodes` 启动即崩**：`BootnodeResolver` 对每个值先 `Paths.get(value)` 试探文件，
   Windows 上 `enode://…` 的冒号抛 `InvalidPathException`（Linux 文件名允许冒号，静默落回 raw 分支——所以服务器没暴露）。
   已修 `shared/consortium-network/scripts/21-up-native.sh`：改传 bootnodes 文件（一行一个 enode），两平台一致。
2. **ethers v6 `tx.wait()` 对 status=0 抛 `CALL_EXCEPTION`**：回执挂在异常对象上。「入块但执行失败」≠「请求失败」，
   捕获 `e.receipt` 才是失败交易的正解（04-token-lab.mjs）。
3. **`getTransaction()` 响应的 `.serialized` 可能是 undefined**（ethers 6.17 实测）：签名恢复改用 RPC 字段重建无符号交易取 `unsignedHash`。
4. **公开仓库缺 `explorer/ethers.umd.min.js`**：钱包页同目录加载它，剥离时没带 → 页面 404 静默失效。
   已从 `node_modules/ethers/dist/` vendored 进 `B03/explorer/`（MIT，526KB），钱包页开箱可用。
5. **环境层**：`JAVA_HOME` 指向 JDK 17 而 PATH 是 26，Besu 启动器认 JAVA_HOME → 报「需 Java 25」。会话内显式 export 修正。

## 与 B03 / 差异矩阵的关系

功能实现一致，环境语义不同：见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。
本项目的解析器/手册是主线实现；B03 提供链、水龙头、索引器与解析页基础设施。

## lainchain 对照精读

- [ ] 读 `hardhat/scripts/deploy.js` 与 `deployments/420.json`：部署录制 + ABI 自动下发前端的工程做法
- **待源件**：`lainchain-defi` 不在本机（公开仓库剥离时未带），不凭印象写对照。源件可得后补 `docs/S1-区块链基础/lainchain对照-P03.md`。
  （P04 的对照已沉淀在 [docs/S2](../../docs/S2-智能合约入门/lainchain对照-P04.md)，ABI 自动下发做法已在 P04 deploy.sh 落地。）

## 附录：Sepolia 可选流程（待 faucet 可用，不阻塞主线）

原前置条件实测表（2026-10-14，保留作「为什么替换」的证据）：

| 渠道 | 实测 | 门槛 |
|------|------|------|
| `sepolia-faucet.pk910.de` | 200 可达 | 浏览器 PoW 挖矿换币，需挂机 |
| `cloud.google.com/application/web3/faucet/ethereum/sepolia` | 200 可达 | 人机验证，约 0.05 ETH/天 |
| `faucet.quicknode.com/ethereum/sepolia` | 200 可达 | 需登录 |
| `sepoliafaucet.com` → Alchemy | 200 可达 | 需注册 |
| `faucets.chain.link/sepolia` | 200 可达 | 需登录，每日额度常被领光 |

2026-11-11 用户反馈：上述渠道经不断测试已无法获取（接口被禁 / 不符合条件要充值）。
若日后恢复：`cast wallet new` 生成学习地址 → 领水 → `cast send --rpc-url $SEPOLIA_RPC` 转账 →
Etherscan 逐字段核对，与本手册字段字典一一对照即可（字段语义相同，终结性按 §7 换口径）。

## 复盘

- 卡住的点：Windows 与 Linux 的「静默差异」（bootnodes 路径试探、JAVA_HOME）——**跨平台脚本必须在两个平台都跑过才算完成**。
- 与 Java/传统后端的对照：交易生命周期 ≈ 签名请求→网关校验→队列定序→事务执行→commit；
  差异三处：失败也烧 gas、from 是恢复出来的、QBFT 是确定性终结。手册 §1 有逐阶段对照表。
- 下次可压缩的时间：解析器与手册附录生成器已经沉淀，P09 索引器可直接复用 `lib.mjs` 的解码函数。