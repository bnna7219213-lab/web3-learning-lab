# Web3 动手学习实验室（web3-learning-lab）

> 这是 [web3-roadmap](https://github.com/bnna7219213-lab/web3-roadmap) 的**学习线公开版**：把可独立学习、可本地复跑的部分剥离出来单独成库。
> 内容来自实际部署与实测，不是教程摘抄；**所有主机相关标识已替换为占位符**（见 §5）。

## 1. 这个仓库能学到什么

一条完整的、**不依赖任何公链**的联盟链工程闭环，加上从哈希到共识的基础训练：

| 层次 | 位置 | 你能得到什么 |
|---|---|---|
| 认知基础 | `projects/P01` | 哈希雪崩、哈希链、Merkle 树与批量出证、签名防重放——**零依赖纯 Node**，19 项单测 |
| 自己写一条链 | `projects/P02` | MiniChain：3 节点组网、广播、共识、分叉重组，25 项单测 + 4 条验收实验 |
| 链上交互 | `projects/P03` | 交易生命周期手册：建钱包→领水→转账→逐字段解析，8+2 笔联盟网实测交易（含失败案例），零公链依赖 |
| ERC20 合约 | `projects/P05` | LabToken：Permit/角色/上限/舍入视图，36 项测试（fuzz+invariant）覆盖率 100%，anvil+联盟网双部署 |
| 全栈 DApp | `projects/P06` | 投票闭环：React+Wagmi+双钱包路径（MetaMask / anvil 演示钱包），事件驱动实时刷新，浏览器 E2E 实测 |
| 合约工程 | `projects/P04`–`P08`、`P20`–`P25` | Foundry 编写 / 测试 / 部署 / 升级 / 审计（P04/P05/P06 已完成实测） |
| **真实联盟网** | `shared/consortium-network` | Besu + QBFT 四验证者本地组网、创世生成、加成员、冒烟测试 |
| **自建钱包 + 联盟链浏览器** | `projects/B03` | 没有 MetaMask、没有 Etherscan、没有公链 faucet 的情况下，把「建账户 → 领币 → 发交易 → 逐字段自查」走通 |
| 联盟链上的真实故障 | `projects/B04` | 卡池交易、EIP-1559 费用下限、PUSH0 与 evmVersion、同 nonce 替换解锁 |
| **联盟内权益凭证** | `projects/B07` | NFT 市场的联盟版：成员白名单转让（禁二级）、元数据只存哈希（内网 OSS + P01 出证结构）、4907 租期、到期自动回收、核销与审计留痕；零 gas + 4 验证者 QBFT 实测 |
| 可独立复核的出证 | `shared/evidence` | v2 索引化 Merkle 树 + P-256 签名验证，12 项属性测试 + 9 项篡改拒绝 |

## 2. 快速开始（零依赖部分，Windows / Git Bash）

```bash
bash tools/check-env.sh                                        # 环境自检
node --test "projects/P01-区块链认知工具箱基础/test/*.test.mjs"  # 19 项
node tools/serve.mjs                                           # → http://127.0.0.1:8787
```

P02 纯 Node 组网：

```bash
cd projects/P02-MiniChain迷你区块链基础
node --test "test/*.test.mjs" && node bin/experiments.mjs
```

Foundry 部分（P04/P05/P06 均已本机实测）：

```bash
cd projects/P04-HelloContract基础 && forge test    # 11 项
cd ../P05-ERC20代币基础     && forge test          # 36 项（4×500 轮 fuzz + invariant）
cd ../P06-投票DApp基础      && forge test          # 13 项；前端 cd frontend && npm install && npm run dev
```

## 3. 本地跑起联盟链 + 自建钱包 + 浏览器（完整闭环）

前置：Besu 26.9+、**JDK 25+**（Besu 26.9.0 实测要求；注意 `JAVA_HOME` 也要指向它）、Node 20+。全程 `127.0.0.1`，不对外。
2026-11-11 已在 Windows/Git Bash 本机实跑通（4 验证者、冒烟 5/5）；Linux 服务器形态见 B03 README。

```bash
cd shared/consortium-network
bash scripts/00-preflight.sh
cp genesis/qbftConfigFile.json.tpl genesis/qbftConfigFile.json   # 填 admin 地址（无 0x 前缀）
bash scripts/10-genesis.sh ./networkFiles          # 生成 4 验证者 QBFT 创世与节点密钥
bash scripts/21-up-native.sh                       # 幂等拉起；重跑不会洗链
bash scripts/30-smoke-test.sh                      # RPC 连通 + 出块断言

cd ../../projects/B03-链上交互实战联盟网
npm install                                        # ethers + better-sqlite3（装在项目根，见下方说明）
node scripts/01-deploy-demo-token.js               # 部署演示 ERC-20（可选；需 FAUCET_ENV 指向含 FAUCET_PK 的 .env）
# Windows 本机：/opt 默认路径不可写，用环境变量把运行时数据落进项目内（data/ 已 gitignore）
DB_PATH="$PWD/indexer/data/index.db" PUBLIC_BASE="http://127.0.0.1:8080" \
  EVIDENCE_KEYS="$PWD/indexer/data/evidence-keys" WATCHDOG_STATE="$PWD/indexer/data/watchdog-state.json" \
  node indexer/server.js                           # 索引器 + 查询 API（127.0.0.1:8570）
FAUCET_PK=<仓库根 .env 的运营私钥> node faucet/server.js   # 水龙头（127.0.0.1:8560）
node ../../tools/serve-lab.mjs                     # → http://127.0.0.1:8080/b03/wallet.html
```

> **用 `tools/serve-lab.mjs`，不要用 `tools/serve.mjs`**：钱包页写死了同源路径
> `location.origin + "/b03-rpc/"`，纯静态服务器没有这一层反代，页面能打开但余额永远读不出来。
> `serve-lab.mjs` 在本地复刻 `/b03-rpc/`→8551、`/b03-api/`→8570、`/b03-faucet/`→8560，
> 并照抄了两个生产上必须处理的细节：把 `Host` 改写成 `localhost`（Besu 默认只认 localhost，否则 403
> "Host not authorized"）、剥掉 `Origin/Referer`（Besu 的 CORS 白名单默认为空，否则 403 "CORS Rejected"）。
> 上游没启动时它返回 **502 + JSON 说明**，而不是 HTML 错误页——后者会让前端抛
> `Unexpected token '<'`，把"后端没起"伪装成"接口返回乱码"。
>
> **为什么依赖装在 B03 项目根**：Node 只沿**祖先目录**查找 `node_modules`。
> 依赖若只装在 `indexer/` 下，`scripts/` 与 `faucet/` 里的脚本是看不见的
> （`indexer` 是它们的兄弟目录，不是祖先）。`projects/B03-…/package.json` 就是为此存在的。

进入钱包页后按六步走：生成钱包 → 复制地址 → 领 10 B03 → 填收款地址 → 签名发送 → **⑤ 双向对账**。

再用一条断言确认价值真的移动了（两个一次性账户，密钥只在内存、不打印）：

```bash
cd projects/B03-链上交互实战联盟网
RPC=http://127.0.0.1:8551 node scripts/verify-transfer-both-sides.js
```

## 4. 为什么「自建钱包 + 自建浏览器」值得单独学

公链教程默认你有 MetaMask、公共 faucet 和 Etherscan。联盟链环境三者都没有：

- **钱包**：secp256k1 密钥生成是纯本地计算，浏览器里的 ethers 就能完成，不需要任何节点配合；
- **发币**：由运营方账户签名的水龙头替代公共 faucet，附带按地址 + 按 IP 的双层限速；
- **查交易**：解析页把 selector、nonce、v/r/s 签名恢复、回执、终结性逐字段解释，
  替代 Etherscan；支持交易哈希 / 地址 / 区块号三种查询与 `?tx=` `?addr=` 深链；
- **零 gas 的真实语义**：免的是**手续费**，不是**本金**——`value > balance` 照样被拒。
  这一条在界面上写清楚之前，是学员最常踩的认知坑；
- **转账的验证模型**：「我发出了」不等于「对方收到了」。钱包页的 ⑤ 双向对账同时给出
  付款方减少量与收款方增加量，并且**核对对方只需要对方地址，不需要对方私钥**。

## 5. 占位符说明（重要）

本仓库从真实部署剥离而来。凡是标识具体主机的内容，一律换成占位符，**不是遗漏**：

| 占位符 | 含义 |
|---|---|
| `<YOUR_SERVER_IP>` | 原生产服务器地址 |
| `<your-domain.example>` | 原对外域名 |
| `<ICP备案号>` | 原页脚备案号 |
| `<customer-service-a>` / `<customer-service-b>` | 同机部署的其它业务系统 |
| `<server-panel>` | 原服务器管理面板 |
| `<YOUR_SSH_KEY_PATH>` | 原 SSH 私钥路径 |
| `<FAUCET_OPERATOR_ADDRESS>` / `<YOUR_WALLET_ADDRESS>` | 原链上账户地址 |

`DEPLOYER_PRIVATE_KEY` / `TEST_MNEMONIC` 在 `.env.example` 中**一律留空**。
真实私钥永不入库——这条规则本身也是教学内容的一部分。

## 6. 合规边界（这些内容刻意不做）

本仓库里的「B03 币」是**联盟链内部的记账单位**，不是可交易代币。因此：

- 不做行情、K 线、价格展示；不暗示任何单位可兑换法定货币；
- 不做公众资金归集、代客保管私钥、撮合、借贷、AMM、代币激励；
- 不在 Web 页面收集或保存助记词 / 私钥；
- 教学钱包页把密钥存在浏览器 `localStorage`（明文），页面已明确标注
  **任何真实价值不得放在这种持钥方式上**。

## 7. 目录导航

```text
web3_learning_lab/
├── README.md · roadmap.md · 知识点思维导图.md
├── docs/
│   ├── S1-区块链基础/ … S7-毕业项目/     # 每阶段原理文与复盘（S1/S2 已有实测文档索引）
├── projects/
│   ├── P01…P26/                          # 学习线（A 线）：P01–P06 已完成实测
│   ├── B03…B08/                          # 联盟网分支（B 线）：自建钱包、浏览器、出证
│   └── G1…G6-毕业项目/
├── shared/
│   ├── consortium-network/               # Besu QBFT 组网脚本、创世模板、差异矩阵
│   ├── evidence/                         # 可独立复核的证据包（Merkle v2 + P-256）
│   └── contracts-lib · frontend-lib · indexer-templates · scripts
├── templates/                            # 项目启动模板
└── tools/                                # check-env.sh · serve.mjs · serve-lab.mjs · README 生成器
```

## 8. 已知限制（不假装完美）

- `shared/consortium-network` 的配置与脚本**逐条核对过 Besu 26.9.0 官方文档**，
  差异判定见 `shared/consortium-network/docs/01-方案校准清单.md`；
- 联盟链的**生产级运维**（systemd 托管、nginx 反代、告警、容量约束）在本公开版里被移出，
  因此这里能学「怎么把链跑起来」，学不到「怎么在生产环境里不把它跑挂」；
- 钱包页仍是**单钱包槽位**（多账户未实现），私钥存浏览器明文——定位是教学，不是托管；
- 本链零容错形态（3 验证者 / quorum 3）是**资源约束下的妥协**，不是推荐拓扑；
- **公网测试网 faucet 已不可用**（2026-11-11 多轮实测：接口被禁/需充值/额度领光），
  P03 经用户授权改由联盟网水龙头接管全流程；Sepolia 流程保留为可选附录，待 faucet 恢复补做；
- P06 与 P07 的 **MetaMask 路径已用真实扩展实测通过**（2026-11-12：Edge 157 + `--load-extension` + 原始 CDP 驱动真实审批弹窗；
  P06 连接→切 Anvil→建提案→投票；P07 铸造→挂单→跨账户购买→4907 租期→EIP-712 签名→fillOrder 成交；
  链上 `cast` 独立核验）；真根因与可复用脚本见各项目 docs/02；
- Besu 26.9.0 在 Windows 上 `--bootnodes` 传 enode 串会崩（路径解析 bug），
  `21-up-native.sh` 已改传 enode 文件绕过——Linux 行为不变。
