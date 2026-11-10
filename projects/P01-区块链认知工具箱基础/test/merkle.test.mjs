import test from "node:test";
import assert from "node:assert/strict";
import { buildMerkleTree, getProof, verifyProof, buildProofPackage } from "../frontend/lib/merkle.js";
import { sha256Hex } from "../frontend/lib/crypto.js";

// 供应链批量存证的形状：一笔链上只记一个 root，N 份单据在链下各自可证。
const receipts = Array.from({ length: 5 }, (_, i) => `发票 NO.2026-10-${13 + i} 金额 ${100 * (i + 1)}`);

test("每个叶子都能生成并验证自己的包含性证明", async () => {
  const tree = await buildMerkleTree(receipts);
  assert.equal(tree.root.length, 64);
  for (let i = 0; i < receipts.length; i++) {
    const pkg = await buildProofPackage(receipts, i);
    assert.equal(pkg.root, tree.root);
    assert.equal(pkg.verifiable, true, `第 ${i} 份单据验证失败`);
    assert.equal(pkg.proof.length, tree.levels.length - 1);
  }
});

test("换成别的单据，证明立即失效", async () => {
  const tree = await buildMerkleTree(receipts);
  const forged = await sha256Hex(`L|发票 NO.2026-10-13 金额 1000000`);
  assert.equal(await verifyProof(forged, getProof(tree, 0), tree.root), false);
});

test("证明不能挪给别的叶子用（索引绑定）", async () => {
  const tree = await buildMerkleTree(receipts);
  assert.equal(await verifyProof(tree.leafHashes[1], getProof(tree, 0), tree.root), false);
});

test("已知弱点：复制末尾叶子使 3 份与 4 份单据撞出同一个根（生产实现须用索引哈希 / Merkle Mountain Range 消除歧义）", async () => {
  const three = await buildMerkleTree(["A", "B", "C"]);
  const four = await buildMerkleTree(["A", "B", "C", "C"]);
  assert.equal(three.root, four.root);

  const one = await buildMerkleTree(["X"]);
  const two = await buildMerkleTree(["X", "X"]);
  assert.notEqual(one.root, two.root, "叶子/内部节点已用前缀做域分隔，不应同根");
  assert.deepEqual(getProof(one, 0), []);
});

test("空清单不产生根（调用方须拒绝空批次）", async () => {
  const empty = await buildMerkleTree([]);
  assert.equal(empty.root, null);
  assert.equal(empty.levels.length, 0);
});
