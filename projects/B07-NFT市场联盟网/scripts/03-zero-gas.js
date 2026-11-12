// scripts/03-zero-gas.js —— 零 gas 断言：gasPrice == 0、baseFeePerGas == 0、交易确实入账
const { wallet, credential, send, provider, ok, summary, hr, cfg } = require("./lib/b07");

(async () => {
  hr("03 zero-gas assertions");
  const p = provider();
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const cred = credential(issuer);
  const A = await memberA.getAddress();
  const baseURI = cfg().INTERNAL_OSS_BASE || "http://127.0.0.1:8088/cred/";
  const ROOT = "0x" + "22".repeat(32);

  // ethers v6 的 provider 没有 getGasPrice()，直接走 JSON-RPC
  const gasPrice = BigInt(await p.send("eth_gasPrice", []));
  ok(gasPrice === 0n, `eth_gasPrice == 0 (got ${gasPrice})`);

  const block = await p.getBlock("latest");
  ok(block.baseFeePerGas === 0n, `baseFeePerGas == 0 (got ${block.baseFeePerGas})`);
  console.log(`  latest block #${block.number} gasLimit=${block.gasLimit} gasUsed=${block.gasUsed}`);

  // 零 gas 交易：显式 gasLimit（余额为 0，估算会失败）+ gasPrice 0 + legacy
  await send(cred, "setMember", [A, true]);
  const { tx, rec } = await send(cred, "mintBatch", [A, 1, baseURI, ROOT, 0, true]);
  ok(rec.status === 1, `tx mined with status=1 (hash ${rec.hash})`);
  ok(rec.gasUsed > 0n, `gasUsed > 0 (${rec.gasUsed}) - the tx really executed`);
  // ethers v6 的回执用 gasPrice 表示实际单价（没有 effectiveGasPrice 字段）
  ok(rec.gasPrice === 0n, `receipt gasPrice == 0 (got ${rec.gasPrice})`);
  const txObj = await p.getTransaction(tx.hash);
  ok(txObj.gasPrice === 0n, `tx.gasPrice == 0 (got ${txObj.gasPrice})`);
  ok(txObj.type === 0, `tx is legacy (type=${txObj.type})`);
  console.log(`  tx ${rec.hash} block=${rec.blockNumber} gasUsed=${rec.gasUsed} gasPrice=${rec.gasPrice}`);

  summary("03 zero-gas");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
