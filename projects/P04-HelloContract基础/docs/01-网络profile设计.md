# 01 · 网络 profile 设计（为什么不是一个 foundry.toml 就够）

> 一句话：**Foundry 的 `profile` 管"怎么编译"，不管"发到哪条链"**。把网络选择塞进 foundry.toml 是常见误解。

## 两层 profile

| 层 | 文件 | 内容 | 切换方式 |
|----|------|------|----------|
| 编译层 | `foundry.toml` 的 `[profile.default] / [profile.test] / [profile.release]` | solc 版本、优化器、via_ir、fuzz/invariant、fs_permissions | `FOUNDRY_PROFILE=release forge build` |
| 网络层 | `env/anvil.env` / `env/sepolia.env` / `env/consortium.env` | RPC_URL、CHAIN_ID、私钥来源、gas 模式、浏览器与 verify 开关 | `bash script/deploy.sh sepolia` |

## 三个网络 profile 的真实差异（这是本项目的重点，不是配置格式）

| 维度 | anvil | sepolia | consortium（Besu QBFT） |
|------|-------|---------|--------------------------|
| 共识 | 无（即时出块，可 `--silent`） | 真实 PoS + 重组 | QBFT，单块确定性终结 |
| 账户来源 | 内置 20 个解锁账户（私钥公开在文档里） | 自己的学习钱包私钥 | 联盟授权账户（可能受白名单约束） |
| 写交易签名 | 节点可代签（`eth_sendTransaction`） | 必须客户端签 | 必须客户端签 |
| gas | 有（默认 ~1-2 gwei） | 有，需测试币 | **0**（且必须每节点一致，否则静默丢单） |
| 浏览器 | 无 | sepolia.etherscan.io | 内网 Blockscout 或无 |
| verify | 不需要 | `forge verify-contract` + API key | **不可用** → 靠 `deployedBytecodeHash` 自证 |
| 最终性口径 | 无 | N 个确认 | 终结即确定，但 n=4 挂 2 台停链 |
| 成本 | 0 | 测试币额度限制 | 成员分摊（→ 年维保报价依据） |

## 部署记录为什么自己写

`Deploy.s.sol` 生成 `deployments/<chainId>/Counter.json`：

```json
{ "address": "...", "chainId": 31337, "deployer": "0xf39F…",
  "deployedBytecodeHash": "0x1513dcff…", "constructorInitial": 7,
  "version": "1.0.0", "networkProfile": "anvil", "rpcUrl": "…", "verifiableOnExplorer": false }
```

三个理由：
1. **联盟网没有公网浏览器**，`verifiableOnExplorer=false` 时客户只能靠这份记录核对"跑的是哪份代码"。
   面板上的"用链上 code 复核指纹"就是这条链路的演示：链上字节码 == 本地 `out/` 产物 → 一致。
2. **多网络多环境**：同一合约在 3 条链上有 3 个地址，按 chainId 分目录才不会互相覆盖（lainchain 的 `deployments/420.json` 就是这个思路的雏形）。
3. **出证需要**：`deployedBytecodeHash` 是 M4 出证包里"合约版本"这一项的锚点，P08 做代理升级时还要加实现地址与升级 tx。

## ABI 自动下发前端

`script/deploy.sh` 末尾固定导出三件：

```bash
forge inspect Counter abi --json                > abi/Counter.json
forge inspect Counter bytecode --json           > abi/Counter.bytecode.json
forge inspect Counter methodIdentifiers --json  > abi/Counter.selectors.json
```

前端 `fetch('../abi/Counter.selectors.json')` 直接读选择器，**不手抄**。
手抄 ABI 是 DApp 项目最常见的"改了合约忘了改前端"事故源；这一步在 lainchain 里由 `deploy.js` 做，我们在 P04 就养成习惯。

## 私钥的处理方式（以及为什么不用 `--private-key` 传参）

`--private-key` 会出现在 `ps` 输出与 shell history 里。本项目：
- `Deploy.s.sol` 用 `vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0))` 从**环境变量**读；
- `deploy.sh` 先 source `env/<profile>.env`，没有再回落到仓库根 `.env`（已被 .gitignore 排除）；
- `env/anvil.env` 里那条私钥是 **anvil 公开的本地账户**，不属于任何真实资产，可以进 git——这一点要在文档里写明，否则以后有人照这个样式把真私钥也提交上去。

## 一个实测踩到的坑

`vm.startBroadcast()` 的三种重载是 `()` / `(address)` / `(uint256)`，**没有 `(bytes32)`**。
我最初按 `bytes32 pk` 写，编译直接报 `Member "startBroadcast" not found`。
同理 `vm.serializeXxx` 所在函数不能标 `view`（cheatcode 是外部调用）。
这类"凭印象写 API"的错误只能靠**真的编译一遍**发现——所以本仓库要求：合约项目必须留下可复跑的 `forge build`/`forge test` 记录。
