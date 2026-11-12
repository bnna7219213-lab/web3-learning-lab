// scripts/09-big-contract.js —— 大合约（>24KB）部署实测（README 本分支特有验收）
// EIP-170 把部署后代码限制在 24,576 字节；本链 genesis 设 contractSizeLimit=2147483647
// （shared/consortium-network/docs/02 第 3 条）——本脚本用两档手写 EVM 字节码做边界实测：
//   A. 24,000 字节（≤ EIP-170，任何链都能部署）
//   B. 30,000 字节（> EIP-170，主网会部署失败；本链必须成功）
// 同时量部署 gasUsed 对照 PER_TX_GAS_LIMIT（脚本单笔上限）与 EIP-7825（16,777,216），
// 回答 README 的「合约体积与单笔 gas 上限——决定批量业务能否上线」。
//
// initCode（手写，无 solc 依赖）：
//   PUSH2 len / DUP1 / PUSH2 offset=0x000d / PUSH1 0 / CODECOPY / PUSH1 0 / RETURN
//   = 0x61<len>8061000d60003960000f3 + runtime
//   runtime = 返回 42 的 10 字节迷你 dispatcher + STOP 填充（调用永远安全返回）
const { wallet, provider, ok, summary, hr, ethers } = require("./lib/b08");

const EIP170_LIMIT = 24576;

function buildInitCode(runtimeLen) {
  const dispatch = "602a60005260206000" + "f3"; // PUSH1 42 / PUSH1 0 / MSTORE / PUSH1 32 / PUSH1 0 / RETURN
  const runtime = dispatch + "00".repeat(runtimeLen - dispatch.length / 2);
  const lenHex = runtimeLen.toString(16).padStart(4, "0");
  return "0x61" + lenHex + "8061000d6000396000f3" + runtime;
}

(async () => {
  hr("09 big contract (>24KB) deploy");
  const p = provider();
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const IA = await issuer.getAddress();
  let nonce = await p.getTransactionCount(IA);
  const perTxCap = 8000000n;

  const cases = [
    { label: "A 24,000B（≤ EIP-170）", size: 24000 },
    { label: "B 30,000B（> EIP-170）", size: 30000 },
  ];
  const results = [];
  for (const c of cases) {
    const initCode = buildInitCode(c.size);
    const tx = await issuer.sendTransaction({ data: initCode, gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonce++ });
    const rec = await tx.wait();
    ok(rec.status === 1, `${c.label} 部署成功：tx ${rec.hash.slice(0, 14)}… status=1`);

    const code = await p.getCode(rec.contractAddress);
    const codeLen = (code.length - 2) / 2;
    ok(codeLen === c.size, `链上代码体积 = ${codeLen} 字节（EIP-170 上限 ${EIP170_LIMIT}）`);
    if (c.size > EIP170_LIMIT) {
      ok(codeLen > EIP170_LIMIT, "超过 EIP-170 的合约在本链部署成功（contractSizeLimit=2147483647 生效）");
    }

    // 部署出来的代码真的能跑：任意调用返回 42
    const ret = await p.call({ to: rec.contractAddress, data: "0x" });
    ok(BigInt(ret) === 42n, `大合约可调用：call() 返回 42（0x${ret.slice(2, 10)}…）`);

    // gas 口径：代码存入 200 gas/字节 ≈ 主要成本；对照脚本单笔上限与 EIP-7825
    ok(rec.gasUsed < perTxCap, `部署 gasUsed=${rec.gasUsed} < PER_TX_GAS_LIMIT=${perTxCap}`);
    const maxBytesAt8M = Number((perTxCap - 21000n) / 200n);
    console.log(
      `    成本口径：代码存入 200 gas/字节 → ${c.size}×200=${c.size * 200}；` +
        `单笔 8M 上限理论最大合约 ≈ ${maxBytesAt8M} 字节；EIP-7825（16.7M）在本链 pertxgaslimit=0 已解除`
    );
    results.push({ ...c, gasUsed: rec.gasUsed.toString(), codeLen, address: rec.contractAddress });
  }

  const out = {
    measuredAt: new Date().toISOString(),
    eip170Limit: EIP170_LIMIT,
    chainConfig: "contractSizeLimit=2147483647, pertxgaslimit=0（EIP-7825 上限解除）",
    perTxScriptCap: perTxCap.toString(),
    cases: results,
    conclusion: "批量业务上线门槛不是 EIP-170，而是单笔 gas 上限：8M 脚本上限 ≈ 39.9KB 合约；更大合约需提高 PER_TX_GAS_LIMIT（链本身不设限）",
  };
  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(path.join(__dirname, "..", "deployments", "big-contract.json"), JSON.stringify(out, null, 2));
  console.log(`\n  报告已写入 deployments/big-contract.json`);
  summary("09 big contract");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
