# 04 · 合约端 Merkle 验证 × P01 链下实现：双向互验

> 代码：`src/MerkleAirdrop.sol`、`test/Merkle.t.sol`、`scripts/08-merkle-crosscheck.js`（2026-11-13 全绿 13/13）
> 被验对象是 **P01 的真实现在**（`projects/P01-区块链认知工具箱基础/frontend/lib/merkle.js`），
> 脚本直接动态 import 它建树出证，不是复刻一份自说自话。

## 1. 「互相验证」的四个方向

| 方向 | 内容 | 实测 |
|------|------|------|
| ① 链下 → 链上 | P01 建的 root == 链上 `root()`；P01 出证包在链上 `verify()` 通过；leafHash 逐字相等 | ✅ |
| ② 链上 → 链下 | P01 `computeRootFromProof` 从链上同一证明复算 root == 链上 root | ✅ |
| ③ 功能互验 | P01 出证包 `claim()` 成功；`claimedLeaf` 防重领生效；重放领取被拒 | ✅ |
| ④ 负例同判 | 伪造金额 / 错位索引 / 篡改证明——链下 P01 与链上合约**都拒** | ✅ |

## 2. 逐字对齐的三件事（改任何一处互验就断）

1. **哈希**：sha256（不是 keccak256）——P01 用 Node `crypto.subtle`
2. **前缀**：叶子 `L|data`，内部节点 `N|leftHex+rightHex`（防二像攻击：叶子哈希冒充内部节点）
3. **位置**：按叶子索引二进制位决定兄弟左右（`idx&1==1` → 兄弟在左），与 P01 `getProof` 的 position 一一对应

工程坑：P01 的 `sha256Hex` 输出**不带 0x 前缀**，ethers 的 BytesLike **必须带**——对账/传参统一补 `0x`（脚本注释已钉死）。

## 3. 已知弱点：两边同弱才算互验

奇数层复制末尾（Bitcoin 早期做法）→ 3 份批次与「3 份 + 末尾重复」**同根**（P01 已记录，`test_p01KnownWeaknessReproduced` 在合约端复现）。
这不是实现 bug，是 v1 方案的结构弱点：**两边用同一个有弱点的方案，才能证明「互验」而不是「各验各的」**。

**生产改造方向**：`shared/evidence/lib/merkle-indexed.js`（M4 出证已在用）——叶子/内部节点绑定位置索引 + EMPTY 哨兵补齐，
消掉等价树。合约端对应改法是 `_verify` 里把 `idx`/`level` 拼进哈希输入（合约与链下必须**同步**换 v2，否则互验断裂）。

## 4. 与 shared/evidence 的衔接

出证包（root + leaf + proof + 数据原文）按 `shared/evidence/schema/evidence-package.schema.json` 组装后，
客户用 P01 同款算法即可独立复核；链上只写 root，逐份出证零上链成本——这正是联盟链批量存证的推荐形态。

## 5. 复现

```bash
cd projects/B08-合约工程化联盟网
forge test --match-path test/Merkle.t.sol -vv     # 7 条（含 4 个方向的链上单测）
node scripts/08-merkle-crosscheck.js              # 真实联盟网 13 条断言（含 claim 上链）
```
