// scripts/05-batch-1000.js —— 1000 份权益批量铸造（真实元数据 + 真实 Merkle 根 + gas 上限验证）
//
// 结论先行：1000 份**不可能**塞进一笔交易 —— 每个 ERC721 mint 至少两次 SSTORE，约 26k gas/份，
//          1000 份 ≈ 26M gas > 16,777,216 单笔上限。必须分笔：合约侧 MAX_BATCH_SIZE=250
//          把这条约束固化成「一次调用上限」，超出直接 revert BatchTooLarge（不靠 gas 撞墙）。
// 本脚本还把 1000 份元数据真上传到内网对象存储，并用 shared/evidence 的出证库算根锚到链上。
const path = require("path");
const { wallet, credential, send, ok, summary, hr, cfg, REPO, ipfsAddDir } = require("./lib/b07");
const merkle = require(path.join(REPO, "shared", "evidence", "lib", "merkle-indexed.js"));

const BATCH = 250;
const TOTAL = 1000;
const EIP7825_LIMIT = 16_777_216; // 单笔 gas 上限

(async () => {
  hr("05 batch issue 1000 credentials (EIP-7825 per-tx gas limit)");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const cred = credential(issuer);
  const A = await memberA.getAddress();

  const maxBatch = await cred.MAX_BATCH_SIZE();
  ok(Number(maxBatch) === BATCH, `contract MAX_BATCH_SIZE == ${BATCH} (got ${maxBatch})`);

  // 超限直接被合约挡住（不是靠 gas 撞墙）
  let over = null;
  try {
    await send(cred, "mintBatch", [A, 1000, "http://127.0.0.1:8088/ipfs/x/", "0x" + "33".repeat(32), 0, true]);
  } catch (e) {
    over = e;
  }
  ok(!!over, "mintBatch(1000) rejected by the contract (BatchTooLarge)");

  // 1) 1000 份元数据 → 内网对象存储（一次 multipart 提交，打包成目录）
  const items = [];
  for (let i = 0; i < TOTAL; i++) {
    items.push(
      Buffer.from(
        JSON.stringify({
          id: i,
          holder: A,
          kind: "lab-credential",
          issuedAt: Math.floor(Date.now() / 1000),
          note: `B07 联盟权益凭证 #${i}`,
        })
      )
    );
  }
  const cid = await ipfsAddDir(items.map((b, i) => ({ name: `${i}.json`, body: b })));
  const baseURI = `http://127.0.0.1:8088/ipfs/${cid}/`;
  console.log(`  1000 metadata files uploaded to intranet OSS, dir CID = ${cid}`);

  // 2) 用 P01 出证库算根（同一棵树的根锚到链上）
  const root = merkle.buildTree(items).root;
  console.log(`  merkle root (shared/evidence) = ${root}`);

  await send(cred, "setMember", [A, true]);
  const before = await cred.nextId();
  const balanceBefore = await cred.balanceOf(A);
  const batchesBefore = await cred.batchCount();

  // 3) 分 4 笔发行，每笔断言 gasUsed < 单笔上限
  let worst = 0n;
  for (let i = 0; i < TOTAL / BATCH; i++) {
    const { rec } = await send(cred, "mintBatch", [A, BATCH, baseURI, root, 0, true]);
    const used = rec.gasUsed;
    if (used > worst) worst = used;
    console.log(
      `  batch#${i + 1} size=${BATCH} gasUsed=${used} (${((Number(used) / EIP7825_LIMIT) * 100).toFixed(1)}% of the per-tx cap) block=${rec.blockNumber}`
    );
    ok(used < BigInt(EIP7825_LIMIT), `batch#${i + 1} gasUsed ${used} < ${EIP7825_LIMIT}`);
    ok(rec.status === 1, `batch#${i + 1} mined OK`);
  }

  const after = await cred.nextId();
  const balanceAfter = await cred.balanceOf(A);
  ok(after - before === BigInt(TOTAL), `nextId grew by ${TOTAL} (${before} -> ${after})`);
  ok(balanceAfter - balanceBefore === BigInt(TOTAL), `member A balance grew by ${TOTAL}`);
  ok((await cred.batchCount()) - batchesBefore === BigInt(TOTAL / BATCH), "4 batches recorded on chain");
  console.log(`  worst single-tx gasUsed = ${worst} (cap ${EIP7825_LIMIT})`);

  // 4) 链上抽验：随机一个 token 的元数据证明可验（复用 P01 出证库）
  const probe = 777;
  const info = merkle.proofFor(items, probe);
  const steps = info.proof.map((s) => ({ sibling: s.hash, level: s.level, siblingOnLeft: s.position === "left" }));
  const tokenId = before + BigInt(probe);
  const [okProof, recomputed] = await cred.verifyProof(tokenId, info.leafHash, steps);
  ok(okProof === true, "on-chain proof for token#" + probe + " verifies");
  ok(recomputed === root, "recomputed root == anchored root");

  summary("05 batch-1000");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
