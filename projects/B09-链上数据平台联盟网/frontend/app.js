// 零构建看板：只调 BFF 的 REST，无框架、无打包（与 B03 内网浏览器同风格）。
// 分页用游标栈（上一页 = 回放历史游标），刷新保留筛选（URL 参数）。
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (v) => (v && v.length > 14 ? v.slice(0, 8) + "…" + v.slice(-4) : esc(v));

async function api(path) {
  const r = await fetch(path);
  return r.json();
}

function filters() {
  const f = new FormData($("#filters"));
  const out = {};
  for (const [k, v] of f.entries()) {
    const val = String(v).trim();
    if (!val) continue;
    if (k === "addr") { out.fromAddr = val; }
    else out[k] = val;
  }
  return out;
}

function toQuery(f, after, limit) {
  const p = new URLSearchParams({ limit: String(limit) });
  for (const [k, v] of Object.entries(f)) p.set(k, v);
  if (after) p.set("after", after);
  return p.toString();
}

// ---- 状态 ----
let cursorStack = [null]; // null = 第一页
let pageIndex = 0;

async function loadLogs() {
  const f = filters();
  const after = cursorStack[pageIndex];
  const t0 = performance.now();
  const j = await api(`/api/logs?${toQuery(f, after, 20)}`);
  const ms = Math.round(performance.now() - t0);
  const tb = $("#logs tbody");
  tb.innerHTML = j.items
    .map(
      (r) => `<tr>
      <td>${r.blockNumber}</td>
      <td><span class="ev">${esc(r.eventName || "未登记事件")}</span></td>
      <td title="${esc(r.address)}">${short(r.address)}</td>
      <td>${short(r.fromAddr)}</td>
      <td>${short(r.toAddr)}</td>
      <td>${esc(r.tokenId ?? "")}${r.batch ? " / " + esc(r.batch) : ""}</td>
      <td title="${esc(r.txHash)}">${short(r.txHash)}</td>
    </tr>`
    )
    .join("");
  $("#pageinfo").textContent = `第 ${pageIndex + 1} 页 · ${j.items.length} 条 · 接口 ${ms}ms`;
  $("#next").disabled = !j.nextCursor;
  $("#prev").disabled = pageIndex === 0;
  if (j.nextCursor) cursorStack[pageIndex + 1] = j.nextCursor;
  // 把筛选写进 URL（刷新不丢）
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(filters())) u.searchParams.set(k, v);
  history.replaceState(null, "", u);
}

async function loadStats() {
  const [h, s] = await Promise.all([api("/api/health"), api("/api/stats")]);
  $("#health").textContent = `链高 ${h.head} · 已索引到 ${h.cursor?.lastBlock ?? "-"} · confirmations 深度由服务端配置`;
  const d = s.data;
  $("#cards").innerHTML = [
    ["区块", d.blocks],
    ["交易", d.txs],
    ["事件日志", d.logs],
    ["资产(派生)", d.assets],
    ["持有人(派生)", d.holders],
  ]
    .map(([k, v]) => `<div class="card"><div class="num">${v ?? 0}</div><div class="lab">${k}</div></div>`)
    .join("");

  // 事件分布：手写 SVG 条形图（零图表库）
  const evs = d.events.slice(0, 12);
  const max = Math.max(1, ...evs.map((e) => e.c));
  const w = 640, bh = 22;
  $("#chart").innerHTML = `<svg viewBox="0 0 ${w} ${Math.max(1, evs.length) * bh + 10}" width="100%">
    ${evs
      .map(
        (e, i) => `<g transform="translate(0,${i * bh + 5})">
      <rect x="180" y="2" width="${(e.c / max) * (w - 240)}" height="${bh - 8}" fill="#3b82f6" rx="3"/>
      <text x="170" y="${bh - 9}" text-anchor="end" font-size="11" fill="#334">${esc(e.eventName ?? "未登记")}</text>
      <text x="${180 + (e.c / max) * (w - 240) + 6}" y="${bh - 9}" font-size="11" fill="#667">${e.c}</text>
    </g>`
      )
      .join("")}
  </svg>`;
}

async function loadHolders() {
  const j = await api("/api/holders?limit=20");
  $("#holders tbody").innerHTML = j.data
    .map((r) => `<tr><td title="${esc(r.contract)}">${short(r.contract)}</td><td title="${esc(r.address)}">${short(r.address)}</td><td>${r.tokens}</td></tr>`)
    .join("");
}

$("#filters").addEventListener("submit", (e) => {
  e.preventDefault();
  cursorStack = [null];
  pageIndex = 0;
  loadLogs();
});
$("#reset").addEventListener("click", () => {
  setTimeout(() => { cursorStack = [null]; pageIndex = 0; loadLogs(); }, 0);
});
$("#next").addEventListener("click", () => { pageIndex++; loadLogs(); });
$("#prev").addEventListener("click", () => { pageIndex = Math.max(0, pageIndex - 1); loadLogs(); });

// URL → 表单初值
for (const [k, v] of new URL(location.href).searchParams.entries()) {
  const el = $(`#filters [name="${k}"]`);
  if (el) el.value = v;
}

loadStats();
loadLogs();
loadHolders();
setInterval(loadStats, 5000);

