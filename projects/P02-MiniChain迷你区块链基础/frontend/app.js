// 节点面板：与节点共用 ../src/crypto.js 与 ../src/tx.js —— 同一套签名代码，两边行为必须一致。
import { importPrivateKey } from "../src/crypto.js";
import { createTx } from "../src/tx.js";

const DEFAULT_NODES = ["http://127.0.0.1:5301", "http://127.0.0.1:5302", "http://127.0.0.1:5303"];
const nodes = JSON.parse(localStorage.getItem("minichain.nodes") || "null") ?? DEFAULT_NODES;
let selected = 0;
let statuses = [];

const $ = (id) => document.getElementById(id);
const short = (h = "", n = 10) => (h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-6)}` : h);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

async function api(base, path, options) {
  const res = await fetch(base + path, options);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function renderNodes() {
  const host = $("nodes");
  host.textContent = "";
  statuses.forEach((s, i) => {
    if (!s) {
      host.append(el("div", { class: "node" }, el("h4", { text: nodes[i] }), el("p", { class: "badge bad", text: "离线" })));
      return;
    }
    host.append(
      el(
        "div",
        { class: "node" },
        el("h4", { text: `${s.name} · ${s.consensus.toUpperCase()}` }),
        el("div", { class: "k" }, el("span", { text: "高度" }), el("span", { class: "v", text: String(s.height) })),
        el("div", { class: "k" }, el("span", { text: "权重" }), el("span", { class: "v", text: String(s.weight) })),
        el("div", { class: "k" }, el("span", { text: "链尖" }), el("span", { class: "v", text: short(s.tip) })),
        el("div", { class: "k" }, el("span", { text: "交易池" }), el("span", { class: "v", text: String(s.mempool) })),
        el("div", { class: "k" }, el("span", { text: "出块/接收/重组" }), el("span", { class: "v", text: `${s.stats.mined}/${s.stats.received}/${s.stats.reorgs}` })),
        el("div", { class: "k" }, el("span", { text: "地址" }), el("span", { class: "v", text: short(s.address, 8) }))
      )
    );
  });

  const tips = new Set(statuses.filter(Boolean).map((s) => s.tip));
  const heights = statuses.filter(Boolean).map((s) => s.height);
  const lag = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
  $("consensus").replaceChildren(
    el("span", { class: `badge ${tips.size === 1 ? "ok" : "bad"}`, text: tips.size === 1 ? "全网同一链尖" : `链尖不一致（${tips.size} 条分支）` }),
    el("span", { class: "note", text: ` 高度差 ${lag}；刷新于 ${new Date().toLocaleTimeString()}` })
  );
}

async function renderChain() {
  const host = $("chain");
  const { ok, body } = await api(nodes[selected], "/chain");
  if (!ok) return host.replaceChildren(el("p", { class: "badge bad", text: "取不到链" }));
  const chain = body.chain;
  const table = el(
    "table",
    {},
    el("thead", {}, el("tr", {}, ["#", "出块人", "交易", "Merkle root", "区块 hash", "nonce/时间"].map((t) => el("th", { text: t })))),
    el(
      "tbody",
      {},
      chain.map((block, i) =>
        el(
          "tr",
          { class: i === chain.length - 1 ? "tip" : "" },
          [
            el("td", { text: String(block.index) }),
            el("td", { class: "mono", text: short(block.proposer, 8) }),
            el("td", { text: String(block.txs.length) }),
            el("td", { class: "mono", text: block.merkleRoot ? short(block.merkleRoot) : "（空块）" }),
            el("td", { class: "mono", text: short(block.hash) }),
            el("td", { class: "mono", text: block.index === 0 ? "genesis" : `${block.nonce} · ${new Date(block.timestamp).toLocaleTimeString()}` }),
          ]
        )
      )
    )
  );
  host.replaceChildren(el("p", { class: "note", text: `共 ${chain.length} 块；高亮为链尖。每块的 Merkle root 只承诺了交易列表，改一笔交易 root 就变。` }), table);
}

function renderPicker() {
  const pick = $("pick");
  pick.replaceChildren(...nodes.map((url, i) => el("option", { value: String(i), text: url })));
  pick.value = String(selected);
  pick.onchange = () => {
    selected = Number(pick.value);
    renderChain();
  };
}

async function refresh() {
  statuses = await Promise.all(
    nodes.map(async (url) => {
      const { ok, body } = await api(url, "/status");
      return ok ? body : null;
    })
  );
  renderNodes();
  await renderChain();
}

$("refresh").addEventListener("click", refresh);
$("mine").addEventListener("click", async () => {
  const { body } = await api(nodes[selected], "/mine", { method: "POST" });
  await refresh();
  showResult(body.ok ? { 出块成功: body.block?.hash } : body);
});

$("send").addEventListener("click", async () => {
  const out = $("result");
  out.hidden = false;
  try {
    const wallet = await importPrivateKey(JSON.parse($("jwk").value.trim()));
    const tx = await createTx({
      wallet,
      to: $("to").value.trim(),
      value: Number($("value").value),
      fee: Number($("fee").value),
      nonce: Number($("nonce").value),
    });
    const { status, body } = await api(nodes[selected], "/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tx),
    });
    showResult({ HTTP: status, ...body, 签名者: wallet.address });
    await refresh();
  } catch (error) {
    showResult({ 失败: error.message });
  }
});

function showResult(payload) {
  const out = $("result");
  out.hidden = false;
  out.textContent = JSON.stringify(payload, null, 2);
}

setInterval(() => {
  if ($("autoplay").checked) refresh();
}, 2000);

renderPicker();
refresh().catch((error) => {
  $("consensus").replaceChildren(el("span", { class: "badge bad", text: `连不上节点：${error.message}｜先跑 node bin/network.mjs` }));
});
