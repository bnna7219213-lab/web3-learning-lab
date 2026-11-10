// Merkle 树：批量存证 / 包含性证明的最小可用实现（教学版）。
import { sha256Hex } from "./crypto.js";

// 叶子与内部节点用不同前缀，避免「一段数据既是叶子又是内部节点」的二像攻击。
const hashLeaf = (data) => sha256Hex(`L|${data}`);
const hashPair = (left, right) => sha256Hex(`N|${left}${right}`);

/**
 * 约定：奇数节点时复制最后一个（Bitcoin 早期做法）。
 * 已知弱点：叶子数为 1 时会出现「两棵不同树同根」的等价树问题，
 * 生产实现（如固定深度 + 索引哈希 / Merkle Mountain Range）用索引消除歧义。
 */
export async function buildMerkleTree(leafDataList) {
  if (!leafDataList.length) return { levels: [], root: null, leafHashes: [] };
  const leafHashes = [];
  for (const data of leafDataList) leafHashes.push(await hashLeaf(data));

  const levels = [leafHashes.slice()];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = prev[i + 1] ?? prev[i];
      next.push(await hashPair(left, right));
    }
    levels.push(next);
  }
  return { levels, root: levels.at(-1)[0], leafHashes };
}

export function getProof(tree, index) {
  const path = [];
  let i = index;
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level];
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : (i + 1 < nodes.length ? i + 1 : i);
    path.push({ hash: nodes[siblingIndex], position: isRight ? "left" : "right" });
    i = Math.floor(i / 2);
  }
  return path;
}

export async function verifyProof(leafHash, proof, root) {
  return (await computeRootFromProof(leafHash, proof)) === root;
}

// 从叶子沿证明爬到根：合约里的 verify 就是这段循环，Gas ≈ 树高 × 一次哈希。
export async function computeRootFromProof(leafHash, proof) {
  let current = leafHash;
  for (const step of proof) {
    current =
      step.position === "left"
        ? await hashPair(step.hash, current)
        : await hashPair(current, step.hash);
  }
  return current;
}

export async function buildProofPackage(leafDataList, index) {
  const tree = await buildMerkleTree(leafDataList);
  const leafHash = tree.leafHashes[index];
  const proof = getProof(tree, index);
  return {
    index,
    data: leafDataList[index],
    leafHash,
    root: tree.root,
    proof,
    total: leafDataList.length,
    verifiable: await verifyProof(leafHash, proof, tree.root),
  };
}
