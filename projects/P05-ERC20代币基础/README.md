# P05 · ERC20 代币（基础）

> 状态：**已完成，本机实测通过（anvil + 联盟网双部署）** ｜ 里程碑：M1·W3–4 ｜ 层级：基础 ｜ 主线：合约 ｜ 依赖：P04 ｜ 更新：2026-11-11
> 一句话目标：实现带权限与 Permit 的 ERC20，理解授权模型的安全含义与「计价载体」的合规选择。
> 合规边界：LAB 是**学习记账单位**，零价值、无行情/兑换/募资语义；设计边界写进合约 NatSpec。

## 运行

```bash
cd projects/P05-ERC20代币基础
forge build                      # solc 0.8.28 + OZ v5.0.2（vendored）
forge test                       # 36 项：单元 / 4×500 轮 fuzz / invariant 64×32
forge coverage                   # LabToken.sol 行/分支/函数 100%

anvil                            # 另开终端
bash script/deploy.sh anvil      # 零私钥：anvil 解锁账户 + --unlocked；写 deployments/31337/ + 导出 ABI

# 联盟网（可选，需 shared/consortium-network 已拉起，见 P03 README）：
export DEPLOYER_PRIVATE_KEY=<一次性 key>   # consortium 拒绝回落根 .env
bash script/deploy.sh consortium # FOUNDRY_PROFILE=consortium（london）+ legacy gasPrice 0

node tools/serve.mjs             # 仓库根另开终端
# 面板：http://127.0.0.1:8787/projects/P05-ERC20代币基础/frontend/
node scripts/export-transfers.mjs   # Transfer 事件 → data/transfers.{json,csv}
```

三个网络 profile：`anvil`（已实测）· `consortium`（已实测）· `sepolia`（配置就绪，待 faucet，见 P03 附录）。
编译 profile 与网络 profile 分两层的设计见 P04 docs/01；**OZ 为什么锁 v5.0.2 见 [docs/02](./docs/02-版本与编译-工具链坑.md)**。

## 目录

```text
P05-ERC20代币基础/
├── foundry.toml              default/test/release/consortium(london) + fuzz/invariant 设置
├── src/LabToken.sol          ERC20+Burnable+Permit+AccessControl；CAP 在 _update 钩子；quoteProRata 向下取整
├── test/
│   ├── LabToken.t.sol        19 项：元数据/角色/上限/burn/转账/舍入 + 3 fuzz
│   ├── Permit.t.sol          10 项：permit 正例 + 重放/跨链/过期/代签/篡改 + 1 fuzz
│   ├── ApproveRace.t.sol     4 项：竞态复现 + 两条真缓解 + decreaseAllowance 无效证明
│   └── Invariant.t.sol       3 不变式：Σ余额==supply / mint-burn 记账 / CAP 不破
├── script/Deploy.s.sol       部署 + DeploymentRecorder（admin 外置、初始铸造不越权）
├── script/deploy.sh          网络分发器；anvil 零私钥路径；consortium 零 gas legacy
├── env/{anvil,sepolia,consortium}.env   无密钥入库
├── frontend/                 零依赖面板：手写 ABI 编解码 + 事件解码 + immutable 掩槽指纹核对
├── scripts/export-transfers.mjs   Transfer 事件表导出
├── abi/ · deployments/       自动生成（selectors 27 个；按 chainId 分目录 + latest.json）
├── docs/                     01 授权模型 · 02 版本与编译坑
└── screenshots/              01-面板读写与指纹核对.png
```

## 知识点

- [x] ERC20 事件与精度：Transfer/Approval 覆盖全部状态变更（mint/burn 以 0x0 端点表达）；decimals=18
- [x] approve/transferFrom 竞态：复现 150 叠加提取；**decreaseAllowance 不消除竞态**（v5 移除原因）；真缓解=确认后再授 / permit 从零授权
- [x] EIP-2612 permit 与 EIP-712 域分隔：重放/旧 nonce/跨链/链切换/过期/代签/篡改 七类负例全钉死
- [x] Ownable vs AccessControl：admin 外置 + MINTER_ROLE 分离；CAP immutable「不能作恶写进代码」
- [x] 铸造/销毁与供应量治理：mint 单入口 + _update 钩子查上限；burn 是持币人产权
- [x] 整数运算与舍入方向：quoteProRata 向下取整，Σ quotes ≤ pool（fuzz 500 轮）

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1 + forge-std v1.9.6 + **OpenZeppelin v5.0.2**（均 vendored，非 submodule）
- 前端：原生 ES Module + fetch，零依赖（P06 才引 Wagmi/Viem）
- 网络：anvil（cancun）· Besu QBFT（london，零 gas）· Sepolia（配置就绪）

## 验收（实测记录，2026-11-11）

| 项 | 结果 |
|----|------|
| forge test | **36 passed / 0 failed**（4 suites）；fuzz 4 项各 500 轮；invariant 64 runs × depth 32 |
| forge coverage | LabToken.sol **100% 行(17/17) / 100% 语句(21/21) / 100% 分支(5/5) / 100% 函数(4/4)** |
| permit 重放门禁 | 改 chainId / 重放 nonce 均失败 ✓（Permit.t.sol 7 类负例） |
| 所有外部调用有事件 | ✓ 映射表见 docs/01 §1 |
| gas（default profile） | deploy 1,401,400 / 7179 B；mint μ51,784；transfer μ34,560；approve μ40,451；permit μ73,538；quoteProRata μ5,307 |
| anvil 部署 | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9`，admin=0xf39F…2266，初始铸造 100,000 LAB；指纹 `0x4af7e474…`（cancun） |
| 联盟网部署 | `0x0C06A533F43458AF31B3DD27793a0eABA1519A97`，admin=运营账户；指纹 `0x91cf1a04…`（london）——**同源码不同 evmVersion 指纹不同，已随记录落盘** |
| 链上读 | 两网 totalSupply=1e23 / name / CAP 核对 ✓ |
| 面板 | 元数据/查询/事件/转账演示全通；转账 tx `0x362c4c4a…` status=1 gasUsed=51,651；指纹核对「是」（掩 immutable 槽后逐字节一致） |
| 事件导出 | 2 条 Transfer（mint+transfer）→ data/transfers.{json,csv} |
| 截图 | screenshots/01-面板读写与指纹核对.png |
| 仓库零私钥 | env/*.env 无密钥；anvil 走解锁账户；consortium 拒绝回落根 .env |
| 去代币化 | LAB 零价值记账单位；NatSpec 写明边界；无行情/兑换语义 |

## 过程中修掉的真实缺陷（都有教学价值，详见 docs/02）

1. **OZ v5.7 的 Bytes.sol 用 Cancun 指令 mcopy** → london profile 编译失败；锁 v5.0.2（工具链锁定原则的实战）。
2. **OZ v5 错误/事件迁移到 IERC20Errors / IERC20** → 从 v4 教程抄的 `ERC20.XxxError` 全部编译失败。
3. **immutable CAP 部署时回填字节码** → 面板指纹核对「长度相同但字节不等」；按 immutableReferences 掩槽后一致。
4. **forge expectRevert(bytes4) 是精确匹配** → 带参错误即使 selector 一致也假失败；改 expectPartialRevert。
5. **vm.prank 被中间的外部 view 调用消耗** → grantRole 以默认 sender 执行而权限拒绝；角色常量先读进状态变量。
6. **`after` 是 solc 0.8.28 保留字**；**forge 默认 sender 不在 anvil 账户表** → anvil 零私钥路径用 --sender + --unlocked。

## lainchain 对照精读

- [ ] 读 `hardhat/contracts/core/LainToken.sol` 与 `GameGold.sol`：两个代币的职责差异与 emission 逻辑
- **待源件**：lainchain-defi 不在本机（公开仓库剥离时未带），不凭印象写对照。源件可得后补 `docs/S2-智能合约入门/lainchain对照-P05.md`。

## 复盘

- 卡住的点：四层版本语义（solc/evmVersion/OZ/forge 工具）各咬了一口——**合约项目的「能编译」不等于「能部署」，「能部署」不等于「指纹可对」**。
- 与 Java/传统后端的对照：AccessControl ≈ RBAC 权限表；approve 竞态 ≈ 并发修改共享额度 without CAS；
  permit ≈ 带 nonce 的签名授权令牌（OAuth refresh token 的单次化版本）；immutable CAP ≈ 数据库 schema 级约束而非应用层校验。
- 下次可压缩的时间：DeploymentRecorder 与面板骨架直接复用 P04，省掉约半天；OZ 选型应在开工前按目标链 evmVersion 先验编译。