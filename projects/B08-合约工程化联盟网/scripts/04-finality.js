// scripts/04-finality.js —— 终结性断言：交易所在块的 blockHash 在 3 个节点一致，5 分钟后仍一致
// QBFT 确定性终结下「确认数」语义变了：不是等 N 个确认，而是「区块被 QBFT 证书终结」——
// 断言口径：3 节点 blockHash/状态 root 一致 = 已终结；复查仍一致 = 无重组（差异矩阵 §二.3）。
const { wallet, contract, send, provider, ok, summary, hr, cfg } = require("./lib/b08");

const WAIT_MS = Number(process.env.FINALITY_WAIT_MS || 300000); // 默认 5 分钟

(async () => {
  hr("04 finality (3-node consistency)");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const lab = contract("GasLab", issuer);

  const { tx, rec } = await send(lab, "creditNaive", [1]);
  ok(rec.status === 1, `tx ${rec.hash.slice(0, 14)}… status=1`);

  const blockNo = rec.blockNumber;
  const ports = [8551, 8552, 8553]; // 3 个验证者节点 RPC

  async function snapshot() {
    const out = [];
    for (const port of ports) {
      const p = provider(port);
      const b = await p.getBlock(blockNo);
      out.push({ port, hash: b.hash, stateRoot: b.stateRoot || null, number: b.number });
    }
    return out;
  }

  const snap1 = await snapshot();
  for (const s of snap1) ok(s.hash === snap1[0].hash, `node:${s.port} blockHash == node:${ports[0]} (${s.hash.slice(0, 18)}…)`);
  ok(snap1[0].number === blockNo, `区块号一致 (#${blockNo})`);

  console.log(`  等待 ${WAIT_MS / 1000}s 后复查（QBFT 无重组预期）…`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const snap2 = await snapshot();
  for (const s of snap2) ok(s.hash === snap1[0].hash, `复查 node:${s.port} blockHash 未变（无重组）`);
  ok(snap2.every((s) => s.hash === snap2[0].hash), "3 节点复查仍互相同");

  // 交易回执也在 3 节点一致（不只是块头）
  for (const port of ports) {
    const r = await provider(port).getTransactionReceipt(rec.hash);
    ok(r && r.status === 1 && r.blockHash === snap1[0].hash, `node:${port} 回执一致`);
  }

  summary("04 finality");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
