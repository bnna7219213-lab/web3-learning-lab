// Merkle 树 v2：indexed-position 变体（M4 出证用）
//
// 为什么不用 v1 的 duplicate-last：
//   P01 的实验证明，"奇数叶子就复制最后一个"会让**不同规模的批次算出同一棵树的等价结构**——
//   攻击者拿到 [A,B,C,C] 的证明后，可以声称这是 4 条记录的批次，或把最后一对换成别的组合，
//   树根不变。出证场景里这等于"一张证明可以冒充另一批数据"，是致命的。
//
// v2 的两处改动：
//   1) 叶子与内部节点都绑定**位置**（index / level+index），换位置就换哈希；
//   2) 奇数叶子用固定的 EMPTY 哨兵补齐，而不是复制最后一个真实叶子。
// 另外保留 v1 的域分隔前缀（L / N），防"叶子哈希被当成内部节点"的二阶原像。
//
// 零依赖：只用 node:crypto。出证是要给客户复核的，少一个依赖就少一个客户装不出来的理由。
const crypto = require("node:crypto");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();
const u32 = (n) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`index 超出 uint32 范围：${n}`);
  const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b;
};
const u8 = (n) => Buffer.from([n & 0xff]);

const PREFIX_LEAF = Buffer.from("L", "utf8");
const PREFIX_NODE = Buffer.from("N", "utf8");
const PREFIX_COMMIT = Buffer.from("C", "utf8");
// 补齐用的空叶子：与任何真实叶子都不可能相同（真实叶子的 index 位不会配上这个域前缀）
const EMPTY_LEAF = sha256(Buffer.concat([PREFIX_LEAF, Buffer.from("empty", "utf8")]));

const hex = (b) => "0x" + b.toString("hex");
const unhex = (s) => Buffer.from(String(s).replace(/^0x/, ""), "hex");

/// 数据 → 承诺（commitment）。返回 Buffer，内部一律用 Buffer 传递。
/// 坑记录：早先这里返回 hex 字符串，而 leafAt 又对它调 unhex()——unhex 走的是
/// String(buffer)，UTF-8 解码遇到非法字节序列全变成 U+FFFD，再 Buffer.from(…,'hex')
/// 就把这些非 16 进制字符**全部丢掉**。结果是叶子只哈希了位置、完全没哈希数据，
/// ['a','b','c'] 和 ['b','a','c'] 算出同一个根。证明依然能自洽往返，所以只有
/// "重排批次必须改根"这条对抗性测试才抓得到。出证的根若与数据无关，整棵树就是废的。
function commitment(data) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return sha256(Buffer.concat([PREFIX_COMMIT, u32(raw.length), raw])); // 长度入哈希：防跨边界拼接歧义
}
const commitmentHex = (data) => hex(commitment(data));

/// 叶子 = H("L" ‖ index ‖ commit)。index 参与哈希，所以同一条数据放在不同位置指纹不同。
function leafAt(index, data) {
  return sha256(Buffer.concat([PREFIX_LEAF, u32(index), commitment(data)]));
}

function nodeHash(level, index, left, right) {
  return sha256(Buffer.concat([PREFIX_NODE, u8(level), u32(index), left, right]));
}

/// 建树。返回 { root, levels }，levels[0] 是叶子层，便于出证时直接取兄弟。
function buildTree(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("空批次不出证：单叶树根等于叶子本身，等于没有承诺强度");
  let level = items.map((d, i) => leafAt(i, d));
  const levels = [level.map(hex)];
  let lvl = 0;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      // 关键差异：奇数右侧补 EMPTY_LEAF，不复制 level[i]
      const right = i + 1 < level.length ? level[i + 1] : EMPTY_LEAF;
      next.push(nodeHash(lvl, i / 2, left, right));
    }
    level = next;
    lvl += 1;
    levels.push(level.map(hex));
  }
  return { root: hex(level[0]), levels, depth: lvl };
}

/// 出第 index 个叶子的证明。
function proofFor(items, index) {
  const { root, levels } = buildTree(items);
  const proof = [];
  let idx = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const row = levels[lvl];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = sibIdx < row.length ? unhex(row[sibIdx]) : EMPTY_LEAF;
    proof.push({
      hash: sibIdx < row.length ? row[sibIdx] : hex(EMPTY_LEAF),
      position: isRight ? "left" : "right",
      level: lvl,
      siblingIndex: sibIdx < row.length ? sibIdx : null,
    });
    idx = Math.floor(idx / 2);
  }
  return { root, proof, index, leafHash: levels[0][index], leafCount: items.length };
}

/// 验证明：从叶子往上重算，比对根。不信任传入的 root，只信任"根被锚定在链上"这件事。
function verifyProof(leafHashHex, proof, expectedRoot) {
  if (!Array.isArray(proof)) throw new Error("proof 必须是数组");
  proof.forEach((step, i) => {
    if (step.level !== i) throw new Error(`proof level 不连续：第 ${i} 步写着 level=${step.level}`);
    if (step.position !== "left" && step.position !== "right") throw new Error(`position 非法：${step.position}`);
  });

  // 先从路径还原叶子下标。第 L 层的 position 说的是"兄弟在哪边"，
  // 兄弟在左 ⇒ 我们在右 ⇒ 该层下标为奇数 ⇒ index 的第 L 个二进制位是 1。
  // 注意是**低位在前**（L0 是 bit0）——写成 pos*2+bit 会把下标按位反转，验不过。
  let leafIndex = 0;
  for (const step of proof) {
    // 用 2**level 而不是 1<<level：位运算在 JS 里是 32 位有符号，深树会翻负
    if (step.position === "left") leafIndex += 2 ** step.level;
  }

  let cur = unhex(leafHashHex);
  for (const step of proof) {
    const q = Math.floor(leafIndex / 2 ** step.level); // 本层我们所在的槽位
    const isRightNode = q % 2 === 1;
    const sib = unhex(step.hash);
    const left = isRightNode ? sib : cur;
    const right = isRightNode ? cur : sib;
    cur = nodeHash(step.level, Math.floor(q / 2), left, right);
  }
  const root = hex(cur);
  return { ok: root === expectedRoot, recomputedRoot: root, leafIndex };
}

module.exports = { commitment, commitmentHex, leafAt, buildTree, proofFor, verifyProof, EMPTY_LEAF, hex, unhex };
