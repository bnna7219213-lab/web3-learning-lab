#!/usr/bin/env node
// scripts/observe-stuck-tx.js —— 「卡单」观测器（只读，不发交易）
//
// 背景（B04 坑 1）：零 gas 链 + tx-pool-enable-balance-check=false 时，
// 付不起手续费的交易会「拿到 hash、进池、永远不入块」。本脚本按固定间隔采样，
// 用**三个等效信号**判定它是否卡在池里（不用 txpool_content——它会把全链待处理
// 交易暴露到公网 RPC）：
//   in_pool      = eth_getTransactionByHash 非 null 且 blockNumber == null
//   receipt      = eth_getTransactionReceipt（卡单恒 null）
//   nonce_gap    = pending nonce > latest nonce（该账户有交易悬着）
//   pending_blk  = eth_getBlockByNumber("pending") 里能看到它
//
// 用法:
//   node scripts/observe-stuck-tx.js <txHash> [--minutes 15] [--interval 60]
//        [--rpc http://127.0.0.1:8551] [--nodes 8551,8552,8553] [--out docs/evidence]
//
// 输出: <out>/observe-<txHash前10位>-<时间戳>.jsonl（每行一次采样）+ 控制台摘要。
// 采样覆盖「不重启」与「重启后」两种阶段：重启节点后 in_pool 的变化是清池证据，
// 但**必须延时复查**——gossip 会在几分钟内把交易回填（见 docs/evidence/README.md）。

const fs = require("fs");
const path = require("path");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const txHash = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
if (!txHash) {
  console.error("用法: node scripts/observe-stuck-tx.js <txHash> [--minutes 15] [--interval 60] [--rpc URL] [--nodes 8551,8552,8553] [--out DIR]");
  process.exit(1);
}
const RPC = arg("rpc", "http://127.0.0.1:8551");
const NODES = arg("nodes", "8551,8552,8553").split(",").map((s) => s.trim()).map((p) => (/^http/.test(p) ? p : `http://127.0.0.1:${p}`));
const MINUTES = Number(arg("minutes", 15));
const INTERVAL = Number(arg("interval", 60));
const OUT = arg("out", path.join(__dirname, "..", "docs", "evidence"));

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  return j.result ?? null; // 观测器不因单点错误退出
}

async function sample(url) {
  const tx = await rpc(url, "eth_getTransactionByHash", [txHash]);
  const rec = await rpc(url, "eth_getTransactionReceipt", [txHash]);
  let latest = null;
  let pending = null;
  if (tx && tx.from) {
    latest = await rpc(url, "eth_getTransactionCount", [tx.from, "latest"]);
    pending = await rpc(url, "eth_getTransactionCount", [tx.from, "pending"]);
  }
  const pendBlk = await rpc(url, "eth_getBlockByNumber", ["pending", true]);
  const head = await rpc(url, "eth_blockNumber");
  return {
    url,
    head: head ? Number(BigInt(head)) : null,
    tx_seen: !!tx,
    in_pool: !!tx && tx.blockNumber === null,
    receipt: rec ? rec.status : null,
    nonce_latest: latest ? Number(BigInt(latest)) : null,
    nonce_pending: pending ? Number(BigInt(pending)) : null,
    pending_block_has_tx: !!(pendBlk && pendBlk.transactions && pendBlk.transactions.some((t) => (t.hash || t) === txHash)),
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `observe-${txHash.slice(0, 10)}-${Date.now()}.jsonl`);
  console.log(`观测 ${txHash}`);
  console.log(`节点: ${NODES.join(", ")}   间隔 ${INTERVAL}s × ${MINUTES}min   输出 ${file}`);
  const rounds = Math.max(1, Math.round((MINUTES * 60) / INTERVAL));
  for (let i = 0; i < rounds; i++) {
    const at = new Date().toISOString();
    for (const url of NODES) {
      const s = await sample(url);
      const line = JSON.stringify({ at, ...s });
      fs.appendFileSync(file, line + "\n");
      console.log(
        `[${at}] ${url.replace(/^http:\/\//, "")} head=${s.head} in_pool=${s.in_pool} receipt=${s.receipt} nonce=${s.nonce_latest}/${s.nonce_pending} pending_blk=${s.pending_block_has_tx}`
      );
    }
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
  console.log(`\n采样完成 → ${file}`);
  console.log("判读口诀：in_pool 恒 true 且 receipt 恒 null = 卡单实锤；");
  console.log("重启后 in_pool 变 false 但几分钟后又变 true = 被 gossip 回填（要清必须重启全部持单节点）。");
})();
