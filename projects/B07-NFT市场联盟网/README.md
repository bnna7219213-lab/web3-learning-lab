# B07 · 权益凭证（联盟网）

> 状态：**已完成，本机实测通过（Besu QBFT 4 验证者 + 本地 kubo + 浏览器 E2E）** ｜ 对应主线：[P07](../P07-NFT市场进阶/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-13
> 一句话目标：把 NFT 市场改造成**联盟内权益凭证系统**：成员间转让受控、元数据不出内网、无二级炒作入口。

## 与 P07 的关系

**功能实现一致，环境语义不同。**P07 的全部知识点在本分支都做了一遍，本 README 只记录**差异与新增验收**；
共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。

| 维度 | P07（公链/anvil） | B07（联盟 QBFT） | B07 的落点 |
|------|------------------------|----------------------|---|
| 定位 | 公开市场 + 版税 + 二级 | **权益发行/核销/退改**，明确关闭二级 | 无市场合约、无价格字段；转让仅限白名单成员 |
| 元数据 | IPFS/Pinata（公网） | 客户内网对象存储，链上只存哈希 | `LabCredential` 锚定 Merkle 根 + `tokenURI` 指向内网网关 |
| 批量 | 受 gas 成本约束 | 受区块容量与单笔 gas 上限约束 | `MAX_BATCH_SIZE = 250`，1000 份分 4 笔 |
| 合规 | 数字藏品炒作风险 | 禁二级 + 实名成员 + 可审计 | 成员白名单 + 转让预检 + 审计流水 + 到期自动失效 |

## 知识点

- [x] ERC-721 在联盟场景的语义收缩（凭证而非藏品：无价格、无市场、转让受白名单约束）
- [x] EIP-4907 租期分离：owner/user 双角色的成员间租赁（转让自动清租约）
- [x] 元数据放内网对象存储 + **哈希锚定**（链上只存 Merkle 根，复用 `shared/evidence` 的出证结构）
- [x] 转让限制：账户白名单 + 合约层转让策略（禁二级）
- [x] 批量铸造与 EIP-7825 单笔 gas 上限的关系（1000 份必须分笔，合约把上限固化成 `BatchTooLarge`）
- [x] 到期自动回收 0 例外（失效判定不依赖任何人调用）+ 核销（商户销掉已兑现的凭证）
- [x] 审计留痕：失败交易（status=0 + 自定义 error）+ `recordBlockedTransfer` 审计流水，双路可交叉核对
- [x] 零 gas 语义：gasPrice=0 / baseFeePerGas=0，但**时延不省**（受出块周期约束）

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1（OZ v5.0.2 vendored）
- 联盟网：Besu 26.9.0 QBFT 4 验证者（chainId 19880601，RPC 8551–8554）
- 前端：静态权益管理台（ethers v6 UMD，零构建）+ 同源 RPC 代理
- 内网对象存储：本地 kubo（API 5001 / 网关 8088）

## 环境准备

```bash
# 1) 联盟网（4 验证者 QBFT）
cd ../../shared/consortium-network
bash scripts/00-preflight.sh
bash scripts/10-genesis.sh          # 生成 genesis + 4 把验证者密钥（本地生成，不入库）
bash scripts/20-up-docker.sh        # 或 scripts/21-up-native.sh（Windows 本机用的就是 native）
# 校验：四个节点 RPC 8551/8552/8553/8554 都应可查

# 2) 内网对象存储（kubo，数据不出内网）
ipfs daemon --offline &             # API 5001，网关 8088
```

## 目录

```text
B07-NFT市场联盟网/
├── src/LabCredential.sol        权益凭证：成员白名单/禁二级/EIP-4907/元数据哈希/批量/到期/核销/审计
├── test/Credential.t.sol        25 项：白名单正负例、禁二级、4907、批量 1000、到期回收、核销、Merkle 证明
├── script/Deploy.s.sol          部署 + 部署记录（deployments/<chainId>/B07.json）
├── script/deploy.sh             联盟网部署器（三条硬规矩写在文件头）
├── scripts/                     node + ethers v6 验收脚本（见下表）
│   ├── lib/b07.js               公共层：配置/提供者/零 gas 交易/断言
│   ├── 02-members-transfer.js   多成员转让 + 权限负例 + 审计留痕
│   ├── 03-zero-gas.js           零 gas 断言
│   ├── 04-finality.js           3 节点终结性一致
│   ├── 05-batch-1000.js         1000 份批量（含 gas 上限 + 链上抽验 Merkle 证明）
│   ├── 06-redeem-expiry.js      核销时延 + 到期自动回收
│   ├── 07-merkle-proof.js       内网 OSS 上传 + P01 出证库算根 + 链上验证明
│   ├── 08-faucet-credential.js  与 B03 水龙头的衔接验收（领水→领证 + 负例）
│   └── credential-service.js    发证服务（8580）：登记成员 + 发行凭证，供水龙头回调
├── frontend/                    权益管理台（静态页 + 同源 RPC 代理，见 scripts/serve-frontend.js）
├── env/consortium.env           联盟 profile（无密钥）
├── env/.env.local               成员私钥（**本地生成，不入库**，被 .gitignore 的 .env.* 排除）
├── abi/ · deployments/          自动导出；前端 import（禁手抄）
└── screenshots/                 01~03 管理台截图
```

## 运行

```bash
cd projects/B07-NFT市场联盟网

# 0) 准备本地成员私钥（一次性，脚本从联盟网本地密钥库读取）
node scripts/_gen-local-env.ps1        # → env/.env.local（不入库）

# 1) 编译 + 部署（零 gas / london 指令集 / 显式 gasLimit）
bash script/deploy.sh consortium       # Windows：pwsh scripts/deploy-consortium.ps1

# 2) 逐条验收
node scripts/02-members-transfer.js
node scripts/03-zero-gas.js
node scripts/04-finality.js           # FINALITY_WAIT_SECONDS=300 为生产口径
node scripts/05-batch-1000.js
node scripts/06-redeem-expiry.js
node scripts/07-merkle-proof.js

# 3) 权益管理台
node scripts/build-frontend.js         # 下发部署地址与 ABI
node scripts/serve-frontend.js 5180   # → http://127.0.0.1:5180/

# 4) 与 B03 水龙头衔接（可选）
node scripts/credential-service.js                          # 发证服务 8580（私钥读 env/.env.local）
# B03 侧带钩子重启水龙头：
#   cd ../B03-链上交互实战联盟网 && set CREDENTIAL_URL=http://127.0.0.1:8580 && node faucet/start.js
node scripts/08-faucet-credential.js                        # 衔接验收
```

## 与 B03 水龙头的衔接（2026-11-13）

联盟用户的第一动作是「领币」，权益凭证的第一动作是「领证」。两者本该是**一次领取**：

```
钱包页「领取 10 B03」
   └─ B03 faucet(8560) 发 10 B03（链上余额 = 资产）
        └─ 回调 B07 发证服务(8580)
             ├─ 校验：链上余额 > 0（= 确实领过水）→ 否则 429
             ├─ setMember(address)        → 登记为链上成员（白名单）
             ├─ 生成元数据 → 上传内网 OSS   → 算 Merkle 根（P01 出证库）
             └─ mintBatch(...)             → 发行 1 份凭证（链上只存根）
   返回体带 credential: {ok, tokenId, txHash, metadataUri} → 钱包页直接展示
```

**为什么发证要有前置条件**：凭证是**权益**不是空投。若任何地址都能找服务领证，凭证就失去稀缺性，
白名单也就形同虚设。所以前置条件是「链上有余额」——这是链上可验证的事实，不依赖任何服务的记账。

**衔接失败不阻断领币**：币已经发出去了，不能因为凭证服务挂了让人拿不到钱；
钱包页会显示「凭证未发放 + 原因」，凭证可稍后单独申领（`POST 8580/issue`）。

**实测**：一次领取 → 10 B03 + 凭证 #2044（含凭证交易哈希与内网元数据链接，`screenshots/04`）；
负例按预期被拒（没领过水 → 429「请先到水龙头领 10 B03 再领凭证」；60s 内重复领取 → 429 冷却）。

## 验收（实测记录，2026-11-13）

| 项 | 结果 |
|----|------|
| Foundry 测试 | **25 passed / 0 failed**（含 2 项 Merkle 证明正反例、2 项批量 gas 上限断言） |
| 部署 | `0x111B7DD4980E2B4267020939Df33FdF9afD485A7`，chainId 19880601，`evmVersion=london`，部署 gas 3,526,477（gasPrice 0） |
| 多成员 | issuer `0x240c…` / memberA `0x9de4…` / memberB `0xb4e2…` / outsider `0xbcc5…`（4 个验证者账户兼作成员账户） |
| 正例：成员间转让 | ✅ A→B 成功（gasUsed 59,508） |
| 负例：转给非成员 | ✅ revert（`NotMember`）；`checkTransfer` 预检返回 `NOT_MEMBER_TO`；审计流水追加一条（操作者/从/到/凭证/原因/时间戳） |
| 负例：撤销成员后转出 | ✅ revert |
| 零 gas | ✅ `eth_gasPrice = 0`；`baseFeePerGas = 0`；`tx.gasPrice = 0`；`type = 0`（legacy）；交易 status=1 且 gasUsed > 0（确实执行了） |
| 终结性 | ✅ 3 个节点（8551/8552/8553）对同一块：块哈希一致、交易都在；等待后再次查询仍一致（无 reorg） |
| 批量 1000 份 | ✅ 4 笔 × 250 份，每笔 gasUsed **6,626,396 = 单笔上限的 39.5%**；`mintBatch(1000)` 被合约 `BatchTooLarge` 直接挡下；链上 `nextId` +1000、余额 +1000 |
| 元数据锚定 | ✅ 1000 份元数据上传内网 kubo（目录 CID），根用 **P01 出证库 `shared/evidence/lib/merkle-indexed.js`** 计算并锚到链上；链上 `verifyProof` 通过，篡改叶子与换位置（index5 的证明验 index6 的叶子）均被拒 |
| 核销时延 | ✅ 核销接口往返 P50 46ms / **P95 48ms < 300ms**；链上确认 4.1–8.1s（**受 5s 出块周期约束，不是接口问题**） |
| 到期自动回收 | ✅ 到期判定**不依赖任何人调用**：过期凭证立刻不可转让、不可核销；`sweepExpired` 任何人可调用并留痕（`sweptCount` 上链） |
| 权益管理台 | ✅ 真实浏览器驱动：连接钱包 → 加载 2042 份凭证 → 成员白名单 → 审计流水 2 条；截图 `screenshots/01~03` |
| **水龙头衔接** | ✅ 一次领取 = 10 B03 + 权益凭证 #2044（含凭证 tx 与内网元数据链接，`screenshots/04`）；负例：没领过水 → 429、60s 冷却 → 429；元数据重算的 Merkle 根与链上锚定一致 |
| 仓库零私钥 | `env/.env.local` 被 `.gitignore` 的 `.env.*` 排除（`git check-ignore` 已验证）；`env/consortium.env` 只有地址与 profile |

## 联盟网特有的坑（本轮实测，与 P07 不重叠）

1. **CORS**：Besu 的 `corsAllowedDomains=[]` → 浏览器直连 8551 被 CORS 拒（anvil 允许 localhost，所以 P07 完全没遇到）。
   解法：**同源 RPC 代理**（`scripts/serve-frontend.js` 的 `/rpc`），生产部署也应如此。
2. **成员账户余额为 0** → `eth_estimateGas` 以「余额不足」直接失败 → **必须显式 `gasLimit`**，
   gas 估算这一步过不去。（零 gas 网络不豁免余额检查）
3. **PUSH0**：genesis 只开到 london，用 cancun 编译会让部署交易**进块但 status=0**（B04 已踩过，合约侧用
   `FOUNDRY_PROFILE=consortium` 编译）。
4. **Solidity 不允许按名内部调用 `external` 函数**：合约里 `batchOf` 必须 `public`，否则报错文案很误导
   （"Undeclared identifier. Did you mean 'batches' or 'batchOf'?"）。
5. **OZ v5 没有 `_beforeTokenTransfer`**：转让策略只能写在 `_update` 里（`from != 0 && to != 0` 才是转让）。
6. **零 gas 不等于零时延**：出块周期 5s，核销交易的确认时延下限就是一个出块周期——业务 SLA（P95 < 300ms）
   要落在**接口往返**上，链上确认是异步结算。
7. **脚本坑**：`await contract.method()` 在 `eth_sendTransaction` 返回时就 resolve，**revert 发生在挖块阶段**，
   不 `wait()` 就看不到失败（负例会假通过）；同理，取函数返回值要用 `staticCall`。
8. **PowerShell 坑**：无 BOM 的 `.ps1` 被 PS 5.1 按 GBK 读 → 中文路径乱码 → 脚本里一律用 `$PSScriptRoot` 相对路径；
   `Set-Content -Encoding UTF8` 会给 JSON 加 BOM → `JSON.parse` 报错 → 读 JSON 统一剥 BOM。
9. **私钥不要上命令行**：PowerShell → cmd 的 `set VAR=... && node` 会带上尾随空格，ethers 直接拒
   （`invalid BytesLike value`）。做法：服务自己读 `env/.env.local`，或用启动器 `faucet/start.js` 从根 `.env` 读。
10. **钩子超时要给足**：发证要两笔交易（setMember + mintBatch）= 两个块 ≈ 10s，
   钩子超时给 8s 会「链上已发证但回调报超时」——看起来像失败，其实凭证已到账。

## 复盘

- **最意外的差异**：不是「零 gas 改变了合约设计」，而是**联盟网把浏览器这一层整个挡在门外**（CORS），
  以及**零 gas 网络仍然要余额检查**。两条都属于「联盟网运营语义」而不是「EVM 语义」，P07 完全照搬会翻车。
- **禁二级不是「关掉一个开关」**：P07 的二级入口是一个 `tradingEnabled` 布尔；B07 的做法是**根本没有市场合约**，
  转让只能发生在白名单成员之间——合规从「运行时开关」变成了「合约结构」。
- **审计留痕要两路**：失败交易本身在链上（status=0 + 自定义 error），但它**不能被索引**；
  所以额外提供 `checkTransfer`（只读预检）+ `recordBlockedTransfer`（写审计），让被拒的尝试也有可查询的记录。
- **到期自动回收 0 例外**：关键不在「有没有回收函数」，而在**失效判定不依赖任何人调用**；
  `sweepExpired` 只是把「已失效」显式化并清理占用（教学意义 > 功能意义）。
- **对客交付时客户最关心的问题**：凭证到期后能不能继续用、成员离职后凭证怎么回收、转让被拒怎么举证——
  这三条分别对应 `isExpired`（无需任何人调用）、白名单撤销即冻结、以及审计流水 + 失败交易双路留痕。
- **衔接的最有价值的一条设计**：发证前置条件用**链上可验证的事实**（余额 > 0 = 领过水），
  而不是服务自己的记账文件——这样「能不能领证」不依赖任何一方的账本，跨服务也自洽。
- 待补：P08 的零 gas 语义讨论（「省 gas」变「省区块容量」）、B07 与 B03 联盟水龙头的衔接（成员领水 + 领凭证）。
