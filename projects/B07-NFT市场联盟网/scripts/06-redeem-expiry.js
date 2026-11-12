// scripts/06-redeem-expiry.js —— 核销时延 + 到期自动回收（0 例外）
//
// 时延口径必须分清（零 gas 只省费用，不省时延）：
//   A. 核销**接口往返**（预检 + 状态回读，即商户系统看到「核销已受理」的时延）→ 目标 P95 < 300ms
//   B. 核销**链上确认**（交易进块）→ 受出块周期约束（本链 5s/块），不是接口问题
// 到期自动回收：**失效判定不依赖任何人调用**——过期凭证立刻不可转让/不可核销；
//             sweepExpired 只是把「已失效」在链上显式化并清理占用（任何人可调用）。
const { wallet, credential, send, ok, summary, hr, cfg, provider } = require("./lib/b07");

const SAMPLES = 20;
const P95_TARGET_MS = 300;

function percentile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1);
  return a[idx];
}

(async () => {
  hr("06 redeem latency + expiry reclaim (0 exception)");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const cred = credential(issuer);
  const p = provider();
  const A = await memberA.getAddress();
  const baseURI = cfg().INTERNAL_OSS_BASE || "http://127.0.0.1:8088/cred/";
  const ROOT = "0x" + "44".repeat(32);

  await send(cred, "setMember", [A, true]);

  // ---------- A. 核销接口往返时延（预检 + 状态回读） ----------
  const rpcMs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    await cred.isValid(0);
    await cred.ownerOf(0);
    await cred.userOf(0);
    rpcMs.push(Date.now() - t0);
  }
  const p95 = percentile(rpcMs, 95);
  console.log(`  A) 核销接口往返（预检+状态回读）: P50=${percentile(rpcMs, 50)}ms P95=${p95}ms max=${Math.max(...rpcMs)}ms`);
  ok(p95 < P95_TARGET_MS, `核销接口往返 P95 ${p95}ms < ${P95_TARGET_MS}ms`);

  // ---------- B. 核销交易链上确认时延（如实测，受出块周期约束） ----------
  const startId = await cred.nextId();
  await send(cred, "mintBatch", [A, 1, baseURI, ROOT, 0, true]);
  const tokenId = startId;
  const t0 = Date.now();
  const { rec } = await send(cred, "redeem", [tokenId]);
  const confirmMs = Date.now() - t0;
  const blk = await p.getBlock(rec.blockNumber);
  const prevBlk = await p.getBlock(rec.blockNumber - 1);
  console.log(`  B) 核销交易确认时延 = ${confirmMs}ms（出块周期 ${Number(blk.timestamp - prevBlk.timestamp)}s，所以下限≈一个出块周期）`);
  ok(rec.status === 1, "redeem mined OK");
  let burned = false;
  try {
    await cred.ownerOf(tokenId);
  } catch (e) {
    burned = true;
  }
  ok(burned, "redeemed credential is burned (ownerOf reverts)");

  // ---------- C. 到期自动回收：0 例外 ----------
  // 有效期必须按**链上时钟**算（本地时钟与链上 block.timestamp 有偏差，节点每 5s 才推进一个块）
  const chainNow = BigInt((await p.getBlock("latest")).timestamp);
  const shortUntil = chainNow + 30n;
  const expStart = await cred.nextId();
  await send(cred, "mintBatch", [A, 2, baseURI, ROOT, shortUntil, true]);
  const expId = expStart;
  ok((await cred.isExpired(expId)) === false, "freshly issued credential is not expired");

  // 等到过期 —— 期间**没有人调用任何函数**（只轮询链上时钟）
  let waited = 0;
  while (waited < 120000 && (await cred.isExpired(expId)) === false) {
    await new Promise((r) => setTimeout(r, 3000));
    waited += 3000;
  }
  console.log(`  waited ${waited / 1000}s for the credential to expire (chain clock)`);
  ok((await cred.isExpired(expId)) === true, "credential expired by clock alone (no one called anything)");
  ok((await cred.isValid(expId)) === false, "expired credential reports invalid");

  const credA = credential(memberA);
  let blocked = null;
  try {
    await send(credA, "transferFrom", [A, A, expId]);
  } catch (e) {
    blocked = e;
  }
  ok(!!blocked, "expired credential cannot be transferred (no exception path)");
  let redeemBlocked = null;
  try {
    await send(cred, "redeem", [expId]);
  } catch (e) {
    redeemBlocked = e;
  }
  ok(!!redeemBlocked, "expired credential cannot be redeemed");

  // 清理：任何人可调用 sweepExpired
  // 注意：await contract.method() 返回的是**交易响应**而不是函数返回值，取返回值要用 staticCall，
  //      并且要等回执（否则 sweptCount 还没更新）。
  const expectSwept = await cred.sweepExpired.staticCall([expId]);
  ok(expectSwept === 1n, `sweepExpired.staticCall says 1 credential to sweep (got ${expectSwept})`);
  await send(cred, "sweepExpired", [[expId]]);
  ok((await cred.sweptCount()) >= 1n, "swept counter recorded on chain");

  summary("06 redeem + expiry");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
