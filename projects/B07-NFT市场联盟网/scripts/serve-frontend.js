// scripts/serve-frontend.js: 静态服务（B07 权益管理台）  用法：node scripts/serve-frontend.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");
const { PROJECT, cfg } = require("./lib/b07");
const CFG = cfg();

const PORT = Number(process.argv[2] || 5180);
const ROOT = path.join(PROJECT, "frontend");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css; charset=utf-8", ".png": "image/png" };

const server = http
  .createServer((req, res) => {
    // 同源 RPC 代理：联盟网 Besu 的 corsAllowedDomains=[] → 浏览器直连 8551 会被 CORS 拒
    // （anvil 允许 localhost，所以 P07 没遇到这条）。生产部署也该这样：前端与内网 RPC 网关同源。
    if (req.url === "/rpc" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const up = await fetch(CFG.RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: Buffer.concat(chunks),
          });
          const body = Buffer.from(await up.arrayBuffer());
          res.writeHead(up.status, { "Content-Type": "application/json" });
          res.end(body);
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rpc proxy failed: " + (e.message || e) }));
        }
      });
      return;
    }
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`B07 console: http://127.0.0.1:${PORT}/`));
// 端口被占时要**显式报错**：否则会静默退出，浏览器打开的是别人的服务
server.on("error", (e) => {
  console.error(`serve-frontend failed on port ${PORT}: ${e.code || e.message}`);
  process.exit(1);
});
