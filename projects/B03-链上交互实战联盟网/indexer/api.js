// b03-indexer 查询 API：给前端 /b03-api/ 反代用（同源无 CORS）
// 全部只读 SQLite，不回链，毫秒级
const http = require("http");
const db = require("./db");
const cfg = require("./config");
const nodes = require("./nodes");
const evidence = require("./evidence");

function json(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(obj));
}

const get = (d, sql, ...args) => d.prepare(sql).get(...args);
const all = (d, sql, ...args) => d.prepare(sql).all(...args);
const num = (v) => Number(v ?? 0);
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
};

function start(d) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname.replace(/\/+$/, "") || "/";
    const q = u.searchParams;

    try {
      // ---- 状态：索引进度 vs 链头（探链，非静态）----
      if (p === "/health" || p === "/api/v1/status") {
        const indexed = num(db.getMeta(d, "last_scanned"));
        const head = num(get(d, "SELECT MAX(number) AS n FROM blocks")?.n);
        return json(res, 200, {
          ok: true,
          indexed,                  // 已入库的最高块
          chainHead: head,          // 索引到的链头（scanner 追平时 == 真链头）
          lag: Math.max(0, head - indexed),
          blocks: num(get(d, "SELECT COUNT(*) AS c FROM blocks")?.c),
          txs: num(get(d, "SELECT COUNT(*) AS c FROM txs")?.c),
          tokens: num(get(d, "SELECT COUNT(*) AS c FROM tokens")?.c),
          contracts: db.contractCount(d),
          contractsVerified: db.verifiedCount(d),
        });
      }

      // ---- 区块分页（倒序）----
      if (p === "/api/v1/blocks") {
        const page = clamp(q.get("page"), 1, 1e6, 1);
        const limit = clamp(q.get("limit"), 1, 100, 20);
        const total = num(get(d, "SELECT COUNT(*) AS c FROM blocks")?.c);
        const items = all(d, `SELECT number,hash,parent_hash,timestamp,tx_count,gas_used
                              FROM blocks ORDER BY number DESC LIMIT ? OFFSET ?`, limit, (page - 1) * limit);
        return json(res, 200, { total, page, limit, items });
      }

      // ---- 地址交易历史（收/发/全部）----
      let m = p.match(/^\/api\/v1\/address\/(0x[0-9a-fA-F]{40})\/txs$/);
      if (m) {
        const addr = m[1].toLowerCase();
        const dir = q.get("direction") || "all";
        const page = clamp(q.get("page"), 1, 1e6, 1);
        const limit = clamp(q.get("limit"), 1, 100, 20);
        const where = dir === "in" ? "to_addr=?"
                    : dir === "out" ? "from_addr=?"
                    : "(from_addr=? OR to_addr=?)";
        const args = dir === "all" ? [addr, addr] : [addr];
        const total = num(get(d, `SELECT COUNT(*) AS c FROM txs WHERE ${where}`, ...args)?.c);
        const items = all(d, `SELECT hash,block_number,tx_index,from_addr,to_addr,value,nonce,status,gas_used
                              FROM txs WHERE ${where}
                              ORDER BY block_number DESC, tx_index DESC LIMIT ? OFFSET ?`,
                          ...args, limit, (page - 1) * limit)
          .map((t) => ({ ...t, dir: t.from_addr === addr ? "out" : "in" }));
        return json(res, 200, { total, page, limit, items, address: addr });
      }

      // ---- 每日统计（图表数据）----
      if (p === "/api/v1/stats/daily") {
        const days = clamp(q.get("days"), 1, 365, 30);
        const rows = all(d, `SELECT date(timestamp,'unixepoch') AS date,
                                    COUNT(*) AS blocks,
                                    SUM(tx_count) AS txs
                             FROM blocks
                             WHERE timestamp >= strftime('%s','now','-'||?||' days')
                             GROUP BY date ORDER BY date`, days);
        // 活跃地址 = 当日 from/to 去重计数
        const items = rows.map((r) => {
          const act = get(d, `SELECT COUNT(DISTINCT a) AS c FROM (
                                SELECT from_addr AS a FROM txs
                                  WHERE block_number IN (SELECT number FROM blocks WHERE date(timestamp,'unixepoch')=?)
                                UNION
                                SELECT to_addr AS a FROM txs
                                  WHERE block_number IN (SELECT number FROM blocks WHERE date(timestamp,'unixepoch')=?)
                              )`, r.date, r.date);
          return { date: r.date, blocks: num(r.blocks), txs: num(r.txs), activeAddresses: num(act?.c) };
        });
        return json(res, 200, { days, items });
      }

      // ---- 代币列表 ----
      if (p === "/api/v1/tokens") {
        const items = all(d, `SELECT t.address,t.name,t.symbol,t.decimals,t.total_supply,t.first_block,
                                     COUNT(tt.id) AS transfers
                              FROM tokens t LEFT JOIN token_transfers tt ON tt.token=t.address
                              GROUP BY t.address ORDER BY transfers DESC`);
        return json(res, 200, { items });
      }

      // ---- 代币持仓分布（JS BigInt 聚合，避免 wei 巨数被 SQLite REAL 吃精度）----
      // 含 mint（from=0x0）；无 burn 的演示代币净值聚合即准确
      m = p.match(/^\/api\/v1\/tokens\/(0x[0-9a-fA-F]{40})\/holders$/);
      if (m) {
        const token = m[1].toLowerCase();
        const limit = clamp(q.get("limit"), 1, 200, 50);
        const ZERO = "0x0000000000000000000000000000000000000000";
        const rows = all(d, `SELECT from_addr,to_addr,value FROM token_transfers WHERE token=?`, token);
        const bal = new Map();
        for (const r of rows) {
          const v = BigInt(r.value || "0");
          if (r.to_addr && r.to_addr !== ZERO) bal.set(r.to_addr, (bal.get(r.to_addr) || 0n) + v);
          if (r.from_addr && r.from_addr !== ZERO) bal.set(r.from_addr, (bal.get(r.from_addr) || 0n) - v);
        }
        const items = [...bal.entries()]
          .filter(([, v]) => v > 0n)
          .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
          .slice(0, limit)
          .map(([addr, v]) => ({ addr, balance: v.toString(10) }));
        return json(res, 200, { token, items, note: "余额按 Transfer 事件净值聚合（BigInt，无精度损失）；含 mint（from=0x0），不含合约内记账" });
      }

      // ---- 代币转账记录 ----
      m = p.match(/^\/api\/v1\/tokens\/(0x[0-9a-fA-F]{40})\/transfers$/);
      if (m) {
        const token = m[1].toLowerCase();
        const page = clamp(q.get("page"), 1, 1e6, 1);
        const limit = clamp(q.get("limit"), 1, 100, 20);
        const total = num(get(d, "SELECT COUNT(*) AS c FROM token_transfers WHERE token=?", token)?.c);
        const items = all(d, `SELECT tx_hash,block_number,log_index,from_addr,to_addr,value
                              FROM token_transfers WHERE token=?
                              ORDER BY block_number DESC, log_index DESC LIMIT ? OFFSET ?`,
                          token, limit, (page - 1) * limit);
        return json(res, 200, { total, page, limit, items });
      }

      // ---- 多节点拓扑：在线几台 / quorum / 高度是否收敛 / 有没有节点 gasPrice 漂移 ----
      if (p === "/api/v1/nodes") {
        return json(res, 200, await nodes.nodesCached());
      }

      // ---- 跨节点一致性核验（把原来写在页面上"请自行到 4 个节点分别查"的动作搬到服务端）----
      m = p.match(/^\/api\/v1\/consistency\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const [addr, topo] = await Promise.all([nodes.probeAddress(m[1]), nodes.nodesCached()]);
        return json(res, 200, { ...addr, topology: topo });
      }

      // ---- 合约登记表（替代公网 Etherscan 的 Verify Contract）----
      if (p === "/api/v1/contracts") {
        const limit = clamp(q.get("limit"), 1, 500, 100);
        return json(res, 200, {
          total: db.contractCount(d),
          verified: db.verifiedCount(d),
          items: db.listContracts(d, limit),
        });
      }

      m = p.match(/^\/api\/v1\/contract\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const row = db.getContract(d, m[1].toLowerCase());
        if (!row) return json(res, 404, { error: "该地址不在合约登记表（可能不是合约，或索引器尚未扫到部署交易）" });
        // verified 三态：0 只有链上事实 / 1 已登记且指纹自洽 / 2 登记了但对不上
        const mismatch = row.verified === 2;
        return json(res, 200, {
          ...row,
          abi: row.abi ? JSON.parse(row.abi) : null,
          verifiedLabel: mismatch ? "指纹不一致" : row.verified === 1 ? "已登记" : "仅链上事实（未登记源码）",
          // 客户独立复核命令：不信任本索引器的人可以自己在任何节点上重算
          selfCheck: {
            rpc: "http://<联盟网RPC>/",
            command: `cast code --rpc-url <RPC> ${row.address} | xxd -r -p | cast keccak`,
            expect: row.deployed_hash,
            note: "keccak 的是 runtime bytecode（getCode 结果），不是构造时的 deploy bytecode；两者差一段 constructor 编码",
          },
        });
      }

      // ---- 出证包（只读）。签发是 CLI 在服务器上做的，公网没有写入口 ----
      if (p === "/api/v1/evidence") {
        const limit = clamp(q.get("limit"), 1, 200, 50);
        return json(res, 200, {
          items: all(d, `SELECT evidence_id,batch_id,leaf_index,subject_kind,subject_id,root,anchor_tx,anchor_block,issued_at
                         FROM evidence ORDER BY issued_at DESC LIMIT ?`, limit),
        });
      }
      m = p.match(/^\/api\/v1\/evidence\/(ev_[A-Za-z0-9_-]{6,64})$/);
      if (m) {
        const row = get(d, "SELECT package FROM evidence WHERE evidence_id=?", m[1]);
        if (!row) return json(res, 404, { error: "找不到该 evidenceId" });
        return json(res, 200, JSON.parse(row.package));
      }
      m = p.match(/^\/api\/v1\/evidence\/(ev_[A-Za-z0-9_-]{6,64})\/verify$/);
      if (m) {
        const r = await evidence.verifyStored(d, m[1]);
        return json(res, 200, r);
      }

      // ---- 看门狗最近一次体检结果（watchdog.js 写，这里只读）----
      if (p === "/api/v1/watchdog") {
        try {
          const s = JSON.parse(require("fs").readFileSync(cfg.WATCHDOG_STATE, "utf8"));
          const age = Math.floor(Date.now() / 1000) - (s.ts || 0);
          // 状态文件本身过期 = 看门狗没在跑，这比任何单项告警都严重
          const stale = age > 300;
          // available 必须显式给 true：前端靠它区分"跑过且正常"与"没数据"，
          // 少了这个字段前端会把正常结果当成不可用而清空横幅（实测踩过一次）。
          return json(res, 200, { available: true, ...s, ageSec: age, stale, note: stale ? "看门狗超过 5 分钟未更新，检查 cron/timer" : null });
        } catch (e) {
          return json(res, 200, { available: false, error: e.message, note: "还没跑过 watchdog.js，或状态文件不可读" });
        }
      }

      return json(res, 404, { error: "unknown endpoint" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  server.listen(cfg.API_PORT, cfg.API_HOST, () => {
    console.log(`[api] 监听 ${cfg.API_HOST}:${cfg.API_PORT}`);
  });
  return server;
}

module.exports = { start };
