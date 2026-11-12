// scripts/04-finality.js —— 终结性：交易所在块在多个节点查询一致，且等待后再查仍一致
// 节点：8551 / 8552 / 8553（4 验证者 QBFT，quorum=3）
// 「5 分钟后仍一致」在本机用 FINALITY_WAIT_SECONDS 控制（默认 30s；生产口径是 300s）
const { wallet, credential, send, provider, ok, summary, hr, rpcUrl } = require("./lib/b07");

const PORTS = [8551, 8552, 8553];
const WAIT_SECONDS = Number(process.env.FINALITY_WAIT_SECONDS || 30);

(async () => {
  hr("04 finality across nodes");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const cred = credential(issuer);
  const A = await memberA.getAddress();

  const { rec } = await send(cred, "setMember", [A, true]);
  const height = rec.blockNumber;
  const hash = rec.hash;
  console.log(`  tx ${hash} included at block #${height}`);

  async function probe(tag) {
    const results = [];
    for (const port of PORTS) {
      const p = provider(port);
      try {
        const b = await p.getBlock(height);
        const h = await p.getTransaction(hash);
        results.push({ port, blockHash: b.hash, txIndex: b.transactions.findIndex((x) => x === hash), txFound: !!h });
      } catch (e) {
        results.push({ port, error: e.shortMessage || e.message });
      }
    }
    const hashes = [...new Set(results.map((r) => r.blockHash))];
    console.log(`  ${tag}:`);
    for (const r of results) {
      console.log(`    node:${r.port} blockHash=${r.blockHash ? r.blockHash.slice(0, 18) : "ERR"} txIndex=${r.txIndex} txFound=${r.txFound}${r.error ? " err=" + r.error : ""}`);
    }
    ok(hashes.length === 1 && !hashes[0].includes("undefined"), `${tag}: all nodes agree on block hash`);
    ok(results.every((r) => r.txFound), `${tag}: all nodes have the transaction`);
    return hashes[0];
  }

  const h1 = await probe("immediately after inclusion");
  console.log(`  waiting ${WAIT_SECONDS}s then re-checking ...`);
  await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));
  const h2 = await probe(`after ${WAIT_SECONDS}s`);
  ok(h1 === h2, `block hash unchanged after ${WAIT_SECONDS}s (no reorg)`);

  summary("04 finality");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
