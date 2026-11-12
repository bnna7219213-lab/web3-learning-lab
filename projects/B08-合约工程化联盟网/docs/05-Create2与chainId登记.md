# 05 · Create2 地址派生与 chainId 绑定

> 代码：`src/Create2Factory.sol`、`test/Create2.t.sol`、`scripts/10-create2-chainid.js`（2026-11-13 全绿 7/7）
> 对应 README 知识点 4：「Create2 地址派生与 chainId 绑定（联盟链换链 ID 会导致地址全变）」。

## 1. 地址公式（EIP-1014）与三个输入

```
address = keccak256(0xff ++ factoryAddress ++ salt ++ keccak256(initCode))[12:]
```

任一输入变化 → 地址全变。链上 `computeAddress()` 与链下公式双算对账 + `staticCall` 预演 + 实部署，三重一致（脚本 ①②③）。
重复 salt 部署被拒（`AddressAlreadyUsed`）——CREATE2 天然撞地址，工厂登记防的是「误重放」而不是「地址冲突」。

## 2. 联盟链特有的坑：chainId 不在公式里，但换链地址照样全变

CREATE2 公式**不含 chainId**，直觉上「同 salt 同 initCode 换链也是同地址」——**错了**：

- `factoryAddress` 是 CREATE 派生（部署者地址 + nonce + 部署历史）
- 换链（新 chainId）= 新网络 = 工厂合约要重新部署 = **工厂地址不同**
- 公式输入之一变了 → 所有 Create2 地址全变（脚本 ⑤ 用假工厂地址演示了这一点）

**所以链 ID 必须与地址一起永久登记**：`deployments/latest.json` 里 `chainId` + `Create2Factory` + 各实例地址是一个原子记录，
换链 ID 或重新部署工厂后，所有「预计算地址」的对接文档（白名单、审计、客户合同附件）都要跟着重开。
脚本 ① 每次运行都核对「登记链 ID == 实链 ID」，漂移即 FAIL。

## 3. 对客话术

> 「地址可预测」承诺的作用域 = **单条链的生命周期内**。联盟链换链 ID / 重建创世 = 地址簿整体作废，
> 迁移方案里 Create2 预计算地址必须列为**变更项**，与合约存储迁移同级评审。

## 4. 复现

```bash
cd projects/B08-合约工程化联盟网
forge test --match-path test/Create2.t.sol -vv   # 4 条公式/负例
node scripts/10-create2-chainid.js               # 真实联盟网 7 条（含 chainId 登记核对）
```
