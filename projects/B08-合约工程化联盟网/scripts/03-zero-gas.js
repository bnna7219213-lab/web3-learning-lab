// scripts/03-zero-gas.js —— 零 gas 断言：gasPrice == 0、baseFeePerGas == 0、交易确实入账
const { wallet, contract, send, provider, ok, summary, hr } = require("./lib/b08");

(async () => {
  hr("03 zero-gas assertions");
  const p = provider();
  const issuer = wallet("ISSUER_PRIVATE_KEY");

  const gasPrice = BigInt(await p.send("eth_gasPrice", []));
  ok(gasPrice === 0n, `eth_gasPrice == 0 (got ${gasPrice})`);

  const block = await p.getBlock("latest");
  ok(block.baseFeePerGas === 0n, `baseFeePerGas == 0 (got ${block.baseFeePerGas})`);
  console.log(`  latest block #${block.number} gasLimit=${block.gasLimit} gasUsed=${block.gasUsed}`);

  // 零 gas 交易：显式 gasLimit（余额为 0 估算会失败）+ gasPrice 0 + legacy
  const lab = contract("GasLab", issuer);
  const { tx, rec } = await send(lab, "creditNaive", [1]);
  ok(rec.status === 1, `tx mined with status=1 (hash ${rec.hash})`);
  ok(rec.gasUsed > 0n, `gasUsed > 0 (${rec.gasUsed}) - 交易真的执行了`);
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
