// 哈希链：区块链「不可篡改」直觉的最小模型。
import { sha256Hex, nowStamp } from "./crypto.js";

const GENESIS = "0".repeat(64);

export function blockPreimage(block) {
  return `${block.index}|${block.timestamp}|${block.data}|${block.prevHash}`;
}

export async function hashOf(block) {
  return sha256Hex(blockPreimage(block));
}

export async function buildChain(items) {
  const blocks = [];
  let prevHash = GENESIS;
  for (let i = 0; i < items.length; i++) {
    const block = {
      index: i,
      timestamp: typeof items[i] === "object" ? items[i].timestamp : nowStamp(),
      data: typeof items[i] === "object" ? items[i].data : items[i],
      prevHash,
      hash: "",
    };
    block.hash = await hashOf(block);
    prevHash = block.hash;
    blocks.push(block);
  }
  return blocks;
}

/**
 * 两处独立检查：
 * 1) 自洽：区块内容重算出的 hash 是否等于区块里存的 hash
 * 2) 链接：本区块的 prevHash 是否等于上一个区块存的 hash
 * 返回第一个失效高度，就是「篡改从这里开始不再被承认」。
 */
export async function auditChain(blocks) {
  const rows = [];
  let brokenAt = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const recomputed = await hashOf(b);
    const selfOk = recomputed === b.hash;
    const linkOk = i === 0 ? b.prevHash === GENESIS : b.prevHash === blocks[i - 1].hash;
    const ok = selfOk && linkOk;
    if (!ok && brokenAt === -1) brokenAt = i;
    rows.push({ ...b, recomputed, selfOk, linkOk, ok });
  }
  return { valid: brokenAt === -1, brokenAt, rows };
}

// 攻击者改写历史：改数据后把本块及其后所有区块的 hash 全部重算。
export async function rewriteChain(blocks, targetIndex, newData) {
  const copy = blocks.map((b) => ({ ...b }));
  copy[targetIndex].data = newData;
  for (let i = targetIndex; i < copy.length; i++) {
    copy[i].hash = await hashOf(copy[i]);
    if (i + 1 < copy.length) copy[i + 1].prevHash = copy[i].hash;
  }
  return copy;
}

// 外部锚点：把「链尖」的承诺交给链外可信处（公链高度 / 公证 / 客户侧台账）。
export async function anchor(blocks) {
  const tip = blocks.at(-1);
  return sha256Hex(`anchor|${blocks.length}|${tip?.hash ?? ""}`);
}

export async function verifyAnchor(blocks, anchorValue) {
  return (await anchor(blocks)) === anchorValue;
}
