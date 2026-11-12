# 01 · Gas 对比表：四组对照 + 一条测量方法论

> 代码：`src/GasLab.sol`、`src/StorageLayoutDemo.sol`、`test/GasLab.t.sol`、`test/StorageLayout.t.sol`
> 口径（README 零 gas 语义校准 §做对比表时的口径）：列名是 **gas 消耗（gasUsed）**，不是「费用」——
> 度量执行开销与区块容量占用；gasPrice 是否为 0 不影响这些数字。

## 1. 结论表（实测，2026-11-13，forge 1.7.1 / solc 0.8.28 / default profile）

| 组 | naive 版 | optimized 版 | naive gasUsed | optimized gasUsed | 省 | 结论 |
|----|----------|--------------|---------------|-------------------|----|------|
| 1 循环读 storage（64 元素，预热后） | `sumNaive` 每轮重读 length+元素 | `sumCached` length 与数组指针先缓存 | 33,420 | 26,947 | **6,473（19%）** | 缓存读在循环里是真收益 |
| 2 处理外部数组（128 元素） | `countNaive` 先拷进 memory | `countCalldata` 直接 calldata 索引 | 44,853 | 38,436 | **6,417（14%）** | calldata 零拷贝；数组越大差距越大（按字计费的拷贝） |
| 3 循环累加（500 轮，预热后） | `accumulateChecked` 每轮溢出检查 | `accumulateUnchecked`（先 require 证界） | 82,371 | 28,431 | **53,940（65%）** | 可证不溢出的循环用 unchecked；**必须先证界**（负例钉死） |
| 4 单次读-改-写一个槽 | `creditNaive` 内联 SLOAD+SSTORE | `creditCached` 先读进局部 | 1,007 | 1,071 | **≈0（差 64）** | 单次读写编译器已优化等价——**不是所有「套路写法」都有收益** |
| 5 打包写（3 小字段首写） | `StorageLayoutDemo.setPacked`（1 槽） | `StorageSplitDemo.setSplit`（垫片强制 3 槽） | 27,851 | 71,956 | **44,105（61%）** | 打包 = 少冷 SSTORE；冷 SSTORE 20k/槽 |

组1/3/4 必须看 `test/GasLab.t.sol` 里的预热调用再看数字——原因见 §2。

## 2. 测量方法论：先排除冷/热时序，再比实现（本项目最大的坑）

同一交易内，**槽首次访问是冷的（SLOAD 2,100 / SSTORE 20,000），之后是热的（100 / 2,900→100）**。
首版测试没预热就对账，得到「naive 167,923 vs cached 26,947」——14 万差值里绝大多数是
**naive 先跑付了冷成本、cached 后跑享受热成本**的时序伪影，不是算法差异。

修正：两版各先跑一次预热，再测——真实差距是 **6,473**（组1）。
组4 更典型：预热后两版只差 64 gas，说明「缓存读」在单次读写场景**没有收益**。

**口诀：比 gas 之前先对齐访问时序；测出来的大数字先怀疑冷/热，再怀疑算法。**

## 3. forge gas-report 的口径（两套数字怎么读）

```bash
forge test --gas-report        # 按函数聚合：min/avg/max/median/calls，跨交易
forge test -vv                 # 我们的 gasleft() 同交易差值：单笔内部对账
```

gas-report 里 `accumulateChecked 105,196` vs `accumulateUnchecked 21,553` 是**函数全成本**
（含部署交互与冷热混合）；组3 的 82,371/28,431 是**同交易预热后的循环体差值**。
两者都对，但用途不同：报告口径看「这笔业务多贵」，同交易口径看「写法差多少」。

## 4. 在零 gas 联盟链上这组数字意味着什么（B08 分支视角）

| 公链口径 | 零 gas 联盟链口径（B08） |
|----------|--------------------------|
| 省 = 省用户 ETH | 省 = **少占区块容量**：块 gasLimit 内，你的合约少吞 1 gas，同块其它交易多一分准点率 |
| 优化动机 = 费用 | 优化动机 = 53,940 gas/500 轮 × 业务调用量 = 成员分摊的**执行与运维成本** |
| 数字不变 | gasUsed 度量与 gasPrice 无关——**同一张表两个环境通用**，列名不写「费用」 |

大合约（EIP-170 24KB）与单笔 pertxgaslimit 的实测在 B08 分支做（README 边界）。

## 5. 复现

```bash
cd projects/P08-合约工程化进阶
forge test --match-path test/GasLab.t.sol -vv        # 组1–4 数字
forge test --match-path test/StorageLayout.t.sol -vv  # 组5 打包对照
forge test --gas-report                               # 函数聚合报告
```
