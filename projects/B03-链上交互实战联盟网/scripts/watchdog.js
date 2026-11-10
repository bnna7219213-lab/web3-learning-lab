#!/usr/bin/env node
// B03 联盟链看门狗：专防"看起来一切正常，其实已经停链"。
//
// 为什么必须存在：2026-10-16 两次实测——只起 2/4 验证者时，四个节点的 RPC 全部正常响应、
// net_peerCount 正常、进程都在，唯独高度不动（QBFT quorum=⌈2f+1⌉=3 未满足）。
// 任何"进程在不在"式的健康检查都会判它健康。所以这里唯一的硬指标是：
// **隔一段时间，高度有没有涨**。
//
// 用法：node watchdog.js            # 跑一次，告警时退出码非 0（给 cron/邮件用）
//       node watchdog.js --interval 20 --state /var/lib/b03-watchdog/state.json
// cron 建议：* * * * * 每 1–2 分钟一次；连续两次无增长才算停链（见 STALL_GRACE）
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC || "http://127.0.0.1:8551";
const API = process.env.API || "http://127.0.0.1:8570";
const FAUCET = process.env.FAUCET || "http://127.0.0.1:8560";
const STATE = process.env.STATE || "/var/lib/b03-watchdog/state.json";
const BLOCK_PERIOD = Number(process.env.BLOCK_PERIOD || 5);          // 秒，genesis blockperiodseconds
const INTERVAL = Number((process.argv.find((a, i) => process.argv[i - 1] === "--interval") || 20));
// 停链判定宽限：至少跨过两个出块周期再加缓冲，避免把"刚好在两个块之间"误判成停摆
const STALL_GRACE = Math.max(2, Math.ceil((BLOCK_PERIOD * 2 + 10) / INTERVAL));

const arg = (n, def) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : def; };

async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
  return j.result;
}
async function get(url, timeout = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return { ok: r.ok, status: r.status, body: await r.text() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
}

(async () => {
  const problems = [];
  const now = Math.floor(Date.now() / 1000);

  // 1) 高度：本次采样 + 与上次持久化采样比较
  let height = null;
  try { height = Number(BigInt(await rpc("eth_blockNumber"))); }
  catch (e) { problems.push({ sev: "CRIT", what: "RPC 不可达", detail: e.message }); }

  const prev = loadState();
  let stalledFor = 0, ticksWithoutGrowth = 0;
  if (height !== null && prev && typeof prev.height === "number") {
    if (height > prev.height) {
      ticksWithoutGrowth = 0;
    } else {
      ticksWithoutGrowth = (prev.ticksWithoutGrowth || 0) + 1;
      stalledFor = now - (prev.lastGrowthAt || prev.ts || now);
      if (ticksWithoutGrowth >= STALL_GRACE) {
        problems.push({ sev: "CRIT", what: "链停止出块",
          detail: `高度停在 ${height}，已 ${ticksWithoutGrowth} 次采样无增长（${stalledFor}s）。` +
                  `先查在线验证者是否 < quorum：curl -s ${API}/api/v1/nodes` });
      }
    }
  }

  // 2) 拓扑：在线数 / 高度收敛 / gasPrice 漂移
  let topo = null;
  try {
    const r = await get(`${API}/api/v1/nodes`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    topo = JSON.parse(r.body);
    if (topo.online < topo.quorum)
      problems.push({ sev: "CRIT", what: "在线验证者不足",
        detail: `在线 ${topo.online} < quorum ${topo.quorum}，链已无法出块。` +
                `恢复要**全体同时重启**（单个补起会因 round 不一致继续不动块）：systemctl restart besu-node@1 besu-node@2 besu-node@3` });
    else if (topo.faultTolerance === 0)
      problems.push({ sev: "WARN", what: "零容错运行", detail: `在线 ${topo.online} == quorum ${topo.quorum}，再挂任意一台即停链` });
    if (topo.online >= topo.quorum && !topo.heightsAgree)
      problems.push({ sev: "WARN", what: "节点高度不收敛", detail: `最大差 ${topo.heightSpread} 块，可能有节点在追块或脱队` });
    if (topo.gasPriceDriftNodes?.length)
      problems.push({ sev: "CRIT", what: "节点 min-gas-price 漂移",
        detail: `${topo.gasPriceDriftNodes.join(", ")} 的 gasPrice ≠ 0，会**静默丢弃**零 gas 交易（拿到 hash 但永远没有 receipt）` });
  } catch (e) {
    problems.push({ sev: "CRIT", what: "索引器 API 不可用", detail: e.message });
  }

  // 3) 索引器滞后
  try {
    const r = await get(`${API}/health`);
    const h = JSON.parse(r.body);
    if (h.lag > 30) problems.push({ sev: "WARN", what: "索引器滞后", detail: `lag=${h.lag} 块（indexed=${h.indexed} head=${h.chainHead}）` });
  } catch (e) {
    problems.push({ sev: "CRIT", what: "索引器健康检查失败", detail: e.message });
  }

  // 4) 水龙头：现在它会真探链，503 就是链有问题
  try {
    const r = await get(`${FAUCET}/health`);
    if (r.status === 503) problems.push({ sev: "CRIT", what: "水龙头报断链", detail: r.body.slice(0, 160) });
    else if (!r.ok) problems.push({ sev: "CRIT", what: "水龙头不可达", detail: `HTTP ${r.status}` });
  } catch (e) {
    problems.push({ sev: "CRIT", what: "水龙头不可达", detail: e.message });
  }

  // 落盘：给浏览器和下一次采样用
  const next = {
    ts: now,
    height,
    lastGrowthAt: (height !== null && prev && height > prev.height) ? now : (prev?.lastGrowthAt ?? now),
    ticksWithoutGrowth,
    problems,
    crit: problems.filter((p) => p.sev === "CRIT").length,
    warn: problems.filter((p) => p.sev === "WARN").length,
  };
  saveState(next);

  const line = `${new Date().toISOString()} height=${height} online=${topo ? topo.online + "/" + topo.total : "?"} crit=${next.crit} warn=${next.warn}`;
  console.log(line);
  for (const p of problems) console.log(`  [${p.sev}] ${p.what} — ${p.detail}`);
  if (!problems.length) console.log("  一切正常");

  process.exitCode = next.crit > 0 ? 2 : next.warn > 0 ? 1 : 0;
})().catch((e) => { console.error("watchdog 自身异常：", e); process.exit(3); });
