#!/usr/bin/env node
// 验证「最小余额 + 同 nonce 更高 gasPrice 空交易」能否解锁被卡单占住 nonce 的账户。
//
// 为什么不复用 0x4C0535… 那笔现成卡单：它的私钥是 observe-stuck-tx.js 在内存里
// 随机生成的、故意没落盘（落盘就等于把私钥写进日志和仓库）。要替它签名只能重造，
// 那就干脆全程用可控样本 —— 顺带让"造卡单 → 注入 → 替换 → 复可用"整条链可复现。
//
// 关键设计（不想清楚就会得出假结论）：
//   卡单是 gasPrice=1 / gas=505440 / value=0，成本 505440 wei。
//   若按水龙头固定额度注入 10 B03（1e19 wei），卡单本身立刻变成可执行，
//   它会在 nonce 0 上直接入块 —— 账户"看起来解锁了"，其实是原交易跑了，
//   跟替换无关。这样得到的运维指引是错的。
//   注入额必须落在窗口内：
//     替换成本 21000×2 = 42,000  ≤  FUND  <  505,440 = 卡单成本
//   取 100,000 wei：卡单始终付不起，nonce 0 能前进就只能是替换的功劳。
//
// 跑法（服务器上，全程 127.0.0.1，不经公网）：
//   cd /opt/b03-indexer && node verify-stuck-tx-replacement.js
const { ethers } = require("ethers");

const RPC = process.env.RPC || "http://127.0.0.1:8551";
const FAUCET = process.env.FAUCET || "http://127.0.0.1:8560";
const CHAIN_ID = 19880601;
const STUCK_GAS = 505440n, STUCK_PRICE = 1n;
const REPL_gas = 21000n, REPL_PRICE = 2n;
const FUND = 100000n;

const p = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const needStuck = STUCK_GAS * STUCK_PRICE;   // 505440
const needRepl = REPL_gas * REPL_PRICE;      // 42000

async function mineOne() { const h = await p.getBlockNumber(); while ((await p.getBlockNumber()) < h + 1) await sleep(1000); }
async function waitForReceipt(hash, tries = 40) {
  for (let i = 0; i < tries; i++) { const r = await p.getTransactionReceipt(hash); if (r) return r; await sleep(2000); }
  return null;
}

(async () => {
  if (!(FUND >= needRepl && FUND < needStuck)) {
    console.log(`❌ 注入额设计错误：需 ${needRepl} ≤ FUND < ${needStuck}，实际 ${FUND}`);
    process.exit(2);
  }
  console.log(`注入窗口：替换需 ${needRepl} ≤ ${FUND} < 卡单需 ${needStuck}  ✅ 卡单将始终付不起`);

  // 1) 助手账户：走水龙头拿零钱（不动运营方私钥，也不用其额度做实验资金）
  console.log("\n=== 1) 助手账户领币 ===");
  const H = ethers.Wallet.createRandom().connect(p);
  const fr = await fetch(`${FAUCET}/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: H.address }),
  });
  const fj = await fr.json();
  if (!fr.ok) { console.log("  ❌ 领币失败：", fj.error); process.exit(2); }
  console.log(`  ${H.address.slice(0, 10)}… 领到 ${fj.amount} B03`);
  await mineOne();

  // 2) 目标账户：零余额，先造一笔卡单
  console.log("\n=== 2) 制造卡单（零余额账户发付不起的交易）===");
  const B = ethers.Wallet.createRandom().connect(p);
  const stuck = await B.sendTransaction({ to: H.address, value: 0n, gasLimit: STUCK_GAS, gasPrice: STUCK_PRICE, type: 0 });
  await sleep(3000);
  const s0 = await p.getTransaction(stuck.hash);
  const n0 = await p.getTransactionCount(B.address, "latest");
  const pd0 = await p.getTransactionCount(B.address, "pending");
  console.log(`  卡单 ${stuck.hash.slice(0, 18)}…  在池=${!!s0 && s0.blockNumber == null}  nonce ${n0}/${pd0}`);
  if (!s0 || s0.blockNumber != null || pd0 <= n0) { console.log("  ❌ 卡单未进池，前提不成立"); process.exit(3); }

  // 3) 注入窗口内余额
  console.log("\n=== 3) 注入最小余额 ===");
  await (await H.sendTransaction({ to: B.address, value: FUND, gasLimit: 21000n, gasPrice: 0, type: 0 })).wait();
  const bal = await p.getBalance(B.address);
  console.log(`  余额 ${bal} wei`);
  if (bal >= needStuck) { console.log(`  ❌ 已够卡单执行（${needStuck}），实验会被污染，中止`); process.exit(3); }
  console.log(`  ✅ 仍 < ${needStuck}，卡单依然付不起`);

  // 4) 替换：同 nonce=0、gasPrice 更高、gas 更低、value=0 的空交易
  console.log("\n=== 4) 同 nonce 替换 ===");
  const rep = await B.sendTransaction({ to: B.address, value: 0n, gasLimit: REPL_gas, gasPrice: REPL_PRICE, type: 0, nonce: 0 });
  console.log(`  替换交易 ${rep.hash.slice(0, 18)}…`);
  const rec = await waitForReceipt(rep.hash);
  const stillThere = await p.getTransaction(stuck.hash);
  const nAfter = await p.getTransactionCount(B.address, "latest");

  console.log("\n=== 结果 ===");
  console.log(`  替换交易入块 : ${rec ? `是，status=${rec.status}，块 #${rec.blockNumber}` : "否（80 秒内无 receipt）"}`);
  console.log(`  原卡单状态   : ${stillThere ? `仍可查到 blockNumber=${stillThere.blockNumber}` : "已从池中消失（被顶替）"}`);
  console.log(`  账户 nonce   : ${n0} → ${nAfter}`);

  const unlocked = !!rec && rec.status === 1 && nAfter >= 1;
  if (!unlocked) {
    console.log("\n  ❌ 替换未生效 —— 「最小余额+同 nonce 替换」这条处置动作不可用，文档必须改掉。");
    return;
  }
  console.log("\n  ✅ 替换生效：nonce 0 被替换交易占住并入块，卡单被顶掉");

  // 5) 真可用性验证：账户后续交易能正常走
  console.log("\n=== 5) 复可用验证（再发一笔新交易）===");
  const t3 = await B.sendTransaction({ to: H.address, value: 1n, gasLimit: 21000n, gasPrice: 0, type: 0 });
  const r3 = await t3.wait();
  // nonce 取交易本身或链上计数：ethers v6 的 receipt 上没有 nonce 字段，
  // 直接写 r3.nonce 会打出 undefined（脚本自己踩过，别把"报告字段错"当成"实验失败"）
  console.log(`  ✅ 新交易入块 #${r3.blockNumber}，nonce=${t3.nonce ?? await p.getTransactionCount(B.address, "latest") - 1}，status=${r3.status}`);
  const finalBal = await p.getBalance(B.address);
  console.log(`  账户最终余额 ${finalBal} wei（未被卡单吞掉）`);
  console.log("\n结论：该处置路径成立 —— 前提是注入额严格小于卡单成本，否则测的是原交易能否执行而非替换是否生效。");
})().catch((e) => { console.error("异常：", e.shortMessage || e.message); process.exit(1); });
