// 零构建看板：只读 BFF 的 REST，无框架、无打包（与 B09 看板同风格）。
// 只读原则：页面不发交易、不持有私钥；写操作在 scripts/ 里完成，这里只做「链上事实 vs 实测记录」并排对照。
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (v, n = 10) => (v && String(v).length > n * 2 ? String(v).slice(0, n) + "…" + String(v).slice(-6) : esc(v));
const num = (v) => (v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("en-US"));

async function api(p) {
  const r = await fetch(p);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "api error");
  return j;
}

function card(label, value, tone) {
  return `<div class="card${tone ? " " + tone : ""}"><div class="num">${esc(value)}</div><div class="lab">${esc(label)}</div></div>`;
}

// ── ① 链状态 ────────────────────────────────────────────────────────────────
async function loadState() {
  const j = await api("/api/state");
  const c = j.chain;
  const v = j.vault || {};
  $("#cards").innerHTML = [
    card("链高", num(c.head)),
    card("chainId", num(c.chainId)),
    card("gasPrice", c.gasPrice, c.zeroGas ? "good" : "warn"),
    card("baseFee", c.baseFeePerGas, c.zeroGas ? "good" : "warn"),
    card("零 gas 语义", c.zeroGas ? "成立" : "不成立", c.zeroGas ? "good" : "bad"),
    card("终结性一致（3 节点）", c.finality.consistent ? "一致" : "不一致", c.finality.consistent ? "good" : "bad"),
    card("区块 gasLimit", num(c.blockGasLimit)),
    card("Vault 实现槽对齐登记", v.implMatchesRegister ? "一致" : "不一致", v.implMatchesRegister ? "good" : "bad"),
  ].join("");
  $("#health").textContent = `链高 ${c.head} · 链 ID ${c.chainId} · gasPrice ${c.gasPrice} / baseFee ${c.baseFeePerGas}`;
  $("#health").className = "health " + (c.zeroGas ? "ok" : "bad");
  $("#finality").innerHTML =
    `块 #${c.finality.targetBlock} 的哈希在 ${c.finality.nodes.length} 个节点上一致：<strong>${short(c.finality.hash, 16)}</strong>` +
    `（QBFT 单块终结 ⇒ 确认数语义为 0）`;

  renderGas(j.reports.gas);
  renderUpgrade(j.reports.upgrade, v);
  renderBig(j.reports.bigContract);
  renderVault(v);
}

// ── Vault 代理明细 ──────────────────────────────────────────────────────────
function renderVault(v) {
  const tb = $("#vault-table tbody");
  if (!v || v.error) {
    tb.innerHTML = `<tr><td colspan="2" class="bad">读取失败：${esc(v?.error ?? "未知")}</td></tr>`;
    return;
  }
  const kv = (k, val, cls) => `<tr><td>${esc(k)}</td><td class="${cls || ""}">${val}</td></tr>`;
  tb.innerHTML = [
    kv("代理地址", `<span class="mono">${esc(v.proxy)}</span>`),
    kv("链上实现槽（ERC-1967）", `<span class="mono">${esc(v.implOnChain)}</span>`),
    kv(
      "实现槽 vs 部署登记",
      `<span class="${v.implMatchesRegister ? "good" : "bad"}">${v.implMatchesRegister ? "一致" : "不一致"}</span>`
    ),
    kv("owner", `<span class="mono">${esc(v.owner)}</span>`),
    kv("version", esc(v.version)),
    kv("slot2 totalDeposited", num(v.totalDeposited)),
    kv(
      "V2 totalWithdrawn",
      v.totalWithdrawn === null ? '<span class="warn">读不到（当前实现无此字段）</span>' : num(v.totalWithdrawn)
    ),
    kv("说明", esc(v.lastDepositBlockNote ?? "")),
    kv("UUPS 接口版本", esc(v.upgradeInterfaceVersion ?? "—")),
  ].join("");
}

// ── ② Gas 双指标 ───────────────────────────────────────────────────────────
function renderGas(g) {
  const tb = $("#gas-table tbody");
  if (!g) {
    tb.innerHTML = `<tr><td colspan="6" class="bad">未找到 deployments/gas-report.json —— 先跑 <code>node scripts/06-gas-report.js</code></td></tr>`;
    return;
  }
  const blockLimit = Number(g.blockGasLimit);
  const ref = 30000000;
  tb.innerHTML = g.groups
    .map((r) => {
      const gn = Number(r.gasNaive);
      const go = Number(r.gasOpt);
      const pct = ((go * 100) / blockLimit).toExponential(2);
      return `<tr>
        <td>${esc(r.group)}</td>
        <td class="num">${num(gn)}</td>
        <td class="num">${num(go)}</td>
        <td class="num ${Number(r.saved) > 0 ? "good" : ""}">${num(r.saved)}（${((Number(r.saved) * 100) / gn).toFixed(1)}%）</td>
        <td class="num">${pct}%</td>
        <td class="num">${num(Math.floor(ref / gn))} → ${num(Math.floor(ref / go))} 笔</td>
      </tr>`;
    })
    .join("");
  $("#batch-table tbody").innerHTML = (g.batches || [])
    .map(
      (b) => `<tr>
        <td>${esc(b.label)}</td>
        <td class="num">${num(b.wallMs)} ms</td>
        <td class="num">${num(b.blocksSpanned)}</td>
        <td class="num">${num(b.gasTotal)}</td>
      </tr>`
    )
    .join("");
}

// ── ③ 升级演练 ─────────────────────────────────────────────────────────────
function renderUpgrade(u, vault) {
  const box = $("#upgrade");
  if (!u) {
    box.innerHTML = `<p class="bad">未找到 deployments/upgrade-drill.json —— 先跑 <code>node scripts/07-upgrade-drill.js</code></p>`;
    return;
  }
  const snaps = u.snapshots || [];
  const rows = snaps
    .map(
      (s) => `<tr>
        <td>${esc(s.tag)}</td>
        <td class="mono">${short(s.impl, 10)}</td>
        <td class="num">${num(s.slot2TotalDeposited)}</td>
        <td class="num">${num(s.version)}</td>
        <td class="mono">${short(s.owner, 8)}</td>
      </tr>`
    )
    .join("");
  box.innerHTML = `
    <div class="up-head">
      <span class="chip">变更单：${esc(u.manifest?.change ?? "-")}</span>
      <span class="chip">窗口：${esc(u.manifest?.window ?? "-")}</span>
      <span class="chip good">成员签名 ${Object.keys(u.memberSignatures || {}).length} 份</span>
      <span class="chip">升级 tx ${short(u.upgradeTx, 8)}</span>
      <span class="chip">回滚 tx ${short(u.rollbackTx, 8)}</span>
      ${vault && vault.implMatchesRegister ? '<span class="chip good">回滚后实现槽 = 登记实现</span>' : '<span class="chip warn">实现槽与登记不一致</span>'}
    </div>
    <div class="tablewrap">
      <table>
        <caption class="sr-only">升级演练三个快照的实现地址与业务槽对账</caption>
        <thead><tr><th scope="col">快照</th><th scope="col">实现地址</th><th scope="col">slot2 totalDeposited</th><th scope="col">version</th><th scope="col">owner</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint"><strong>结论：</strong>${esc(u.conclusion ?? "")}</p>`;
}

// ── ④ 大合约边界 ───────────────────────────────────────────────────────────
function renderBig(b) {
  const tb = $("#big-table tbody");
  if (!b) {
    tb.innerHTML = `<tr><td colspan="5" class="bad">未找到 deployments/big-contract.json —— 先跑 <code>node scripts/09-big-contract.js</code></td></tr>`;
    return;
  }
  tb.innerHTML = b.cases
    .map(
      (c) => `<tr>
        <td>${esc(c.label)}</td>
        <td class="num">${num(c.size)} B</td>
        <td class="num">${num(c.gasUsed)}</td>
        <td class="num">${num(c.codeLen)} B</td>
        <td class="mono">${short(c.address, 8)}</td>
      </tr>`
    )
    .join("");
  $("#big-note").innerHTML = `链配置：<code>${esc(b.chainConfig)}</code> · 脚本上限 <code>${esc(b.perTxScriptCap)}</code><br>${esc(b.conclusion ?? "")}`;
}

// ── ⑤ Create2 / Merkle 双算对账 ────────────────────────────────────────────
async function loadAddr() {
  const [c2, mk] = await Promise.all([api("/api/create2"), api("/api/merkle")]);
  const c = c2.data;
  const m = mk.data;
  const kv = (k, v, cls) => `<tr><td>${esc(k)}</td><td class="${cls || ""}">${v}</td></tr>`;
  $("#c2-table tbody").innerHTML = [
    kv("工厂地址", `<span class="mono">${esc(c.factory)}</span>`),
    kv("登记 chainId", esc(c.registeredChainId)),
    kv("已部署计数", num(c.deployCount)),
    kv("最近一次 Deployed", c.lastDeployed ? `块 #${c.lastDeployed.blockNumber} · <span class="mono">${short(c.lastDeployed.txHash, 8)}</span>` : "—"),
    kv(
      "链上登记 == 事件地址",
      c.crossCheck
        ? `<span class="${c.crossCheck.registeredMatchesEvent ? "good" : "bad"}">${c.crossCheck.registeredMatchesEvent ? "一致" : "不一致"}</span>`
        : "—"
    ),
    kv("salt", c.crossCheck ? `<span class="mono">${short(c.crossCheck.salt, 12)}</span>` : "—"),
  ].join("");
  $("#mk-table tbody").innerHTML = [
    kv("空投合约", `<span class="mono">${esc(m.contract)}</span>`),
    kv("链上 root()", `<span class="mono">${esc(m.rootOnChain)}</span>`),
    kv("部署记录 root", `<span class="mono">${esc(m.rootInDeployment)}</span>`),
    kv("对账", `<span class="${m.matches ? "good" : "bad"}">${m.matches ? "一致" : "不一致"}</span>`),
  ].join("");
}

// ── ⑥ 链上工程事件 ─────────────────────────────────────────────────────────
async function loadEvents() {
  const j = await api("/api/events?limit=60");
  const tb = $("#ev-table tbody");
  if (!j.data.items.length) {
    tb.innerHTML = `<tr><td colspan="5" class="warn">链上未查到 B08 合约事件</td></tr>`;
    return;
  }
  tb.innerHTML = j.data.items
    .map(
      (e) => `<tr>
        <td class="num">${num(e.blockNumber)}</td>
        <td><strong>${esc(e.eventName || "未登记事件")}</strong></td>
        <td>${esc(e.label)}</td>
        <td class="mono">${esc(e.args ? JSON.stringify(e.args) : "")}</td>
        <td class="mono">${short(e.txHash, 8)}</td>
      </tr>`
    )
    .join("");
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await loadState();
    await Promise.all([loadAddr(), loadEvents()]);
  } catch (e) {
    $("#health").textContent = "看板数据加载失败：" + e.message;
    $("#health").className = "health bad";
  }
}
boot();
setInterval(() => {
  loadState().catch(() => {});
}, 8000);
