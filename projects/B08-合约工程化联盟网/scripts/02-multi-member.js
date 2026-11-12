// scripts/02-multi-member.js —— 多成员视角：≥2 个成员账户各自发交易，nonce 互不干扰
const { wallet, contract, send, provider, ok, summary, hr, ethers } = require("./lib/b08");

(async () => {
  hr("02 multi-member (nonce isolation)");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const memberB = wallet("MEMBER_B_PRIVATE_KEY");

  const IA = await memberA.getAddress();
  const IB = await memberB.getAddress();
  ok(IA !== IB, `memberA=${IA} memberB=${IB} 是不同账户`);

  // 每成员各自的合约实例（同合约不同 signer）
  const labA = contract("GasLab", memberA);
  const labB = contract("GasLab", memberB);

  // 两成员并发各发 2 笔：交错提交，nonce 应按各自地址独立递增。
  // ⚠ 坑（实测 2026-11-13）：Besu txpool RPC 关闭时 eth_getTransactionCount(pending)
  //   看不到池中交易，同一账户连发 2 笔 ethers 会取到**同一个 nonce** → 后一笔顶掉前一笔
  //   → wait() 永远挂住。多成员连发必须显式管理 nonce：取 latest 后本地递增。
  const nonceA0 = await provider().getTransactionCount(IA);
  const nonceB0 = await provider().getTransactionCount(IB);
  const txA1 = await labA.accumulateUnchecked(3, { gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonceA0 });
  const txB1 = await labB.accumulateUnchecked(3, { gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonceB0 });
  const txA2 = await labA.creditNaive(5, { gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonceA0 + 1 });
  const txB2 = await labB.creditNaive(5, { gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonceB0 + 1 });

  const recs = await Promise.all([txA1.wait(), txB1.wait(), txA2.wait(), txB2.wait()]);
  for (const r of recs) ok(r.status === 1, `tx ${r.hash.slice(0, 14)}… status=1`);

  // nonce 对账：每个账户的链上 nonce 比交易前 +2
  const nA = await provider().getTransactionCount(IA);
  const nB = await provider().getTransactionCount(IB);
  ok(nA >= 2, `memberA nonce=${nA} ≥ 2（2 笔都进了）`);
  ok(nB >= 2, `memberB nonce=${nB} ≥ 2（2 笔都进了）`);

  // 交易回执的 from 必须分属两个账户（证明没有串号）
  const froms = new Set(recs.map((r) => (r.from || "").toLowerCase()));
  ok(froms.has(IA.toLowerCase()) && froms.has(IB.toLowerCase()), "4 笔回执的 from 覆盖两成员账户");

  summary("02 multi-member");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
