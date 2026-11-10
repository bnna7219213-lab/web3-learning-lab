// b03-indexer 入口：同起扫块器 + 查询 API
// 跑法：node server.js （systemd 里 WorkingDirectory=/opt/b03-indexer，DB 落 /opt/b03-indexer/data/）
const db = require("./db");
const api = require("./api");
const scanner = require("./scanner");
const evidence = require("./evidence");
const cfg = require("./config");

const d = db.open(cfg.DB_PATH);
evidence.ensureSchema(d);
api.start(d);        // 查询先起：索引追赶期间也能查（lag 慢慢归零）
scanner.run().catch((e) => {
  console.error("[scanner] 致命退出：", e);
  process.exit(1);   // systemd Restart=always 拉起
});

process.on("SIGTERM", () => { console.log("[indexer] SIGTERM，退出"); process.exit(0); });
process.on("SIGINT", () => { console.log("[indexer] SIGINT，退出"); process.exit(0); });
