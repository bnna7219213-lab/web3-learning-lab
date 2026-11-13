// B04 卡单观测与处置台 · 前端逻辑（零依赖、零构建）
// 数据全部来自本机 BFF（/api/*）；浏览器不直连 8551（联盟网 Besu 的 CORS 白名单为空）。
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let currentTx = null;
let stuckCost = null;
let replaceCost = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const j = await res.json();
  // rejected=true 是业务规则拒绝（预期实验分支），不是网络或服务端异常；
  // 交给调用方展示可读原因，不能因 HTTP 200 就误报为异常。
  if (!res.ok || (j.ok === false && !j.rejected)) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function card(k, v, cls = "") {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`;
}

async function loadState() {
  const el = $("#health");
  try {
    const s = await api("/api/state");
    el.className = "health ok";
    const cons = s.finalityConsistent ? "3 节点一致 ✓" : "节点不一致 ✗";
    el.textContent =
      `链高 ${s.head} · chainId ${s.chainId} · 节点报价 ${s.gasPrice} / baseFee ${s.baseFeePerGas}` +
      ` · ${s.zeroBaseFee ? "零 baseFee ✓" : "非零 baseFee"} · ${cons}`;
    return s;
  } catch (e) {
    el.className = "health bad";
    el.textContent = "链状态读取失败：" + e.message;
    return null;
  }
}

async function loadActions() {
  try {
    const a = await api("/api/actions");
    $("#no-list").innerHTML = (a.notSupported || [])
      .map(
        (n) => `<div class="note">
        <h3>✗ 不提供「${esc(n.label)}」</h3>
        <p>${esc(n.why)}</p>
        <p class="alt">替代方案：${esc(n.useInstead)}</p>
      </div>`
      )
      .join("");
  } catch (e) {
    $("#no-list").innerHTML = `<div class="note"><h3>动作清单读取失败</h3><p>${esc(e.message)}</p></div>`;
  }
}

function renderSignals(sig) {
  const tb = $("#sig-table tbody");
  tb.innerHTML = (sig.signals || [])
    .map(
      (s) => `<tr>
      <td>${esc(String(s.url).replace(/^http:\/\//, ""))}</td>
      <td>${esc(s.head ?? "-")}</td>
      <td class="${s.in_pool ? "yes" : "no"}">${s.in_pool ? "true" : "false"}</td>
      <td>${s.receipt === null || s.receipt === undefined ? "null" : esc(s.receipt)}</td>
      <td>${esc(s.nonce_latest ?? "-")} / ${esc(s.nonce_pending ?? "-")}</td>
      <td class="${s.pending_block_has_tx ? "yes" : "no"}">${s.pending_block_has_tx ? "true" : "false"}</td>
    </tr>`
    )
    .join("");
  const v = sig.verdict;
  const box = $("#verdict");
  if (v) {
    box.className = "verdict " + (v.stuck ? "warn" : v.code === "mined" ? "ok" : "");
    box.innerHTML = `判读：<strong>${esc(v.text)}</strong>（code=${esc(v.code)}）`;
  }
  if (sig.evidence) $("#evidence").textContent = "最近证据文件：" + sig.evidence;
}

async function observe(hash) {
  const h = (hash || currentTx || "").trim();
  if (!h) {
    $("#verdict").className = "verdict warn";
    $("#verdict").textContent = "先造一笔卡单，或输入一个交易哈希。";
    return;
  }
  const sig = await api("/api/tx/" + h);
  currentTx = h;
  stuckCost = sig.stuckCost;
  replaceCost = sig.replaceCost;
  renderSignals(sig);
  $("#lab-cards").innerHTML = [
    card("交易哈希", sig.txHash),
    card("账户", sig.account || "-"),
    card("nonce", sig.nonce ?? "-"),
    card("gas / gasPrice", `${sig.gasLimit || "-"} / ${sig.gasPrice || "-"}`),
    card("卡单成本", sig.stuckCost ? sig.stuckCost + " wei" : "-", "warn"),
    card("替换成本", sig.replaceCost ? sig.replaceCost + " wei" : "-"),
  ].join("");
  checkWindow();
}

function checkWindow() {
  const inject = BigInt($("#inject").value || "0");
  const box = $("#window");
  if (stuckCost === null || replaceCost === null) {
    box.className = "verdict";
    box.textContent = "先观测一笔卡单，才能计算处置窗口。";
    return;
  }
  const lo = BigInt(replaceCost);
  const hi = BigInt(stuckCost);
  const inWindow = inject >= lo && inject < hi;
  box.className = "verdict " + (inWindow ? "ok" : "bad");
  box.innerHTML =
    `窗口判定：<strong>${lo} ≤ 注入额 ${inject} &lt; ${hi}</strong> → ` +
    (inWindow
      ? "<strong>窗口成立 ✓</strong> 可以执行处置"
      : inject < lo
        ? "<strong>不成立 ✗</strong> 注入额小于替换成本：替换交易自己付不起手续费"
        : "<strong>不成立 ✗</strong> 注入额不小于卡单成本：卡单本身会变成可执行，测的不是替换");
}

async function makeStuck() {
  const btn = $("#btn-make");
  btn.disabled = true;
  $("#lab-status").textContent = "正在造卡单…";
  try {
    const r = await api("/api/lab/make-stuck", { method: "POST" });
    $("#lab-status").textContent = `已造卡单 ${r.txHash}`;
    $("#tx-hash").value = r.txHash;
    await observe(r.txHash);
  } catch (e) {
    $("#lab-status").textContent = "造卡单失败：" + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function resolve() {
  const btn = $("#btn-resolve");
  btn.disabled = true;
  try {
    const r = await api("/api/lab/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inject: $("#inject").value }),
    });
    if (r.rejected) {
      $("#fix-cards").innerHTML = card("处置被拒", r.plan.note, "bad");
      return;
    }
    $("#fix-cards").innerHTML = [
      card("注入交易", `${r.injectTx} (block ${r.injectBlock})`, "ok"),
      card("替换交易", `${r.replacement} (block ${r.replacementBlock})`, "ok"),
      card("替换回执", "status=" + r.replacementStatus, r.replacementStatus === 1 ? "ok" : "bad"),
      card("原卡单", r.verdict.text, r.verdict.stuck ? "bad" : "ok"),
      card("nonce", `${r.before.nonce_latest} → ${r.after.nonce_latest}`, "ok"),
    ].join("");
    await observe(currentTx);
  } catch (e) {
    $("#fix-cards").innerHTML = card("处置异常", e.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

$("#btn-make").addEventListener("click", makeStuck);
$("#btn-refresh").addEventListener("click", () => observe());
$("#btn-observe").addEventListener("click", () => observe($("#tx-hash").value));
$("#btn-resolve").addEventListener("click", resolve);
$("#inject").addEventListener("input", checkWindow);
$("#btn-faucet").addEventListener("click", () => {
  // 故意演示「按水龙头额度注入」这个坑：10 B03 = 1e19 wei，远超卡单成本
  $("#inject").value = "10000000000000000000";
  checkWindow();
  $("#window").className = "verdict bad";
  $("#window").innerHTML =
    "⚠ 这就是 README 里记的那个坑：按水龙头固定额度（10 B03）注入，卡单本身立刻变成可执行、" +
    "会在原 nonce 直接入块 —— 账户「看起来解锁了」，实际测的是原交易能否执行，<strong>与替换是否生效无关</strong>。";
});

loadState();
loadActions();
setInterval(loadState, 15000);
