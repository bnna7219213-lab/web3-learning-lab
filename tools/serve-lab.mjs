#!/usr/bin/env node
// 本地开发服务器：把生产环境里 nginx 承担的路由在本地复刻一遍，零依赖。
//
// 为什么需要它：钱包页写死了 `location.origin + "/b03-rpc/"`（同源，避免 CORS），
// 而 tools/serve.mjs 是纯静态服务器、没有反代。只跑 serve.mjs 的话，
// 页面能打开但余额永远读不出来——看起来像"链坏了"，其实缺的是这一层。
//
// 两个必须照抄生产的细节，否则请求会被节点直接拒掉（都是踩过的坑）：
//   1) Host 改写成 localhost —— Besu 的 rpc-http-host-allowlist 默认只认 localhost，
//      否则 403 "Host not authorized"；
//   2) 剥掉 Origin / Referer —— Besu 的 rpc-http-cors-origins 默认为空，
//      带 Origin 的浏览器请求会被 403 "CORS Rejected"。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 8080);
const EXPLORER = path.join(ROOT, "projects", "B03-链上交互实战联盟网", "explorer");
const UPSTREAM = {
  "/b03-rpc/": { host: "127.0.0.1", port: 8551 },
  "/b03-api/": { host: "127.0.0.1", port: 8570 },
  "/b03-faucet/": { host: "127.0.0.1", port: 8560 },
};
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

function proxy(req, res, prefix, up) {
  const rest = req.url.slice(prefix.length - 1); // 保留前导 /
  const target = rest || "/";
  const headers = { ...req.headers, host: "localhost" }; // 细节 1
  delete headers.origin; delete headers.referer;         // 细节 2
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const u = http.request({ method: req.method, hostname: up.host, port: up.port, path: target, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    u.on("error", (e) => {
      // 上游没起时必须回 JSON。回一段 HTML 错误页会让前端 r.json() 抛
      // "Unexpected token '<'"，把"后端没启动"伪装成"接口返回乱码"。
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `上游 ${up.host}:${up.port} 不可达：${e.message}`, hint: "请按 README §3 依次启动链、索引器、水龙头" }));
    });
    if (body.length) u.write(body);
    u.end();
  });
}

function resolveStatic(url) {
  const clean = decodeURIComponent(url.split("?")[0]);
  let base = ROOT, rel = clean;
  if (clean === "/b03" || clean === "/b03/") return path.join(EXPLORER, "index.html");
  if (clean.startsWith("/b03/")) { base = EXPLORER; rel = clean.slice("/b03".length); }
  const abs = path.resolve(base, "." + rel);
  // 目录穿越防护：解析后必须仍在允许的根内
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  for (const [prefix, up] of Object.entries(UPSTREAM)) {
    if (url.startsWith(prefix)) return proxy(req, res, prefix, up);
  }
  let abs = resolveStatic(url);
  if (!abs) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("403 越界路径"); }
  try { if (fs.statSync(abs).isDirectory()) abs = path.join(abs, "index.html"); } catch { /* 不存在交给 readFile */ }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("404 " + url); }
    // no-cache：否则改了 css/js 刷新仍是旧版，会把"代码没生效"当成"代码写错了"来查
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`B03 本地实验台 → http://127.0.0.1:${PORT}/b03/wallet.html`);
  console.log(`反代 /b03-rpc/→8551　/b03-api/→8570　/b03-faucet/→8560（上游未起时回 502 + JSON 说明）`);
});
