# 03 · 合约端 Merkle 验证与 P01 链下实现互相验证

> 代码：`src/MerkleAirdrop.sol`、`test/Merkle.t.sol`
> 链下对照：[P01 `frontend/lib/merkle.js`](../../P01-区块链认知工具箱基础/frontend/lib/merkle.js)、
> [`demos/merkle-proof.mjs`](../../P01-区块链认知工具箱基础/demos/merkle-proof.mjs)
> 验收对应 README：「合约端 Merkle 验证与 P01 链下实现互相验证通过」。

## 1. 「互相验证」= 三个逐字对齐 + 双向对账

要让两套独立实现（Node crypto vs Solidity sha256 内建）互为证人，必须先钉死三件事：

| 要素 | P01 链下 | P08 合约端 | 不一致的后果 |
|------|----------|-----------|--------------|
| 哈希 | `sha256`（不是 keccak！） | `sha256()` 内建 | 根全不同 |
| 叶子前缀 | `L\|${data}` | `string.concat("L|", data)` | 二像攻击面 + 根不同 |
| 内部节点 | `N\|${left}${right}`（**hex 字符串拼接**） | `N\|` + `_hex(left)` + `_hex(right)` | 少了 `_hex` 这步最隐蔽——bytes32 直接拼是 32 字节，链下拼的是 64 字符 ASCII |
| 位置语义 | `position: left/right`，奇数复制末尾 | 由**叶子索引的位**推导：`idx&1==1 → 兄弟在左` | 证明顺序错 → 根不等 |

P01 的 proof 带 `position` 字段；合约端不传 position，用 `index` 逐层右移取最低位还原同一顺序
（`test_wrongIndexRejected` 用 3 个错误索引证明 index 真的参与定位）。

## 2. 对账的四个方向（全部实测通过）

1. **链下 → 链上**：P01 `demos/merkle-proof.mjs` 导出的 13 份批次第 7 份出证包
   （root `9a70e0ab…` / leaf `dcda5b05…` / 4 层 proof），写死进 `test/Merkle.t.sol` 当常量。
   `verify()` 通过、`claim()` 成功、二次 claim 被 `AlreadyClaimed` 拒。
2. **链上 → 链下**：在 Solidity 里按同一算法**重 build 整棵 13 叶树**，算出的根与 P01 root
   逐字相等（`test_rebuildTreeMatchesP01Root`）——不是只验一个证明，是整个哈希管线对齐。
3. **伪造必拒**：改金额（复刻 P01 demo 的 999999 实验）、错索引、篡改 proof 中一个兄弟——
   三种负例合约端全部拒绝。
4. **弱点也对齐**：P01 记录的「3 份 vs 3+末尾重复同根」等价树弱点，在 Solidity 重算下
   **同样复现**（`test_p01KnownWeaknessReproduced`）。两边同弱才叫互相验证——
   生产改造方向（索引哈希 / Merkle Mountain Range / 固定深度+哨兵）见 P01 docs/04。

## 3. 与 OZ MerkleProof 的差异（为什么自己写）

AA 双因素白名单（S6）用的是 OZ `MerkleProof.verify`——它默认 **sorted pair**
（每层比较哈希大小决定左右），与 P01 的**索引定位**不兼容。
两套约定不能混：同一个 proof 用错库验证会稳定失败。
本项目两个库并存正是为了暴露这个差异（`SmartAccount.validateOp` 注明成员约定）。

## 4. 验证成本（gas 口径）

`claim` 全成本约 199k（含防重领写槽与事件）；纯验证 `verify` 是 view、约 4k 上下 × 树高层级
——树高 4 层 = 每层一次 sha256 预编译（各 60 gas）+ hex 编码的字符串拼接开销。
**字符串拼 hex 是本实现为「逐字对齐链下」付出的额外成本**：生产版直接用
`abi.encodePacked` 的 bytes32 拼接可省掉大部分，但那时就与 P01 不再逐字可比——
教学实现优先可对账，取舍记录在此。

## 5. 复现

```bash
# 链下向量（改 P01 算法会先挂在这里的导出，再挂 P08 测试）
node projects/P01-区块链认知工具箱基础/demos/merkle-proof.mjs

cd projects/P08-合约工程化进阶
forge test --match-path test/Merkle.t.sol -vv   # 7 项：双向对账 + 三类负例 + 弱点复现
```
