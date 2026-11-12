// scripts/06-gas-report.js —— Gas 双指标报告：区块容量占用 + 出块延迟影响
// P08 的对比表回答「省多少 gas」；B08 要回答联盟链运营的两个问题（README 验收）：
//   指标A 区块容量占用：一笔业务吞掉块 gasLimit 的多少、一个块能装几笔
//   指标B 出块延迟影响：一批业务要占几个块、等几个出块周期（QBFT 名义 5s/块）
// 口径：gasUsed 是「执行开销/区块容量占用」，不是费用（零 gas 语义校准）。
// 测量方法（P08 docs/01 §2 的坑）：每个入口都是独立交易、冷热起点一致才可比；
// view 函数也走真实交易拿 receipt.gasUsed（eth_call 不留回执）。
const fs = require("fs");
const path = require("path");
const { wallet, contract, provider, cfg, ethers, hr, PROJECT } = require("./lib/b08");

(async () => {
  hr("06 gas dual-metric report");
  const p = provider();
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const IA = await issuer.getAddress();
  const lab = contract("GasLab", issuer);
  const to = await lab.getAddress();

  // ── 基线：块 gasLimit / 出块间隔 / 单笔脚本上限 ──────────────────────────
  const latest = await p.getBlock("latest");
  const blockGasLimit = latest.gasLimit;
  const perTxCap = BigInt(cfg().PER_TX_GAS_LIMIT || 8000000);
  console.log(`  block gasLimit=${blockGasLimit}  PER_TX_GAS_LIMIT=${perTxCap}  GASLAB_N=${cfg().GASLAB_N || 64}`);

  const intervals = [];
  let prev = latest;
  for (let i = 0; i < 6; i++) {
    const b = await p.getBlock(prev.number - 1);
    intervals.push(Number(prev.timestamp) - Number(b.timestamp));
    prev = b;
  }
  const blockInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  console.log(`  出块间隔实测：${intervals.join("/")}s（均值 ${blockInterval.toFixed(1)}s）`);

  // ── 逐入口发真实交易取 gasUsed（显式 nonce——B08 踩坑见 scripts/02 注释）──
  let nonce = await p.getTransactionCount(IA);
  async function gasOf(fn, args) {
    const data = lab.interface.encodeFunctionData(fn, args);
    const tx = await issuer.sendTransaction({ to, data, gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonce++ });
    const rec = await tx.wait();
    if (rec.status !== 1) throw new Error(`${fn} tx status=0`);
    return rec.gasUsed;
  }

  const xs128 = Array.from({ length: 128 }, (_, i) => i); // 与 P08 同参数
  const groups = [
    { g: "组1 循环读 storage（64 元素）", naive: ["sumNaive", []], opt: ["sumCached", []] },
    { g: "组2 外部数组处理（128 元素）", naive: ["countNaive", [xs128]], opt: ["countCalldata", [xs128]] },
    { g: "组3 循环累加（500 轮）", naive: ["accumulateChecked", [500]], opt: ["accumulateUnchecked", [500]] },
    { g: "组4 单槽读-改-写", naive: ["creditNaive", [1]], opt: ["creditCached", [1]] },
  ];

  console.log("\n  [指标A] 区块容量占用（真实交易 gasUsed，含 21k 基础费与 calldata）");
  const rows = [];
  for (const gr of groups) {
    const gN = await gasOf(...gr.naive);
    const gO = await gasOf(...gr.opt);
    const saved = gN > gO ? gN - gO : 0n;
    rows.push({ group: gr.g, fnNaive: gr.naive[0], fnOpt: gr.opt[0], gasNaive: gN, gasOpt: gO, saved });
    console.log(
      `  ${gr.g}\n    ${gr.naive[0]}=${gN}  ${gr.opt[0]}=${gO}  省 ${saved} (${((Number(saved) * 100) / Number(gN)).toFixed(1)}%)`
    );
    console.log(
      `    容量：naive 占块 ${((Number(gN) * 100) / Number(blockGasLimit)).toExponential(2)}%` +
        `｜30M 参考块每块 ${Math.floor(Number(30000000n / gN))} 笔 vs ${Math.floor(Number(30000000n / gO))} 笔`
    );
  }

  // ── 指标B：轻/重两批各 10 笔连发，量块跨度与墙钟延迟 ─────────────────────
  console.log("\n  [指标B] 出块延迟影响（每批 10 笔连发，显式 nonce）");
  async function batch(fn, args, label) {
    const t0 = Date.now();
    const txs = [];
    for (let i = 0; i < 10; i++) {
      const data = lab.interface.encodeFunctionData(fn, args);
      txs.push(await issuer.sendTransaction({ to, data, gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonce++ }));
    }
    const recs = await Promise.all(txs.map((t) => t.wait()));
    const wall = Date.now() - t0;
    const blocks = recs.map((r) => r.blockNumber);
    const span = Math.max(...blocks) - Math.min(...blocks) + 1;
    const gasTotal = recs.reduce((a, r) => a + r.gasUsed, 0n);
    console.log(
      `  ${label}：10 笔全确认 ${wall}ms｜跨 ${span} 个块（#${Math.min(...blocks)}..#${Math.max(...blocks)}）｜合计 gasUsed=${gasTotal}`
    );
    return { label, wallMs: wall, blocksSpanned: span, gasTotal };
  }
  const heavy = await batch("accumulateChecked", [500], "重业务 accumulateChecked(500)");
  const light = await batch("creditCached", [1], "轻业务 creditCached(1)");

  // ── 容量规划：以 30M 参考块推演批量延迟（当前实配 gasLimit 近乎无界）────
  const REF = 30000000n;
  console.log("\n  [容量规划] 以 30M 参考块（公链常见量级）推演：1000 笔业务的占用块数与等待");
  for (const r of rows) {
    const blocksN = Number((1000n * r.gasNaive + REF - 1n) / REF);
    const blocksO = Number((1000n * r.gasOpt + REF - 1n) / REF);
    console.log(
      `  ${r.group}：naive ${blocksN} 块 ≈ ${(blocksN * blockInterval).toFixed(0)}s vs optimized ${blocksO} 块 ≈ ${(blocksO * blockInterval).toFixed(0)}s`
    );
  }

  const report = {
    measuredAt: new Date().toISOString(),
    chainId: Number((await p.getNetwork()).chainId),
    blockGasLimit: blockGasLimit.toString(),
    perTxScriptCap: perTxCap.toString(),
    blockIntervalSeconds: blockInterval,
    gasLabN: Number(cfg().GASLAB_N || 64),
    note: "gasUsed=执行开销/容量占用，非费用；实配 gasLimit 近乎无界（0x1fffffffffffff），容量结论以 30M 参考块推演",
    groups: rows.map((r) => ({
      ...r,
      gasNaive: r.gasNaive.toString(),
      gasOpt: r.gasOpt.toString(),
      saved: r.saved.toString(),
    })),
    batches: [heavy, light].map((b) => ({ ...b, gasTotal: b.gasTotal.toString() })),
  };
  const out = path.join(PROJECT, "deployments", "gas-report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n  报告已写入 ${out}`);
  console.log("\n06 gas dual-metric report: DONE");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
