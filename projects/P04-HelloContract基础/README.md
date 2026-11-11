# P04 · HelloContract + Foundry 测试（基础）

> 状态：**已完成，本机实测通过** ｜ 里程碑：M1·W3–4 ｜ 层级：基础 ｜ 主线：合约 ｜ 依赖：S0/P01 ｜ 更新：2026-10-14
> 一句话目标：跑通「写合约 → 测试 → 多网络 profile 部署 → 前端只读核对」最小闭环，并建立 ABI/部署记录自动下发的工程习惯。

## 运行

```bash
cd projects/P04-HelloContract基础

forge build                      # 编译（solc 0.8.28）
forge test -vv                   # 10 项测试（含 2 个 500 轮 fuzz）

anvil                            # 另开终端起本地链
bash script/deploy.sh anvil      # 部署 + 写 deployments/31337/Counter.json + 导出 ABI

node tools/serve.mjs             # 再开终端起静态服务
# 面板：http://127.0.0.1:8787/projects/P04-HelloContract基础/frontend/
```

三个网络 profile：`anvil`（本地）· `sepolia`（公共测试网，需 `.env` 私钥与测试币）· `consortium`（自建 Besu QBFT，见 [B04](../B04-HelloContract联盟网/README.md)）。
**为什么分两层 profile（编译 vs 网络）**见 [docs/01-网络profile设计.md](./docs/01-网络profile设计.md)。

## 目录

```text
P04-HelloContract基础/
├── foundry.toml            编译 profile：default / test / release + fuzz 与 invariant 设置
├── src/Counter.sol         count + 环形历史 + 权限 + 自定义 error + 事件
├── test/Counter.t.sol      10 项：单元 / 事件 / 权限 / 环缓冲 / fuzz / 溢出 / 字节码指纹
├── script/
│   ├── Deploy.s.sol        部署 + DeploymentRecorder（写 deployments/<chainId>/Counter.json）
│   └── deploy.sh           网络 profile 分发器 + ABI/选择器自动导出
├── env/{anvil,sepolia,consortium}.env
├── abi/                    自动生成（Counter.json / bytecode / selectors）
├── deployments/            自动生成（按 chainId 分目录 + latest.json）
├── frontend/               零依赖只读面板（fetch 直连 JSON-RPC）
├── docs/                   01 profile 设计 · 02 B04 联盟网注意
└── screenshots/
```

## 知识点

- [x] Solidity 0.8 溢出行为、`unchecked` 的取舍、自定义 error 省 gas 且可读
- [x] 事件与 `indexed`（`actor` 建索引 → 后端可按人查）
- [x] 权限模型：`owner` + `onlyOwner` + `transferOwnership`（P19 治理、B04 账户白名单的接口点）
- [x] 存储布局直觉：定长数组环形缓冲 vs 只存终值的 gas 差（P08 量化）
- [x] Foundry：`forge build/test/script/inspect`、`vm.prank/expectRevert/expectEmit/bound/envOr`、fuzz 与 `--gas-report`
- [x] 部署工程：多网络 profile、部署记录（含 `deployedBytecodeHash`）、ABI 与选择器自动下发
- [x] JSON-RPC 手写编码解码：`eth_call` / `eth_sendTransaction` / `eth_getCode` / ABI 动态类型（string 偏移+长度）
- [ ] 模糊测试之外的 invariant 测试（放到 P17/P18，本项目的计数不变式过于平凡）

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1 + forge-std v1.9.6（vendored 在 `lib/`，非 submodule）
- 前端：原生 ES Module + `fetch`，零依赖（P06 才引入 Wagmi/Viem 与钱包）
- 网络：anvil（已实测，零私钥解锁账户路径）· Sepolia（配置就绪，待领水）· Besu QBFT（2026-11-11 本机实测通过，`env/consortium.env`）

## 验收（实测记录，2026-10-14）

| 项 | 结果 |
|----|------|
| `forge test` | **11 passed / 0 failed**；fuzz 两项各 500 轮（μ gas 66649 / 52196） |
| 单测 gas | `increment` 67,982；`reset` 权限拒绝 13,523；环缓冲 10 次写入 259,652 |
| 部署 | anvil 成功，`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`，估算 503,964 gas |
| 部署记录 | `deployments/31337/Counter.json`：address / chainId / deployer `0xf39F…2266` / **admin**（可外置）/ `deployedBytecodeHash` / version / profile |
| 指纹稳定性 | 同一份源码两次部署 hash **完全一致**；改构造签名后 hash 变为 `0x135b9ae5…` → 证明它确实在跟踪代码，可当版本指纹 |
| 链上读 | `eth_call count()` → `0x…07`；面板显示 count 7 / previousCount 0 / VERSION "1.0.0" / history [0×8] |
| 链上写 | 面板发 `increment(5)` → status `0x1`、gas 73,139、区块 4；随后 count 7→**12**、previousCount **7**、history[0] **7** |
| 字节码核对 | 链上 code 1321 字节 == 本地 `out/` 产物 → 面板显示"是 → 链上跑的就是这份编译产物" |
| ABI 导出 | `abi/Counter.json` 16 条目；`Counter.selectors.json` 9 个选择器（`count()` = `06661abd`） |
| 截图 | `screenshots/01-面板读写与指纹核对.png` |

## 过程中修掉的真实缺陷（都有教学价值）

1. **Solidity 字符串字面量不能放中文** → 断言消息里的中文导致编译失败；注释可以中文，字符串必须 ASCII 或 `unicode"…"`。
2. **`foundry.toml` 的 `remappings` 不能写在 `[fmt]` 段下** → 只报 warning 但重映射不生效，位置要在 `[profile.default]`。
3. **`vm.startBroadcast` 没有 `(bytes32)` 重载** → 只有 `()` / `(address)` / `(uint256)`，私钥按 uint256 传。
4. **调用 cheatcode 的函数不能标 `view`** → `vm.serializeXxx` 是外部合约调用。
5. **部署记录里的 `deployer` 记错了**：`msg.sender` 是 forge 默认脚本调用者（`0x1804c8AB…`），不是广播私钥对应的账户 → 改用 `vm.addr(pk)`，实测修正为 `0xf39Fd6e5…`。
6. **`blockNumber` 记成 0**：脚本里 `block.number` 是模拟上下文，不是链上真实高度 → 删掉该字段，真实 receipt 在 `broadcast/…/run-latest.json`（改进项见 docs/02 §四）。
7. **前端 ABI 解码两处错**：`history()` 因为没先剥 `0x` 而 BigInt 抛错；`VERSION()` 因为把字节偏移量当字符下标用而显示一串 NUL。修好后 `1.0.0` 正确显示。
8. **对照精读直接回灌的一处改动**：读完 `Faucet.sol` 发现它把 admin 作为构造参数外置，而我的 `owner = msg.sender` 会让 B04 部署时 owner 只能是我们的运营账户。
   已改为 `constructor(uint256 initial, address admin)` + `CONTRACT_ADMIN` 环境变量（缺省回落部署账户），并加 `test_Admin_IsNotTheDeployer` 固化。
   这条是"每完成一个 Pxx 写一篇对照"这个习惯的实际回报。

## lainchain 对照精读

- [x] [`docs/S2-智能合约入门/lainchain对照-P04.md`](../../docs/S2-智能合约入门/lainchain对照-P04.md)：读 `hardhat/contracts/core/Faucet.sol`，对照本项目的权限与部署记录做法

## 复盘

- 卡住的点：主要是"凭印象写 API"（上面 3、4、5 三条）。**结论：合约项目必须留下可复跑的 build/test 记录**，
  文档写得再漂亮也不如 `forge build` 报错来得快。
- 与 Java/传统后端的对照：`Deploy.s.sol` + `deployments/` ≈ Flyway 迁移 + 部署清单；
  `abi/*.json` 自动导出 ≈ 由接口定义生成客户端 stub——手抄 ABI 和手抄 DTO 是同一类事故源。
- 下次可压缩的时间：`Counter.sol` 的环形历史是为一手教学加的，实际项目里 P08 会量化它值不值（多 3 个 SSTORE 换可审计轨迹）。
