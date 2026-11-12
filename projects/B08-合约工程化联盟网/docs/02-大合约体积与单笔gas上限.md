# 02 · 大合约体积与单笔 gas 上限实测（决定批量业务能否上线）

> 代码：`scripts/09-big-contract.js`｜实测数据：`deployments/big-contract.json`（2026-11-13）
> 配置依据：`shared/consortium-network/docs/02-零gas与交易池配置.md` 第 2/3 条——
> `contractSizeLimit: 2147483647` + `pertxgaslimit: 0`，`env/consortium.env` 的 `PER_TX_GAS_LIMIT=8000000` 是脚本层单笔预算。

## 1. 两个「大小上限」别混

| 上限 | 值 | 管什么 | 本链配置 |
|------|----|--------|----------|
| EIP-170 合约代码体积 | 24,576 字节 | 部署后 runtime code 的大小 | `contractSizeLimit: 2147483647` **解除** |
| EIP-7825 单笔交易 gas | 16,777,216 | 一笔交易最多能烧多少 gas（含部署） | `pertxgaslimit: 0` **解除** |
| 脚本层单笔预算 | 8,000,000 | `txOpts()` 显式 gasLimit（防余额估算失败的硬规矩） | `PER_TX_GAS_LIMIT=8000000` |

主网卡你的是前两个；联盟网上**唯一实际约束是脚本层的 8M**。

## 2. 实测（手写 EVM 字节码两档边界，无 solc 变量干扰）

| 档位 | runtime 体积 | 部署结果 | 部署 gasUsed | 可调用 |
|------|-------------|----------|--------------|--------|
| A（≤ EIP-170） | 24,000 字节 | ✅ 成功 | 4,954,884 | ✅ call() 返回 42 |
| B（> EIP-170） | 30,000 字节 | ✅ 成功 | 6,180,632 | ✅ call() 返回 42 |

- B 档在主网必然失败（超 EIP-170）；本链成功 = `contractSizeLimit` 生效的直接证据。
- 成本模型对上：代码存入 200 gas/字节——30,000×200 = 6,000,000 ≈ 实测 6,180,632（差额 = 21k 基础费 + initcode 执行 + 内存扩展）。

## 3. 上线门槛换算（批量业务最该看的数）

- **8M 脚本上限理论最大合约 ≈ 39,895 字节**（(8M−21k)/200）。业务合约超 ~40KB 就要提高 `PER_TX_GAS_LIMIT`。
- 部署一笔 30KB 合约 ≈ 6.18M gas = **30M 参考块的 1/5**——批量部署（工厂+多实例）时按此排块。
- 链本身不设限（pertxgaslimit=0）；若成员扩容后收紧到 EIP-7825 默认 16.7M，最大合约 ≈ 83KB，仍宽于绝大多数业务合约。

## 4. 结论

> **批量业务能否上线，卡点不是「合约太大」，而是「单笔 gas 预算」。**
> 体积上限在本链已解除；把 `PER_TX_GAS_LIMIT` 与 `contractSizeLimit` 当作**变更项**登记进部署配置，
> 换链/升级 Besu 版本时重新核对（`genesis/qbft-genesis.json.tpl` 是唯一真源）。

## 5. 复现

```bash
cd projects/B08-合约工程化联盟网
node scripts/09-big-contract.js   # 两档部署 + 边界断言 + 写 deployments/big-contract.json
```
