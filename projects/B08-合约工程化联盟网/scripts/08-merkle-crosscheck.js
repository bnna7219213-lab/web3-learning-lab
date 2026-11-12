// scripts/08-merkle-crosscheck.js —— 合约端 Merkle 验证 × P01 链下实现双向互验（README 本分支特有验收）
// 不是重写一遍算法，而是**直接加载 P01 的 frontend/lib/merkle.js**（真实被验对象）：
//   正向：P01 建树出证 → 链上 verify() 必须接受，root/leafHash 必须逐字相等
//   反向：P01 computeRootFromProof 从链上同一证明复算 root → 必须等于链上 root
//   负例：伪造数据 / 错位索引 / 篡改证明 → 链上拒绝；claim 重放 → AlreadyClaimed
// 口径：sha256 + L|/N| 前缀 + 奇数复制末尾（两边同弱才算互验，见 MerkleAirdrop.sol 注释）。
const path = require("path");
const { pathToFileURL } = require("url");
const { wallet, contract, provider, txOpts, ok, summary, hr, ethers, PROJECT, REPO } = require("./lib/b08");

(async () => {
  hr("08 merkle cross-check (P01 off-chain × on-chain)");

  // ── 加载 P01 真实链下实现（ESM，从 CommonJS 动态 import）──────────────────
  const p01lib = path.join(REPO, "projects", "P01-区块链认知工具箱基础", "frontend", "lib", "merkle.js");
  const { buildMerkleTree, getProof, computeRootFromProof, buildProofPackage } = await import(pathToFileURL(p01lib).href);
  ok(true, "P01 frontend/lib/merkle.js 已加载（被验对象是真实现在，非复刻）");

  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const drop = contract("MerkleAirdrop", provider());
  const dropAsA = contract("MerkleAirdrop", memberA);

  // 与 P01 demos/merkle-proof.mjs 完全相同的 13 份批次
  const batch = Array.from({ length: 13 }, (_, i) => `发票 NO.2026-10-${i + 1} 供应商${"ABC"[i % 3]} 金额 ${1000 * (i + 1)}`);
  const tree = await buildMerkleTree(batch);

  // ── ① 双向对账：P01 root == 链上 root ─────────────────────────────────────
  // P01 的 sha256Hex 输出**不带 0x 前缀**；ethers BytesLike 必须带——对账/传参统一补 0x
  const chainRoot = await drop.root();
  ok("0x" + tree.root === chainRoot.toLowerCase(), `P01 root == 链上 root（${tree.root.slice(0, 18)}…）`);

  // ── ② P01 出证包（第 7 份）在链上 verify 通过 ─────────────────────────────
  const pkg = await buildProofPackage(batch, 7);
  const proof = pkg.proof.map((s) => "0x" + s.hash); // 合约按 index 位推导左右，只需兄弟哈希序列
  ok(pkg.verifiable, "P01 链下自验通过（出证包 verifiable=true）");
  ok((await drop.verify(pkg.data, proof, 7)) === true, "P01 证明在链上 verify() 通过");
  ok((await drop.leafHash(pkg.data)).toLowerCase() === "0x" + pkg.leafHash, "链上 leafHash == P01 leafHash（sha256+L| 逐字对齐）");

  // ── ③ 反向互验：P01 从同一证明复算 root == 链上 root ─────────────────────
  const recomputed = await computeRootFromProof(pkg.leafHash, pkg.proof);
  ok("0x" + recomputed === chainRoot.toLowerCase(), "P01 computeRootFromProof 复算 root == 链上 root（反向）");

  // ── ④ claim 上链 + 重放拒绝（挑一个未领取的叶子，脚本可重复执行）──────────
  let claimIdx = -1;
  for (let i = 0; i < batch.length; i++) {
    if (!(await drop.claimedLeaf("0x" + tree.leafHashes[i]))) {
      claimIdx = i;
      break;
    }
  }
  ok(claimIdx >= 0 || (await drop.claimedLeaf("0x" + tree.leafHashes[7])), "存在可领取叶子或第 7 份已在前次运行领取");
  if (claimIdx >= 0) {
    const p = await buildProofPackage(batch, claimIdx);
    const proofP = p.proof.map((s) => "0x" + s.hash);
    const rec = await (await dropAsA.claim(p.data, proofP, claimIdx, txOpts())).wait();
    ok(rec.status === 1, `memberA 领取第 ${claimIdx} 份：tx ${rec.hash.slice(0, 14)}… status=1`);
    ok(await drop.claimedLeaf("0x" + p.leafHash), "领取后 claimedLeaf 标记生效（防重领的链上状态）");
    try {
      const tx2 = await dropAsA.claim(p.data, proofP, claimIdx, { ...txOpts(), gasLimit: 200000 });
      const rec2 = await tx2.wait();
      ok(rec2.status === 0, "重放领取 status=0 进块（revert 进块=可审计）");
    } catch (e) {
      ok(true, `重放领取被拒：${(e.shortMessage || e.message).slice(0, 60)}`);
    }
  }

  // ── ⑤ 负例三连：伪造数据 / 错位索引 / 篡改证明 ────────────────────────────
  const forged = "发票 NO.2026-10-8 供应商B 金额 999999";
  ok((await drop.verify(forged, proof, 7)) === false, "伪造金额被拒（数据拒）");
  ok((await drop.verify(pkg.data, proof, 6)) === false, "错位索引被拒（位置参与推导）");
  const tampered = proof.slice();
  tampered[2] = ethers.ZeroHash;
  ok((await drop.verify(pkg.data, tampered, 7)) === false, "篡改证明被拒");

  summary("08 merkle cross-check");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
