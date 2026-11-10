// node demos/merkle-proof.mjs —— 批量存证：一个 root + 逐份出证（对应前端 Demo 3）
import { buildMerkleTree, buildProofPackage, getProof, computeRootFromProof } from "../frontend/lib/merkle.js";
import { sha256Hex } from "../frontend/lib/crypto.js";

const batch = Array.from({ length: 13 }, (_, i) => `发票 NO.2026-10-${i + 1} 供应商${"ABC"[i % 3]} 金额 ${1000 * (i + 1)}`);
const tree = await buildMerkleTree(batch);

console.log(`批次份数：${batch.length}`);
console.log(`链上只需写 root：${tree.root}`);
console.log(`树形：${tree.levels.map((l) => l.length).join(" → ")}`);

const pkg = await buildProofPackage(batch, 7);
console.log(`\n第 7 份出证包：`);
console.log(`   原文：${pkg.data}`);
console.log(`   叶子：${pkg.leafHash}`);
console.log(`   证明：${pkg.proof.map((s) => `${s.position}:${s.hash.slice(0, 10)}…`).join("  ")}`);
console.log(`   验证：${pkg.verifiable}`);

const forgedRoot = await computeRootFromProof(await sha256Hex(`L|${pkg.data}｜金额改成 999999`), getProof(tree, 7));
console.log(`\n伪造后复算的根：${forgedRoot}`);
console.log(`与链上根相同：${forgedRoot === tree.root ? "（严重错误）" : "否 → 拒绝"}`);

const three = await buildMerkleTree(["A", "B", "C"]);
const four = await buildMerkleTree(["A", "B", "C", "C"]);
console.log(`\n已知弱点复现：3 份与「3 份 + 末尾重复」同根？${three.root === four.root ? "是（生产须改用索引哈希）" : "否"}`);

if (!pkg.verifiable || forgedRoot === tree.root) process.exit(1);
