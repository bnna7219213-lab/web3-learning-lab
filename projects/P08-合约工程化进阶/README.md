# P08 · 合约工程化进阶包（进阶）

> 状态：**已完成，本机实测通过（anvil 零私钥：40 项测试 + 部署 + 两步升级演练 + 链上对账）** ｜ 里程碑：M2·W8 ｜ 层级：进阶 ｜ 主线：合约 ｜ 依赖：P05 ｜ 更新：2026-11-13
> 一句话目标：把「贵、能改、可预测地址、批量证明」四件事各做一个可复现实验，形成工程判断力。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 运行

```bash
cd projects/P08-合约工程化进阶
forge build                      # solc 0.8.28 + OZ v5.0.2（vendored，与 P05 同源）
forge test                       # 40 项：7 suites 全绿
forge test --gas-report          # 函数聚合 gas 报告（docs/01 的口径见该文 §3）
forge fmt --check

anvil                            # 另开终端（本机已有 8545 在跑时跳过）
bash script/deploy.sh anvil      # 零私钥：anvil 解锁账户 + --unlocked；写 deployments/31337/ + 导出 ABI
bash script/deploy.sh anvil --dry-run

# 代理升级演练两步（零私钥路径）：
forge script script/Upgrade.s.sol:UpgradeScript --sig "deployV1()" \
  --rpc-url http://127.0.0.1:8545 --broadcast --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked
cast send <proxy> "deposit()" --value 1ether --unlocked --from 0xf39F…2266 --rpc-url http://127.0.0.1:8545
forge script script/Upgrade.s.sol:UpgradeScript --sig "upgradeToV2(address)" <proxy> \
  --rpc-url http://127.0.0.1:8545 --broadcast --sender 0xf39F…2266 --unlocked

# 联盟网（可选，需 shared/consortium-network 已拉起，见 P03 README）：
export DEPLOYER_PRIVATE_KEY=<一次性 key>   # consortium 拒绝回落根 .env
bash script/deploy.sh consortium # FOUNDRY_PROFILE=consortium（london）+ legacy gasPrice 0
```

三个网络 profile：`anvil`（已实测）· `consortium`（配置就绪，待网络拉起）· `sepolia`（配置就绪，待 faucet）。
**WSL 下跑 bash 脚本**：本机 `bash` 是 WSL 且不解析裸 `forge`（interop 不补 `.exe`），
需先为 `~/.foundry/bin/*.exe` 建 shim 或直接用 PowerShell 跑 `forge` 命令（本次实测走 shim，见 docs 复现段）。

## 目录

```text
P08-合约工程化进阶/
├── foundry.toml                default/test/release(via_ir)/consortium(london) + fuzz/invariant
├── src/
│   ├── StorageLayoutDemo.sol   打包版 + 拆槽对照版（uint256 垫片强制拆槽）
│   ├── GasLab.sol              四组 naive/optimized 对照（缓存读/calldata/unchecked/单槽写）
│   ├── Create2Factory.sol      CREATE2 工厂 + computeAddress（EIP-1014 同公式）
│   ├── UUPSUpgrade.sol         MinimalOwner + VaultV1/V2 + VaultBadV2（插队反例）
│   ├── MerkleAirdrop.sol       sha256 + L|/N| 前缀 + 索引定位（与 P01 逐字对齐）
│   └── AccountAbstraction.sol  SmartAccount + MiniEntryPoint（4337 概念裁剪版）
├── test/                       7 suites / 40 项（单测 + 负例 + 反例 + 双向对账）
├── script/
│   ├── Deploy.s.sol + deploy.sh  主部署（沿用 P04/P05：零私钥 + 记录 + ABI 导出）
│   └── Upgrade.s.sol             升级演练两步（内置升级前后槽位对账）
├── env/{anvil,consortium,sepolia}.env   无密钥入库
├── docs/                       01 Gas对比表 · 02 代理升级与槽冲突 · 03 Merkle互相验证 · 04 Create2与AA
├── abi/ · deployments/         自动生成（按 chainId 分目录 + latest.json）
└── broadcast/                  forge 广播记录
```

## 知识点

- [x] 存储布局与 slot 手工计算：`vm.load` 对账 slot0 位布局（uint128|uint64|bool）、slot1（address|uint96）、mapping 槽 keccak(key,slot)；**OZ v5 Initializable 已迁 ERC-7201，v4 教程「slot0=_initialized」不成立**（forge inspect 实测）
- [x] Gas 报告与优化（calldata/packing/缓存）：四组对照 + 打包 vs 拆槽（省 44k）；**测量先预热排除冷/热时序伪影**，单次读写两版只差 64 gas——方法论见 [docs/01](./docs/01-Gas对比表.md)
- [x] Create2 确定性地址：预计算=实部署=forge 官方公式；salt/initCode/工厂地址三变体负例；反事实地址先充值后部署
- [x] UUPS/Transparent 代理与升级迁移脚本：V1→V2 状态七项保留（链上实测）+ BadV2 插队槽冲突复现 + 非 owner 拒 + 升级脚本内置槽位对账
- [x] 合约端 Merkle proof 验证：与 P01 双向对账（链下证明链上验 + 链上重 build 根相等）+ 三类负例 + P01 已知弱点同弱复现
- [x] ERC-4337 账户抽象概念落地：反事实部署 + 账户内验签（单签/双因素）+ nonce 重放保护；与真实 4337 的差异清单见 [docs/04](./docs/04-Create2与账户抽象.md)

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1 + forge-std + **OpenZeppelin v5.0.2**（vendored，与 P05 同源）
- Slither/Aderyn：本阶段未引入（见复盘「下次可压缩」）
- 网络：anvil（cancun，已实测）· Besu QBFT（london，零 gas，配置就绪）· Sepolia（配置就绪）

## 验收（实测记录，2026-11-13）

| 项 | 结果 |
|----|------|
| forge test | **40 passed / 0 failed**（7 suites）。⚠️ `foundry.toml` 配了 `fuzz runs=500` / `invariant runs=64`，但**当前 40 条测试全是无参函数，尚未落地 fuzz/invariant 用例**——是配置就绪，不是模糊测试已覆盖（待补，见「待补」） |
| forge fmt --check | 通过（改动全部格式化后复测） |
| Gas 对比表入 docs/ | ✓ [docs/01](./docs/01-Gas对比表.md)：5 组数字 + 冷热预热方法论 + 零 gas 链口径 |
| 代理升级演练含存储槽冲突检查 | ✓ 链上两步演练：存 1 ETH → 升级 V2 → totalDeposited/owner/余额七项保留，实现槽换址；测试含 BadV2 插队复现与 EIP-1967 槽零重叠检查（[docs/02](./docs/02-代理升级与存储槽冲突.md)） |
| 合约端 Merkle 与 P01 互相验证 | ✓ 双向：P01 出证包（root `9a70e0ab…`）合约端验过 + 合约端重 build 根逐字相等 + 弱点同弱复现（[docs/03](./docs/03-Merkle互相验证.md)） |
| anvil 部署 | `bash script/deploy.sh anvil` 零私钥成功：MerkleAirdrop `0x14298594…`（root 链上读回 = P01 root ✓）、GasLab `0xB0D4afd8…`；deployments/31337/ + abi/ 落盘 |
| 升级演练链上状态 | 升级前 `totalDeposited=1e18` → 升级后同值；实现槽 `0x21df54…` → `0xdc11f7…`；`totalWithdrawn` 新字段 = 0 ✓ |
| 仓库零私钥 | env/*.env 无密钥；anvil 走解锁账户；consortium 拒绝回落根 .env（与 P05 同款防线） |

## 过程中修掉的真实缺陷（都有教学价值）

1. **gas 对账首版把冷/热时序当算法差异**：naive 先跑付冷 SLOAD 2,100、cached 后跑享热 100，
   测出 14 万「差距」；预热后真实差 6,473。组4 更直接：预热后两版只差 64 gas。
   **比 gas 先对齐访问时序**（docs/01 §2）。
2. **`StorageSlot.getAddressSlot(槽).value` 读的是调用方自己的存储**——查代理的实现槽必须
   `vm.load(proxy, 实现槽)`，首版断言读出 0 全线假失败。
3. **中文字符串字面量必须 `unicode"…"`**：裸中文直接编译错误（本项目 30+ 处断言消息批量改）。
4. **OZ 主包 Ownable 没有 `__Ownable_init`**（那是 upgradeable 包的 API）——vendored 只有主包，
   改写 `MinimalOwner` 最小等价实现，避免为一个函数引整包。
5. **`type(uint64).max + 1` 在测试合约内先溢出**：expectRevert 还没执行到被测调用就 panic，
   报「call didn't revert at a lower depth」——先 `uint256(...)` 提升再加。
6. **插队变量的槽位要以 inspect 为准**：BadV2 实测 `totalWithdrawn` 落 slot2（不是我预设的 slot3），
   NatSpec 按实测重写——「文档写推算值」本身就是槽冲突事故的温床。
7. **WSL bash 不解析裸 `forge`**（interop 未补 `.exe`）：脚本跑不起来，用 `/tmp/fshim` 包一层才通。

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 精读 `hardhat/contracts/defi/LainStaking.sol`（Synthetix 累加器，本金/奖励解耦）与 `market/SplitPayment.sol` 的 `_accPerShare`
- **待源件**：lainchain 不在本机（公开仓库剥离时未带），不凭印象写对照。源件可得后补 `docs/S3-合约进阶与数据/lainchain对照-P08.md`。

## 待补（本次已识别，尚未做）

1. **Call / Delegatecall 专项缺失**：`roadmap.md` 的 S3 知识点地图把「Call/Delegate、Assembly/Yul」记在 P08，
   但 `src/` 里没有对应合约与测试（只有 `AccountAbstraction.sol` 里一处 `address(this).call{value:}`）。
   要么补 `DelegateCallDemo.sol`（含存储碰撞反例）+ 测试 + 文档，要么改 roadmap 口径。
2. **fuzz / invariant 用例缺失**：见上表脚注。`foundry.toml` 已配好，补用例即可。
3. **`deployments/latest.json` 语义**：旧实现逐合约覆写 → 只剩最后一个合约；已改为合并写
   （`deployments/<chainId>/all.json` + `deployments/latest.json`，口径与 B08 一致），磁盘上的历史记录也已修正。
4. **lainchain 对照**：见上节（外部依赖，源件不在本机）。

## 复盘

- 卡住的点：**测量方法论比合约本身难**——gas 对账两次被非算法因素污染（冷热时序、读错合约的槽）。
  教训统一成一句：断言的数字先问「测量条件对齐了吗」，再问「实现对吗」。
  合约项目的「能编译 ≠ 测得对，测得对 ≠ 链上对」——这次链上演练又补了第三段。
- 与 Java/传统后端的对照：存储布局 ≈ 对象字段在序列化协议里的字节偏移（改字段顺序 =
  破坏线上协议兼容）；`__gap` ≈ schema migration 里预留的扩展位；CREATE2 反事实地址 ≈
  预注册的分布式 ID（先占 ID 后建实体）；4337 验证入口在账户内 ≈ 把鉴权策略从网关下沉到
  每个会话自己实现（策略可编程 vs 网关写死）。
- 下次可压缩的时间：脚手架/部署脚本/env 三件套直接从 P05 复制改名可省半天；
  **开工前先引 Slither**（本次没跑，静态分析应在写完 S2 就上，而不是收尾补）；
  gas 实验的预热规范应在第一条对照写之前定死，返工了两轮。

## B08（联盟网分支）—— 已接（2026-11-13 全部落地并实测）

- [x] Gas 报告改成「区块容量占用 + 出块延迟影响」双指标（零 gas 语义校准 §已立口径）→ [B08 scripts/06](../B08-合约工程化联盟网/scripts/06-gas-report.js)
- [x] 一次代理升级演练含全成员参与与回滚方案 → [B08 scripts/07](../B08-合约工程化联盟网/scripts/07-upgrade-drill.js)（六步 13 断言）
- [x] 大合约（>24KB）在 contractSizeLimit/pertxgaslimit 配置下部署实测 → [B08 scripts/09](../B08-合约工程化联盟网/scripts/09-big-contract.js)
- [x] chainId 变更使 Create2 地址全变的登记机制 → [B08 scripts/10](../B08-合约工程化联盟网/scripts/10-create2-chainid.js)
- [x] （额外）B08 补了零构建运维看板与一键 runner；B08 的工程事件已进 B09 索引并跨项目对账
      → [B08 docs/06](../B08-合约工程化联盟网/docs/06-工程化运维看板.md)、[docs/07](../B08-合约工程化联盟网/docs/07-B08与B09联动.md)

> B08 相对 P08 的**新增**结论（不在 P08 知识点清单里，是联盟网逼出来的）：
> 零 gas 下 Gas 优化的目标从"省钱"变成"省区块容量与降出块延迟"；
> 升级从 owner 单方行为变成多成员签名窗口；大合约卡点是单笔 gas 上限而不是 EIP-170；
> CREATE2 地址必须与链 ID / 工厂地址一起永久登记。
