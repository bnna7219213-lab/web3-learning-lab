// CLI 入口：
//   node run.js sync    同步一次（safe = head - confirmations）
//   node run.js watch   常驻轮询
//   node run.js serve   BFF + 看板（先同步一次，再按 POLL_MS 轮询）
import { openDb } from "./db.js";
import { Scanner } from "./scanner.js";
import { createServer } from "./server.js";
import * as cfg from "./config.js";

const cmd = process.argv[2] || "sync";
const store = openDb(cfg.DB_PATH);
const scanner = new Scanner({
  store,
  rpc: cfg.RPC,
  contracts: cfg.watchContracts(),
  sources: cfg.watchSources(),
  confirmations: cfg.CONFIRMATIONS,
  logChunk: cfg.LOG_CHUNK,
  startBlock: cfg.START_BLOCK,
  chainKey: `chain:${cfg.CHAIN_ID}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === "sync") {
  const r = await scanner.syncOnce();
  console.log(JSON.stringify({ ...r, stats: store.stats() }, null, 2));
} else if (cmd === "watch") {
  for (;;) {
    try {
      const r = await scanner.syncOnce();
      if (r.ingestedLogs) console.log(`[b09] +${r.ingestedLogs} logs @ ${r.cursor?.lastBlock}`);
    } catch (e) {
      console.error("[b09] sync error:", e.message);
    }
    await sleep(cfg.POLL_MS);
  }
} else if (cmd === "serve") {
  createServer({ store, scanner, apiKey: cfg.API_KEY, port: cfg.API_PORT });
  await scanner.syncOnce().catch((e) => console.error("[b09] 初次同步失败:", e.message));
  for (;;) {
    try {
      await scanner.syncOnce();
    } catch (e) {
      console.error("[b09] sync error:", e.message);
    }
    await sleep(cfg.POLL_MS);
  }
} else {
  console.error("用法: node run.js sync|watch|serve");
  process.exit(1);
}

