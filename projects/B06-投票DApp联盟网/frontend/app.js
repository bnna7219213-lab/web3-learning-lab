// B06 审批台前端（零构建）：成员切换 + 提案 + 复核/驳回/撤销/执行。
// 所有交易由 BFF 代签（显式 gasPrice=0/type=0），前端不碰私钥、不依赖钱包扩展。
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (a) => (a ? esc(a.slice(0, 6) + "…" + a.slice(-4)) : "-");

let cfg = null;
let current = "A";

const toast = (msg, ok = true) => {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${ok ? "ok" : "err"}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 6000);
};

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return r.json();
}

function renderMembers() {
  $("#members").innerHTML = Object.entries(cfg.members)
    .map(
      ([k, m]) => `<button data-m="${k}" class="member ${k === current ? "active" : ""}">
        <div class="mname">${esc(m.label)}</div><div class="maddr">${short(m.address)}</div>
      </button>`
    )
    .join("");
  document.querySelectorAll(".member").forEach((b) =>
    b.addEventListener("click", () => {
      current = b.dataset.m;
      renderMembers();
      renderProposals();
    })
  );
}

function actionsFor(p) {
  const isProposer = cfg.members[current] && p.proposer.toLowerCase() === cfg.members[current].address.toLowerCase();
  const canReview = current === "A" || current === "B";
  const canExec = current === "admin";
  const canPropose = current === "A" || current === "B";
  const list = [];
  if (p.state === "Pending" && canReview && !isProposer) list.push(["approve", "复核通过"], ["reject", "驳回"]);
  if (p.state === "Approved" && isProposer) list.push(["revoke", "撤回（窗口内）"]);
  if (p.state === "Approved" && canExec) list.push(["execute", "执行"]);
  if (p.state === "Pending" && canReview && isProposer) list.push(["approve", "复核自己的（演示被拒）"]);
  return list;
}

async function renderProposals() {
  const j = await api("/api/proposals");
  if (!j.ok) return;
  $("#proposals tbody").innerHTML = j.data
    .map((p) => {
      const acts = actionsFor(p)
        .map(([a, label]) => `<button class="act" data-id="${p.id}" data-a="${a}">${label}</button>`)
        .join(" ");
      return `<tr>
        <td>${p.id}</td>
        <td>${esc(p.title)}</td>
        <td title="${esc(p.proposer)}">${short(p.proposer)}</td>
        <td title="${esc(p.reviewer)}">${short(p.reviewer)}</td>
        <td><span class="st st-${p.state}">${p.state}</span></td>
        <td>${p.executeAfter ? new Date(p.executeAfter * 1000).toLocaleTimeString() : "-"}</td>
        <td>${acts}</td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll(".act").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = await api("/api/act", { member: current, action: b.dataset.a, id: b.dataset.id, reason: "材料不全" });
      if (r.ok) toast(`✔ ${b.dataset.a} #${b.dataset.id} 成功（${r.txHash.slice(0, 12)}…）`);
      else toast(`✘ ${b.dataset.a} 被拒：${r.reason || "status=" + r.status}`, false);
      renderProposals();
    })
  );
}

$("#proposeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api("/api/act", {
    member: current,
    action: "propose",
    title: f.get("title"),
    target: f.get("target") || undefined,
    value: f.get("value") || "0",
    data: f.get("data") || "0x",
  });
  if (r.ok) toast(`✔ 提案成功（${r.txHash.slice(0, 12)}…）`);
  else toast(`✘ 提案被拒：${r.reason || "status=" + r.status}`, false);
  renderProposals();
});

(async function init() {
  cfg = await api("/api/config");
  $("#meta").textContent = `合约 ${cfg.contract} · 生效延迟 ${cfg.delaySeconds}s · 当前身份加载中`;
  renderMembers();
  await renderProposals();
  setInterval(renderProposals, 5000);
})();
