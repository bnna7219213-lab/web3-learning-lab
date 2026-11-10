// Merkle v2（indexed-position）性质测试：node --test test/
// 重点是那组**对抗性**断言——"证明能自洽往返"并不足以说明树是对的：
// 数据被整段丢掉时往返照样全过（lib/merkle-indexed.js 里 unhex 那个坑就是这么漏过去的）。
const test = require("node:test");
const assert = require("node:assert");
const m = require("../lib/merkle-indexed");

const sizes = [1, 2, 3, 5, 8, 17, 64, 100, 1000];

test("每个叶子的证明都能往返，且还原出的 leafIndex 与实际一致", () => {
  for (const n of sizes) {
    const items = Array.from({ length: n }, (_, i) => `tx-${i}-0x${i.toString(16)}`);
    const { root } = m.buildTree(items);
    for (let i = 0; i < n; i++) {
      const p = m.proofFor(items, i);
      const v = m.verifyProof(p.leafHash, p.proof, root);
      assert.ok(v.ok, `${n} 叶子树：第 ${i} 个证明验不过`);
      assert.strictEqual(v.leafIndex, i, `${n} 叶子树：leafIndex 还原错位`);
    }
  }
});

test("数据必须真的进哈希（同位置不同数据 → 不同叶子）", () => {
  assert.notStrictEqual(m.leafAt(0, "a").toString("hex"), m.leafAt(0, "b").toString("hex"));
});

test("顺序敏感：重排批次必须改变根", () => {
  assert.notStrictEqual(m.buildTree(["a", "b", "c"]).root, m.buildTree(["b", "a", "c"]).root);
});

test("内容敏感：改一个字节必须改变根", () => {
  assert.notStrictEqual(m.buildTree(["a", "b", "c"]).root, m.buildTree(["a", "b", "C"]).root);
});

test("承诺绑定长度，跨字段拼接不产生歧义", () => {
  assert.notStrictEqual(m.commitmentHex("ab"), m.commitmentHex("a\u0000b"));
});

test("修掉 v1 的 duplicate-last 弱点：补空不等于复制末叶", () => {
  assert.notStrictEqual(m.buildTree(["a", "b", "c"]).root, m.buildTree(["a", "b", "c", "c"]).root);
  assert.notStrictEqual(m.buildTree(["a", "b", "c"]).root, m.buildTree(["a", "b", "c", "z"]).root);
});

test("篡改兄弟哈希被拒", () => {
  const items = ["a", "b", "c", "d", "e"];
  const { root } = m.buildTree(items);
  const p = m.proofFor(items, 0);
  const bad = structuredClone(p);
  bad.proof[0].hash = m.hex(Buffer.alloc(32, 7));
  assert.strictEqual(m.verifyProof(p.leafHash, bad.proof, root).ok, false);
});

test("proof 的 level 必须连续，乱序直接抛错", () => {
  const items = ["a", "b", "c", "d", "e"];
  const p = m.proofFor(items, 0);
  assert.throws(() => m.verifyProof(p.leafHash, [...p.proof].reverse(), m.buildTree(items).root));
});

test("跨批次嫁接被拒（拿 4 条批次的证明去验 5 条批次的根）", () => {
  const root5 = m.buildTree(["a", "b", "c", "d", "e"]).root;
  const p4 = m.proofFor(["a", "b", "c", "d"], 2);
  assert.strictEqual(m.verifyProof(p4.leafHash, p4.proof, root5).ok, false);
});

test("叶子与证明错配被拒", () => {
  const items = ["a", "b", "c", "d", "e"];
  const { root } = m.buildTree(items);
  const pA = m.proofFor(items, 3);
  const pB = m.proofFor(items, 4);
  assert.strictEqual(m.verifyProof(pB.leafHash, pA.proof, root).ok, false);
});

test("空批次拒绝出证（单叶树根等于叶子本身，没有承诺强度）", () => {
  assert.throws(() => m.buildTree([]));
});

test("index 超出 uint32 直接抛错，不静默截断", () => {
  assert.throws(() => m.leafAt(2 ** 32, "x"));
  assert.throws(() => m.leafAt(-1, "x"));
});
