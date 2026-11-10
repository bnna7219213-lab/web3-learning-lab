// 区块：Merkle root + 哈希链接 + 两种共识（PoW 搜索 nonce / PoS 轮值出块），用于对比「写账本为什么贵」。
import { sha256Hex } from "./crypto.js";
import { txId } from "./tx.js";

const hashLeaf = (id) => sha256Hex(`L|${id}`);
const hashPair = (l, r) => sha256Hex(`N|${l}${r}`);

// 与 P01 同一套做法（域分隔 + 复制末尾），已知等价树弱点在 P01 单测里已固化；
// 这里保留同样的取舍，是为了让「链上只存 32 字节 root」这件事在两个项目里可对账。
export async function merkleRoot(ids) {
  if (!ids.length) return null;
  let level = [];
  for (const id of ids) level.push(await hashLeaf(id));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hashPair(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}

export function blockPreimage(block) {
  return [
    "mini-block-v1",
    block.index,
    block.timestamp,
    block.prevHash,
    block.merkleRoot ?? "empty",
    block.consensus,
    block.difficulty,
    block.proposer,
    block.nonce,
    // 创世余额表也进哈希：否则「偷偷改初始有钱人」不会被任何校验发现
    block.allocations ? JSON.stringify(block.allocations) : "",
  ].join("|");
}

export async function computeBlockHash(block) {
  return sha256Hex(blockPreimage(block));
}

export const meetsTarget = (hash, difficulty) => hash.startsWith("0".repeat(difficulty));

// PoS：按高度轮值指定出块人。 Rotation 是「谁是记账人」的答案，不需要挖矿。
export function proposerFor(validatorSet, height) {
  if (!validatorSet?.length) return null;
  return validatorSet[height % validatorSet.length];
}

export async function createBlock({
  index,
  prevHash,
  txs = [],
  proposer,
  consensus = "pow",
  difficulty = 0,
  timestamp = Date.now(),
  nonce = 0,
}) {
  const ids = [];
  for (const tx of txs) ids.push(await txId(tx));
  return {
    index,
    timestamp,
    prevHash,
    txs,
    txIds: ids,
    merkleRoot: await merkleRoot(ids),
    consensus,
    difficulty,
    proposer,
    nonce,
    hash: "",
  };
}

/**
 * 出块。pow：暴力搜 nonce（难度 = 前导 0 个数）；pos：必须轮到自己，nonce 恒为 0。
 * 返回 null 表示「不是你的轮次」——这就是轮值共识的强制点。
 */
export async function sealBlock(params, { validatorSet = [], maxAttempts = 4_000_000 } = {}) {
  if (params.consensus === "pos") {
    const expected = proposerFor(validatorSet, params.index);
    if (expected && expected !== params.proposer) return null;
    const block = await createBlock({ ...params, nonce: 0, difficulty: 0 });
    block.hash = await computeBlockHash(block);
    return block;
  }
  const difficulty = params.difficulty ?? 2;
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const block = await createBlock({ ...params, nonce, difficulty });
    const hash = await computeBlockHash(block);
    if (meetsTarget(hash, difficulty)) {
      block.hash = hash;
      return { ...block, attempts: nonce + 1 };
    }
  }
  return null;
}

export async function createGenesis(proposer, consensus = "pow", difficulty = 2, allocations = []) {
  const block = await createBlock({
    index: 0,
    prevHash: "0".repeat(64),
    txs: [],
    proposer,
    consensus,
    difficulty,
    timestamp: 0,
  });
  block.allocations = allocations;
  block.hash = await computeBlockHash(block);
  return block;
}

/**
 * 区块自洽检查：存的 hash 与重算一致、merkle 与交易列表一致、共识规则满足。
 * 注意：这里不检查 prevHash 是否接得上（那是 chain.js 的职责），保持单一职责便于测试。
 */
export async function validateBlock(block, { validatorSet = [] } = {}) {
  const recomputedIds = [];
  for (const tx of block.txs) recomputedIds.push(await txId(tx));
  const sortedSame =
    recomputedIds.length === block.txIds.length && recomputedIds.every((id, i) => id === block.txIds[i]);
  if (!sortedSame) return { ok: false, reason: "txIds 与交易内容不一致" };

  const root = await merkleRoot(recomputedIds);
  if (root !== block.merkleRoot) return { ok: false, reason: "merkleRoot 与交易不符" };

  const hash = await computeBlockHash(block);
  if (hash !== block.hash) return { ok: false, reason: "区块 hash 与内容不符（被改过）" };

  // 创世块豁免难度检查：真实链的 genesis 也是「带外约定」而非挖出来的
  if (block.consensus === "pow" && block.index > 0 && !meetsTarget(block.hash, block.difficulty)) {
    return { ok: false, reason: `工作量不达标（难度 ${block.difficulty}）` };
  }
  if (block.consensus === "pos") {
    const expected = proposerFor(validatorSet, block.index);
    if (expected && expected !== block.proposer) {
      return { ok: false, reason: `轮值不匹配：应为 ${expected?.slice(0, 10)}，实际 ${block.proposer?.slice(0, 10)}` };
    }
  }
  return { ok: true, reason: "" };
}
