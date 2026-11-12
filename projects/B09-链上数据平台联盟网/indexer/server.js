// BFF：REST + 游标分页 + 筛选 + 鉴权（管理口令 X-API-Key），并托管零构建看板。
// 分页语义：after=<blockNumber>:<logIndex|txIndex>，按 (blockNumber, index) 倒序 —— 翻页稳定
// （新块只追加在列表头部，不会把已翻过的行挤走）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "..", "frontend");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function json(res, code, obj, ms) {
  const body = JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "x-response-ms": String(ms ?? 0),
  });
  res.end(body);
}

export function createServer({ store, scanner, apiKey, port }) {
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());
    try {
      if (p === "/api/health") {
        const head = scanner ? await scanner.head() : null;
        return json(res, 200, { ok: true, head, cursor: store.getCursor(), chainKey: scanner?.chainKey }, Date.now() - t0);
      }
      if (p === "/api/stats") return json(res, 200, { ok: true, data: store.stats() }, Date.now() - t0);
      if (p === "/api/logs") {
        const { after, limit, ...f } = q;
        return json(res, 200, { ok: true, ...store.queryLogs(f, { after, limit: Math.min(Number(limit) || 20, 100) }) }, Date.now() - t0);
      }
      if (p === "/api/txs") {
        const { after, limit, ...f } = q;
        return json(res, 200, { ok: true, ...store.queryTxs(f, { after, limit: Math.min(Number(limit) || 20, 100) }) }, Date.now() - t0);
      }
      if (p === "/api/holders") {
        const { contract, limit } = q;
        const rows = store.q(
          `SELECT * FROM holders ${contract ? "WHERE contract = ?" : ""} ORDER BY tokens DESC LIMIT ?`
        ).all(...(contract ? [contract.toLowerCase(), Math.min(Number(limit) || 50, 200)] : [Math.min(Number(limit) || 50, 200)]));
        return json(res, 200, { ok: true, data: rows }, Date.now() - t0);
      }
      if (p === "/api/assets") {
        const { contract, owner, limit } = q;
        const where = [];
        const args = [];
        if (contract) { where.push("contract = ?"); args.push(contract.toLowerCase()); }
        if (owner) { where.push("owner = ?"); args.push(owner.toLowerCase()); }
        args.push(Math.min(Number(limit) || 50, 200));
        const rows = store.q(`SELECT * FROM assets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updatedAt DESC LIMIT ?`).all(...args);
        return json(res, 200, { ok: true, data: rows }, Date.now() - t0);
      }

      // ---- 管理口（鉴权）----
      if (p.startsWith("/admin/")) {
        if ((req.headers["x-api-key"] ?? "") !== apiKey) return json(res, 401, { ok: false, error: "bad api key" }, Date.now() - t0);
        if (p === "/admin/sync" && req.method === "POST") {
          const r = await scanner.syncOnce();
          return json(res, 200, { ok: true, data: r }, Date.now() - t0);
        }
        if (p === "/admin/rollback" && req.method === "POST") {
          const to = Number(q.to ?? store.getCursor()?.lastBlock ?? 0);
          const r = store.rollbackTo(to);
          return json(res, 200, { ok: true, data: { rolledBackTo: r } }, Date.now() - t0);
        }
        return json(res, 404, { ok: false, error: "no such admin route" }, Date.now() - t0);
      }

      // ---- 静态看板 ----
      let file = p === "/" ? "/index.html" : p;
      file = path.normalize(file).replace(/^([/\\])+/, "");
      const full = path.join(FRONTEND, file);
      if (full.startsWith(FRONTEND) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const body = fs.readFileSync(full);
        res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
        return res.end(body);
      }
      return json(res, 404, { ok: false, error: "not found" }, Date.now() - t0);
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message }, Date.now() - t0);
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`[b09] BFF on http://127.0.0.1:${port} (api key header: x-api-key)`));
  return server;
}

