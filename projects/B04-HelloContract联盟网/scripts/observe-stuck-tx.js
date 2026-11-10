#!/usr/bin/env node
// 受控实验：证明"付不起但已进池"的交易在**无人干预**下是否一直留在交易池。
//
// 为什么需要这个脚本：B04 README 原来写"不会自己消失，重启节点才清出交易池"，
// 并称之为"运维事实"。但它只有"重启前后各查一次"的观测——那个设计证不了因果：
// 交易也可能被节点按 TTL / 池上限自行丢弃，或被同 nonce 的后续交易替换掉。
// 要归因给重启，必须先证明**不重启时它还在**，重启才是唯一的自变量。
// 所以本脚本只跑观察期（阶段 1），重启由人工另行授权（阶段 2）。
//
// 跑法（在服务器上，走 127.0.0.1，不经公网）：
//   node observe-stuck-tx.js --minutes 15 --interval 60
// 依赖 ethers（B03 索引器目录里已有）：
//   cd /opt/b03-indexer && node /path/observe-stuck-tx.js
//
// 不用 txpool_content 的原因：Besu 只有一个 HTTP RPC 端口，而它被 nginx 公网反代，
// 开 txpool 等于把全链待处理交易（地址/nonce/金额）暴露出去。改用三个等效信号：
//   tx 非 null 且 blockNumber==null  → 在池中未入块
//   pending nonce > latest nonce     → 该账户确有排队交易
//   getBlock("pending")              → 待处理块存在
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

// 只走本机：这个实验会产生一笔永久无法执行的交易，不该让公网路径参与
const RPC = process.env.RPC || "http://127.0.0.1:8551";
const CHAIN_ID = 19880601;
const MINUTES = Number((process.argv.find((a, i) => process.argv[i - 1] === "--minutes") || 15));
const INTERVAL = Number((process.argv.find((a, i) => process.argv[i - 1] === "--interval") || 60)) * 1000;
// 落 /root 而不是 /var/tmp：这台机器的 /var/tmp 会被 tmpfiles 清理
// （正是 <your-domain.example> 主站 502 的根因），实验数据不该冒被清掉的风险。
const OUT = process.env.OUT || `/root/b03-stuck-tx-${new Date().toISOString().slice(0, 10)}.csv`;

const p = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });

async function snap(tag, addr, hash) {
  const [tx, rec, latest, pending, head, pendBlk, bal] = await Promise.all([
    p.getTransaction(hash).catch(() => null),
    p.getTransactionReceipt(hash).catch(() => null),
    p.getTransactionCount(addr, "latest"),
    p.getTransactionCount(addr, "pending"),
    p.getBlockNumber(),
    p.getBlock("pending").catch(() => null),
    p.getBalance(addr),
  ]);
  // inPool 的判据要三条同时成立，单看 tx 非 null 不够：
  // 节点可能仍缓存已入块交易的回查结果
  const inPool = !!tx && tx.blockNumber == null && pending > latest;
  const row = {
    at: new Date().toISOString(), phase: tag, height: head,
    tx_seen: !!tx, tx_block: tx ? tx.blockNumber : null,
    tx_gasPrice: tx ? tx.gasPrice?.toString() : null, tx_type: tx ? tx.type : null,
    receipt: !!rec, receipt_status: rec ? rec.status : null,
    nonce_latest: latest, nonce_pending: pending,
    account_balance: bal.toString(),
    pending_block: !!pendBlk,
    in_pool: inPool,
  };
  return row;
}

(async () => {
  // 一次性账户：零余额。这正是 B04 现场的条件（部署账户从未领过币）。
  const w = ethers.Wallet.createRandom().connect(p);
  const addr = w.address;

  // 复现 B04 那笔：legacy、gasPrice=1 wei、value=0、gas 足够大。
  // 需要的余额 = gas * 1 wei + value ≈ 505440 wei，而账户余额为 0 → 永远无法执行；
  // 但 tx-pool-enable-balance-check=false 让它进池。
  console.log(`实验账户 ${addr}  余额 0  RPC ${RPC}`);
  const txreq = { to: "0x000000000000000000000000000000000000E51D", value: 0n, gasLimit: 505440n, gasPrice: 1n, type: 0 };
  let tx;
  try {
    tx = await w.sendTransaction(txreq);
  } catch (e) {
    console.log("❌ 广播即被拒（与预期不同，这本身是结论）：", (e.shortMessage || e.message || "").slice(0, 200));
    process.exit(2);
  }
  console.log(`已广播 ${tx.hash}`);

  const first = await snap("t+0", addr, tx.hash);
  if (!first.in_pool) {
    console.log("❌ 交易未进池，实验前提不成立 —— 记录实际观测：", JSON.stringify(first));
    fs.writeFileSync(OUT.replace(/\.csv$/, "-rejected.json"), JSON.stringify(first, null, 2));
    process.exit(3);
  }

  const cols = Object.keys(first);
  const exists = fs.existsSync(OUT);
  if (!exists) fs.writeFileSync(OUT, cols.join(",") + "\n");
  const write = (r) => fs.appendFileSync(OUT, cols.map((c) => r[c]).join(",") + "\n");
  write(first);
  console.log(`t+0 在池 ✅  观察 ${MINUTES} 分钟，每 ${INTERVAL / 1000}s 一次 → ${OUT}`);

  const n = Math.max(1, Math.floor((MINUTES * 60 * 1000) / INTERVAL));
  let lost = null;
  for (let i = 1; i <= n; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    const r = await snap(`t+${i * (INTERVAL / 1000)}s`, addr, tx.hash);
    write(r);
    console.log(`  ${r.at} height=${r.height} in_pool=${r.in_pool} nonce ${r.nonce_latest}/${r.nonce_pending} receipt=${r.receipt}`);
    if (!r.in_pool) { lost = r; break; }
  }

  console.log("\n=== 阶段 1 结论 ===");
  if (lost) {
    console.log(`⚠ 交易在**未重启**的情况下于 ${lost.at} 自行离开交易池（${lost.phase}）。`);
    console.log("   → 原推断被证伪：不需要重启也会消失。真正的清理者是节点自身策略。");
  } else {
    console.log(`✅ 连续 ${MINUTES} 分钟无人干预，交易始终在池中且 receipt 恒为 null。`);
    console.log("   → '不重启就一直在池里' 已被支持。现在才有资格做重启对照（阶段 2，需授权）。");
  }
  console.log(`实验参数：tx=${tx.hash} 账户=${addr} gasPrice=1 value=0 gas=505440 余额=0`);
  console.log(`CSV: ${OUT}`);
})().catch((e) => { console.error("实验异常：", e.message); process.exit(1); });
