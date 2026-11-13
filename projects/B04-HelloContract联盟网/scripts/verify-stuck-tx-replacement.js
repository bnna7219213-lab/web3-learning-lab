#!/usr/bin/env node
// scripts/verify-stuck-tx-replacement.js —— 「卡单」处置：同 nonce 替换（带窗口校验的破坏性操作）
//
// 处置路径（B04 实测过的那条）：给卡单账户注入**最小余额**，
// 再用**同 nonce、更高 gasPrice、更低 gas** 的空交易替换它。
//
// ⚠ 必须落在窗口：  替换成本 ≤ 注入额 < 卡单成本
//    替换成本 = replaceGas × replaceGasPrice（默认 21000 × 2 = 42000 wei）
//    卡单成本 = stuckGas × stuckGasPrice（如 505440 × 1 = 505440 wei）
//    注入额太小 → 替换交易自己付不起手续费；注入额太大（比如水龙头一次打 10 B03）
//    → 卡单本身变得可执行、直接在原 nonce 入块，"看起来解锁了"其实测的根本不是替换。
//
// 用法:
//   node scripts/verify-stuck-tx-replacement.js <txHash> --inject 100000 --dry-run
//   node scripts/verify-stuck-tx-replacement.js <txHash> --inject 100000 --execute \
//        --rpc http://127.0.0.1:8551 --key 0x... --from 0xYOUR_SENDER
//
// 默认 dry-run（只算窗口 + 打印计划）；--execute 才真正发交易。
// --from 可省略（从链上 tx.from 读），--key 是卡单账户的私钥（用来签替换交易）。

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const txHash = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
if (!txHash) {
  console.error("用法: node scripts/verify-stuck-tx-replacement.js <txHash> --inject <wei> [--execute] [--rpc URL] [--key 0x..] [--from 0x..]");
  process.exit(1);
}
const EXECUTE = process.argv.includes("--execute");
const RPC = arg("rpc", "http://127.0.0.1:8551");
const KEY = arg("key", process.env.STUCK_TX_KEY || "");
const FROM = arg("from", "");
const INJECT = BigInt(arg("inject", "100000"));
const REPLACE_GAS = 21000n;
const REPLACE_GAS_PRICE = 2n;

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const stuck = await provider.getTransaction(txHash);
  if (!stuck) throw new Error(`链上找不到交易 ${txHash}`);
  const sender = (FROM || stuck.from).toLowerCase();
  const stuckCost = BigInt(stuck.gasLimit) * BigInt(stuck.gasPrice ?? stuck.maxFeePerGas ?? 0n);
  const replaceCost = REPLACE_GAS * REPLACE_GAS_PRICE;
  const nonce = stuck.nonce;

  console.log(`卡单 ${txHash}`);
  console.log(`  账户 ${sender}  nonce ${nonce}  gasPrice ${stuck.gasPrice ?? stuck.maxFeePerGas}  gas ${stuck.gasLimit}`);
  console.log(`  卡单成本 = ${stuck.gasLimit} × ${stuck.gasPrice ?? stuck.maxFeePerGas} = ${stuckCost} wei`);
  console.log(`  替换成本 = ${REPLACE_GAS} × ${REPLACE_GAS_PRICE} = ${replaceCost} wei`);
  console.log(`  注入额   = ${INJECT} wei`);

  // —— 窗口校验（README 里那个 ⚠ 前提）——
  const inWindow = INJECT >= replaceCost && INJECT < stuckCost;
  if (!inWindow) {
    console.error(`✗ 注入额不在窗口内（要求 替换成本 ${replaceCost} ≤ 注入额 < 卡单成本 ${stuckCost}）。`);
    console.error("  太小 → 替换交易付不起手续费；太大 → 卡单自己变可执行，实验会给出无效的操作指引。");
    process.exit(2);
  }
  console.log("✓ 窗口校验通过：替换成本 ≤ 注入额 < 卡单成本");

  const rec0 = await provider.getTransactionReceipt(txHash);
  const acct = await provider.getTransactionCount(sender, "latest");
  const pend = await provider.getTransactionCount(sender, "pending");
  console.log(`  当前 receipt=${rec0 ? rec0.status : "null"}  nonce latest=${acct} pending=${pend}`);
  if (rec0) {
    console.log("该交易已有回执，不是卡单，无需替换。");
    process.exit(0);
  }

  if (!EXECUTE) {
    console.log("\n[dry-run] 计划：");
    console.log(`  1) 给 ${sender} 注入 ${INJECT} wei`);
    console.log(`  2) 发替换交易: nonce=${nonce} gasPrice=${REPLACE_GAS_PRICE} gas=${REPLACE_GAS} value=0（同 nonce 更高价更省 gas）`);
    console.log("  3) 断言: 原卡单 receipt != null 且不为执行成功（或从 pending 消失）、替换交易入块 status=1、账户 nonce 前进");
    console.log("\n加 --execute 执行（需要 --key 签名替换交易）。");
    return;
  }

  if (!KEY) {
    console.error("✗ --execute 需要 --key（卡单账户私钥）来签替换交易");
    process.exit(1);
  }
  const wallet = new ethers.Wallet(KEY, provider);
  if (wallet.address.toLowerCase() !== sender) throw new Error(`--key 对应 ${wallet.address}，与卡单账户 ${sender} 不符`);

  // 1) 注入最小余额（从注入源账户或直接由 wallet 自己？注入要从外部来——用 env INJECT_KEY 或要求链上已有余额的账户）
  const injectKey = arg("inject-key", process.env.INJECT_KEY || "");
  if (injectKey) {
    const funder = new ethers.Wallet(injectKey, provider);
    const tx = await funder.sendTransaction({ to: wallet.address, value: INJECT, gasLimit: 21000n, gasPrice: 0n, type: 0 });
    await tx.wait();
    console.log(`✓ 已注入 ${INJECT} wei（来自 ${funder.address}）`);
  } else {
    const bal = await provider.getBalance(wallet.address);
    if (bal < INJECT) throw new Error(`账户余额 ${bal} < 注入额 ${INJECT}，且未给 --inject-key；请先注入`);
    console.log(`✓ 账户已有余额 ${bal} ≥ 注入额，跳过注入`);
  }

  // 2) 同 nonce 替换（legacy、更高 gasPrice、更低 gas、value=0）
  const replacement = await wallet.sendTransaction({
    to: wallet.address,
    value: 0n,
    nonce,
    gasLimit: REPLACE_GAS,
    gasPrice: REPLACE_GAS_PRICE,
    type: 0,
  });
  console.log(`替换交易已发: ${replacement.hash}（nonce ${nonce}）`);
  const rec = await replacement.wait();
  console.log(`替换交易回执: status=${rec.status} block=${rec.blockNumber} gasUsed=${rec.gasUsed}`);

  // 3) 断言
  const stuckAfter = await provider.getTransaction(txHash);
  const stuckRec = await provider.getTransactionReceipt(txHash);
  const nonceAfter = await provider.getTransactionCount(sender, "latest");
  console.log("\n结果：");
  console.log(`  原卡单: blockNumber=${stuckAfter ? stuckAfter.blockNumber : "已从池中消失"} receipt=${stuckRec ? stuckRec.status : "null"}`);
  console.log(`  账户 nonce: ${acct} → ${nonceAfter}`);
  // ethers v6 的 receipt.status 是 number（不是 bigint）；替换成立 = 替换交易入块成功
  // 且原卡单从未执行成功（receipt 缺失或 status≠1）
  const stuckExecuted = !!(stuckRec && Number(stuckRec.status) === 1);
  const replaced = Number(rec.status) === 1 && nonceAfter === Number(nonce) + 1 && !stuckExecuted;
  if (replaced) {
    console.log("✓ 替换成功：替换交易入块且 nonce 前进，原卡单被顶掉");
  } else {
    console.log("✗ 替换结果异常，请用 observe-stuck-tx.js 继续观测并人工核对");
    process.exit(1);
  }
})();
