// B07 权益管理台逻辑（ethers v6 UMD，无框架）
// 联盟网三条硬规矩在页面里同样成立：
//   1) 零 gas：gasPrice = 0 + legacy(type 0)
//   2) 成员账户余额为 0 → eth_estimateGas 会以「余额不足」失败 → **必须显式给 gasLimit**
//   3) 合约是 london 编译的，不要用 cancun 相关的工具链假设
//
// 钱包模型：联盟网没有 MetaMask（也不该有公网依赖），用**本地签名钱包**：
//   读走 JsonRpcProvider；写用 Wallet(privateKey, provider) 直接签名发交易。
//   注意：不能用 BrowserProvider(window.ethereum)——没有扩展时它会报 invalid EIP-1193 provider。
const { JsonRpcProvider, Wallet, Contract, formatEther } = window.ethers;

const CFG = window.B07_CONFIG || {};
let provider = null;
let signer = null;
let cred = null;
let me = null;

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(...a) {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(s);
}
const short = (a) => (a ? String(a).slice(0, 8) + "…" + String(a).slice(-4) : "-");

function txOverrides() {
  return { gasLimit: 8000000n, gasPrice: 0n, type: 0 };
}

// ethers v6 不接受相对 RPC URL（会报 unsupported protocol）→ 用同源代理的绝对地址
function rpcUrl() {
  return new URL(CFG.rpcUrl || CFG.rpcUrlDirect || "/rpc", location.href).href;
}

async function init() {
  $("k-rpc").textContent = CFG.rpcUrl || "-";
  $("k-cred").textContent = CFG.contract || "-";
  $("tag-net").textContent = "RPC " + (CFG.rpcUrl || "?");
  $("tag-cred").textContent = "凭证 " + (CFG.contract || "?");
  $("mint-base").value = CFG.ossBase || "http://127.0.0.1:8088/ipfs/";
  provider = new JsonRpcProvider(rpcUrl(), Number(CFG.chainId || 19880601));
  try {
    const net = await provider.getNetwork();
    $("k-chain").textContent = String(net.chainId) + " (0x" + net.chainId.toString(16) + ")";
    $("tag-chain").textContent = "chain " + net.chainId;
    $("tag-net").className = "pill on";
  } catch (e) {
    log("网络探测失败（RPC 未通？）：", e.shortMessage || e.message);
  }
}

async function connect() {
  const pk = $("pk").value.trim();
  if (!pk) return log("请先填私钥");
  try {
    provider = new JsonRpcProvider(rpcUrl(), Number(CFG.chainId || 19880601));
    signer = new Wallet(pk, provider);
    me = await signer.getAddress();
    $("k-me").textContent = me;
    $("tag-wallet").textContent = "已连接 " + short(me);
    $("tag-wallet").className = "pill on";
    const abi = await (await fetch("./abi.json")).json();
    cred = new Contract(CFG.contract, abi, signer);
    await refreshRole();
    log("钱包已连接：", me);
  } catch (e) {
    log("连接失败：", e.shortMessage || e.message);
  }
}

async function refreshRole() {
  if (!cred) return;
  const admin = await cred.DEFAULT_ADMIN_ROLE();
  const isAdmin = await cred.hasRole(admin, me);
  const isMinter = await cred.hasRole(await cred.MINTER_ROLE(), me);
  const isRedeemer = await cred.hasRole(await cred.REDEEMER_ROLE(), me);
  const roles = [];
  if (isAdmin) roles.push("管理员");
  if (isMinter) roles.push("发行方");
  if (isRedeemer) roles.push("核销方");
  $("k-role").textContent = roles.length ? roles.join(" / ") : "普通成员";
}

async function refreshMembers() {
  const box = $("members");
  box.innerHTML = "";
  try {
    const ids = await readMembersFromEvents();
    if (!ids.length) {
      box.innerHTML = '<span class="muted">暂无成员记录（发行方可用上方输入框登记）</span>';
      return;
    }
    for (const a of ids) {
      const on = await cred.isMember(a);
      const row = document.createElement("div");
      row.className = "row mono";
      row.style.gap = "8px";
      row.innerHTML = `<span>${a}</span><span class="pill ${on ? "on" : "off"}">${on ? "成员" : "已移除"}</span>`;
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<span class="bad">成员列表加载失败：${(e.shortMessage || e.message || "").slice(0, 120)}</span>`;
    log("成员列表加载失败：", e.shortMessage || e.message);
  }
}

// 成员名单从 MemberUpdated 事件里读（链上没有枚举接口）
// 注意：ethers v6 里事件不是 contract 上的函数，要用 interface.getEvent(name).topicHash
async function readMembersFromEvents() {
  const topic = cred.interface.getEvent("MemberUpdated").topicHash;
  const latest = BigInt(await provider.getBlockNumber()); // ethers v6 返回 number，与 bigint 混算会抛错
  const from = latest > 3000n ? latest - 3000n : 0n; // 节点对 getLogs 的区间有上限
  const logs = await provider.getLogs({ address: CFG.contract, topics: [topic], fromBlock: from, toBlock: "latest" });
  const set = new Map();
  for (const l of logs) {
    try {
      const p = cred.interface.parseLog(l);
      set.set(p.args.account, p.args.member);
    } catch (e) {}
  }
  return [...set.keys()];
}

async function loadCreds() {
  const tbody = $("creds");
  tbody.innerHTML = "";
  const nextId = Number(await cred.nextId());
  let shown = 0;
  const start = Math.max(0, nextId - 12);
  for (let id = start; id < nextId; id++) {
    let owner = "?";
    try {
      owner = await cred.ownerOf(id);
    } catch (e) {
      owner = "(已核销/已回收)";
    }
    let valid = "?";
    let until = "";
    try {
      valid = (await cred.isValid(id)) ? "有效" : "已过期";
      until = String(await cred.validUntil(id));
    } catch (e) {}
    let user = "-";
    try {
      user = await cred.userOf(id);
    } catch (e) {}
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${id}</td><td class="mono">${short(owner)}</td><td>${valid}</td><td class="mono">${short(user)}</td>`;
    const tdUri = document.createElement("td");
    const a = document.createElement("a");
    try {
      a.href = await cred.tokenURI(id);
      a.target = "_blank";
      a.textContent = "元数据";
      a.className = "mono";
    } catch (e) {
      a.textContent = "-";
    }
    tdUri.appendChild(a);
    tr.appendChild(tdUri);
    const tdAct = document.createElement("td");
    const b1 = document.createElement("button");
    b1.textContent = "转让";
    b1.onclick = () => doTransfer(id);
    const b2 = document.createElement("button");
    b2.textContent = "核销";
    b2.style.marginLeft = "6px";
    b2.onclick = () => doRedeem(id);
    tdAct.appendChild(b1);
    tdAct.appendChild(b2);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
    shown++;
  }
  $("cred-count").textContent = `共 ${nextId} 份（展示最后 ${shown} 份）`;
  await refreshMembers();
}

async function doTransfer(id) {
  const to = prompt("转让给（必须是在册成员）：");
  if (!to) return;
  try {
    const [allowed, reason] = await cred.checkTransfer(me, to, id);
    if (!allowed) {
      log("预检未通过，原因码：", reason);
      // 留痕：记录一次被拒的尝试（失败交易本身也在链上，status=0）
      const tx = await cred.recordBlockedTransfer(me, to, id, reason, txOverrides());
      await tx.wait();
      log("已写入审计流水");
      return;
    }
    const tx = await cred.transferFrom(me, to, id, txOverrides());
    const rec = await tx.wait();
    log("转让成功 gasUsed=", rec.gasUsed.toString());
    await loadCreds();
  } catch (e) {
    log("转让失败：", e.shortMessage || e.message);
  }
}

async function doRedeem(id) {
  try {
    const tx = await cred.redeem(id, txOverrides());
    const rec = await tx.wait();
    log("核销成功 gasUsed=", rec.gasUsed.toString());
    await loadCreds();
  } catch (e) {
    log("核销失败：", e.shortMessage || e.message);
  }
}

async function doMint() {
  try {
    const to = $("mint-to").value.trim();
    const count = Number($("mint-count").value || 1);
    const hours = Number($("mint-hours").value || 0);
    const root = $("mint-root").value.trim() || "0x" + "00".repeat(32);
    const validUntil = hours > 0 ? Math.floor(Date.now() / 1000) + hours * 3600 : 0;
    const tx = await cred.mintBatch(to, count, $("mint-base").value, root, validUntil, true, txOverrides());
    const rec = await tx.wait();
    log(`发行 ${count} 份成功 gasUsed=${rec.gasUsed}`);
    await loadCreds();
  } catch (e) {
    log("发行失败：", e.shortMessage || e.message);
  }
}

async function setMember(addr, member) {
  try {
    const tx = await cred.setMember(addr, member, txOverrides());
    const rec = await tx.wait();
    log(`成员${member ? "登记" : "移除"}成功：${addr} gasUsed=${rec.gasUsed}`);
    await refreshMembers();
  } catch (e) {
    log("操作失败：", e.shortMessage || e.message);
  }
}

async function loadAudit() {
  const tbody = $("audits");
  tbody.innerHTML = "";
  try {
    const n = Number(await cred.auditCount());
    const rows = [];
    for (let i = Math.max(1, n - 9); i <= n; i++) {
      const e = await cred.auditEntries(i);
      rows.push(`<tr><td>${i}</td><td class="mono">${short(e.actor)}</td><td class="mono">${short(e.from)}</td><td class="mono">${short(e.to)}</td><td>${e.tokenId}</td><td class="mono">${String(e.reason).slice(0, 12)}…</td></tr>`);
    }
    tbody.innerHTML = rows.join("");
    $("audit-count").textContent = `共 ${n} 条`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="bad">审计加载失败：${(e.shortMessage || e.message || "").slice(0, 120)}</td></tr>`;
    log("审计加载失败：", e.shortMessage || e.message);
  }
}

$("btn-connect").onclick = connect;
$("btn-refresh").onclick = () => loadCreds();
$("btn-load").onclick = () => loadCreds();
$("btn-mint").onclick = doMint;
$("btn-member").onclick = () => setMember($("member-addr").value.trim(), true);
$("btn-unmember").onclick = () => setMember($("member-addr").value.trim(), false);
$("btn-audit").onclick = loadAudit;
init();
log("管理台已就绪：先导入私钥连接，再加载凭证。联盟网零 gas，交易必须显式 gasLimit。");
