// scripts/07-merkle-proof.js —— 内网对象存储 + 哈希锚定：链上验 P01 出证结构的 Merkle 证明
//
// 闭环：元数据 JSON → 上传到内网对象存储（本地 kubo，数据不出内网）
//       → 用 **shared/evidence/lib/merkle-indexed.js（P01 出证库原实现）** 算根与证明
//       → 根锚定在链上（mintBatch 的 merkleRoot）
//       → 链上 verifyProof 重算根并比对（合约里是同构的 sha256 + 域分隔 + 位置绑定实现）
//       → 篡改叶子 → 链上拒绝
const fs = require("fs");
const path = require("path");
const { wallet, credential, send, ok, summary, hr, cfg, REPO } = require("./lib/b07");

const merkle = require(path.join(REPO, "shared", "evidence", "lib", "merkle-indexed.js"));

const N = 16; // 证明用的批大小（1000 份那批见 05，根的计算路径完全相同）
const GATEWAYS = ["http://127.0.0.1:8088", "http://127.0.0.1:8080"];
const API = "http://127.0.0.1:5001";

// kubo 的 MFS files/write 在这个版本上行为异常（multipart 与裸 body 都失败），
// 改用 `api/v0/add` + multipart 多文件 + wrap-with-directory：
//   - 多个 part 一次提交 → kubo 返回 **NDJSON**（每行一个对象），最后一行是包装目录
//   - 目录里的文件名 = part 的 filename → tokenURI 可以按 "<id>.json" 直接取
async function ipfsAddDir(files) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new Blob([f.body], { type: "application/json" }), f.name);
  const r = await fetch(`${API}/api/v0/add?wrap-with-directory=true&pin=true`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`add -> ${r.status} ${(await r.text()).slice(0, 160)}`);
  const lines = (await r.text()).trim().split(/\r?\n/).filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  return last.Hash;
}

(async () => {
  hr("07 internal OSS metadata + on-chain Merkle proof (P01 evidence structure)");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const cred = credential(issuer);
  const A = await memberA.getAddress();

  // 1) 生成元数据（内网凭证 JSON）
  const items = [];
  for (let i = 0; i < N; i++) {
    items.push(
      Buffer.from(
        JSON.stringify({
          id: i,
          holder: A,
          kind: "lab-credential",
          issuedAt: Math.floor(Date.now() / 1000),
          note: `B07 metadata #${i} (data stays in intranet)`,
        })
      )
    );
  }

  // 2) 上传到内网对象存储（kubo，本机 = 内网）
  const cid = await ipfsAddDir(items.map((b, i) => ({ name: `${i}.json`, body: b })));
  console.log(`  uploaded ${N} metadata files to intranet OSS, dir CID = ${cid}`);
  let gateway = null;
  for (const g of GATEWAYS) {
    const probe = await fetch(`${g}/ipfs/${cid}/0.json`).catch(() => null);
    if (probe && probe.ok) {
      gateway = g;
      break;
    }
  }
  ok(!!gateway, `metadata reachable via intranet gateway (${gateway || "none"})`);
  if (gateway) {
    const back = await (await fetch(`${gateway}/ipfs/${cid}/0.json`)).text();
    ok(back === items[0].toString(), "gateway returns the exact bytes we hashed");
  }

  // 3) 用 P01 出证库算根与证明
  const tree = merkle.buildTree(items);
  const proofInfo = merkle.proofFor(items, 5);
  console.log(`  merkle root = ${tree.root}`);
  console.log(`  leaf#5      = ${proofInfo.leafHash}`);
  console.log(`  proof steps = ${proofInfo.proof.length}`);

  // 4) 根锚定到链上
  const baseURI = `${gateway}/ipfs/${cid}/`;
  await send(cred, "setMember", [A, true]);
  const startId = await cred.nextId();
  await send(cred, "mintBatch", [A, N, baseURI, tree.root, 0, true]);
  const tokenId = startId + 5n;
  const anchored = await cred.merkleRootOf(tokenId);
  ok(anchored === tree.root, "merkle root anchored on chain matches the P01 library root");
  console.log(`  tokenURI(#${tokenId}) = ${await cred.tokenURI(tokenId)}`);

  // 5) 链上验证明（把 P01 的 proof 结构翻译成合约的 ProofStep）
  const steps = proofInfo.proof.map((s) => ({
    sibling: s.hash,
    level: s.level,
    siblingOnLeft: s.position === "left",
  }));
  const [okRes, recomputed] = await cred.verifyProof(tokenId, proofInfo.leafHash, steps);
  ok(okRes === true, "on-chain verifyProof accepts the P01-generated proof");
  ok(recomputed === tree.root, "recomputed root equals the anchored root");

  // 6) 篡改叶子 → 链上拒绝
  const tampered = "0x" + "de".repeat(32);
  const [okBad] = await cred.verifyProof(tokenId, tampered, steps);
  ok(okBad === false, "on-chain verifyProof rejects a tampered leaf");

  // 7) 位置绑定：用 index5 的**证明**去验 index6 的**叶子** → 必须失败
  //    （P01 出证库 v2 的核心性质：换位置就换哈希，一张证明不能冒充另一条记录）
  const leaf6 = merkle.proofFor(items, 6).leafHash;
  const [okSwap] = await cred.verifyProof(tokenId + 1n, leaf6, steps);
  ok(okSwap === false, "proof for index 5 cannot verify index 6's leaf (position binding)");

  summary("07 merkle-proof");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
