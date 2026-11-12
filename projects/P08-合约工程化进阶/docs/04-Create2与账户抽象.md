# 04 · Create2 确定性地址与账户抽象（ERC-4337 概念）

> 代码：`src/Create2Factory.sol`、`src/AccountAbstraction.sol`
> 测试：`test/Create2.t.sol`（6 项）、`test/AccountAbstraction.t.sol`（7 项）

## 1. CREATE2：地址在部署前就能算出来（EIP-1014）

```
address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
```

三个输入（工厂地址 / salt / initCode）任一变化 → 地址全变。测试把三个输入各做了变体负例：

| 变体 | 测试 | 结果 |
|------|------|------|
| 链下预计算 vs 链上 create2 实际 | `test_precomputedMatchesOnchain` | 相等 |
| 与 forge 官方公式互证 | `test_crossCheckVmFormula`（`vm.computeCreate2Address`） | 相等 |
| 换 salt | `test_saltChangeChangesAddress` | 地址变 |
| 换构造参数（initCode 变） | `test_initCodeChangeChangesAddress` | 地址变；同 salt 重复部署被 `AddressAlreadyUsed` 拒 |
| 换工厂地址 | `test_factoryAddressChangeChangesAddress` | 地址变 |
| **部署前预充值** | `test_counterfactualAddressBeforeDeploy` | 地址无代码时先 `vm.deal`，部署后余额/代码继承 |

最后一条就是**反事实地址（counterfactual address）**——账户抽象的地基：
「先有地址，后有代码」，钱和身份可以先于账户存在。

## 2. ERC-4337 概念落地：裁剪到三件事

真实 4337 有 AltMempool / paymaster / Stake / 10+ 字段 UserOp——本项目**只落地理解账户抽象
所必需的三件事**（README 技术栈标注「概念落地」即此边界）：

1. **反事实部署**：`MiniEntryPoint.handleOp` 检测 `sender.code.length == 0` → 用 `initCode`
   按 CREATE2 落地，且 `computeSender(initCode)` 必须等于 `op.sender`
   （S3 的「initCode 决定地址」结论在这里复用；不匹配负例 `test_initCodeSenderMismatchRejected`）。
2. **验证入口在账户内**：`SmartAccount.validateOp` 是「规则可编程」的落点——
   - 单签模式：owner ECDSA（EOA 语义基线）；
   - 双因素模式：owner ECDSA + **Merkle 白名单证明**（复用 S5 思路），签名编码 = `65B ECDSA ++ abi.encode(proof[])`。
   消息域 `keccak(userOpHash ++ block.chainid)`——chainid 进哈希 = 跨链重放保护，
   与 P05 permit 的域分隔是同一手法。`userOpHash` 绑定 sender/nonce/callData（篡改必拒）。
3. **nonce 重放保护**：执行前 `nonce != op.nonce` 即拒；同笔 Op 第二次被 `test_replayRejectedByNonce` 钉死。

**与 EOA 的本质差异一句话**：EOA 的验证规则写死在协议里（secp256k1 + 21,000 gas 固定开销），
智能账户的验证规则写在合约里——可以是双因素、可以是会话密钥、可以是白名单，
这是 4337 存在的全部理由。

### 与真实 4337 的差异清单（别把本项目当实现参考）

| 本项目（概念版） | 真实 4337 |
|------------------|-----------|
| `MiniEntryPoint` 单例、无 stake/bond | EntryPoint 有 Stake 惩罚、假打包人作恶的经济约束 |
| 无 paymaster，value 直接随 Op 转 | paymaster 代付 gas，是赞助/订阅的载体 |
| 不验 gas 字段，gas 谁都不管 | UserOp 必须带完整 gas 估算，否则进不了 AltMempool |
| `validateOp` 只返回 bool | 返回 `validationData`（validAfter/validUntil/aggregator） |
| 白名单证明约定在 initCode/签名尾部 | AccountExecute / 自定义校验钩子，编码有规范 |

## 3. 复现

```bash
cd projects/P08-合约工程化进阶
forge test --match-path test/Create2.t.sol -vv              # 6 项
forge test --match-path test/AccountAbstraction.t.sol -vv    # 7 项
```
