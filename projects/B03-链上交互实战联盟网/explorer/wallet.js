// B03 自建钱包页 · 零构建：ethers UMD（同目录本地文件） + fetch
// ethers JsonRpcProvider 不接受相对路径（报 unsupported protocol）→ 用绝对 URL；原生 fetch 两者皆可
const RPC = location.origin + "/b03-rpc/";
const FAUCET = "/b03-faucet/claim";
const CHAIN_ID = 19880601;
const $ = (id) => document.getElementById(id);

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
let wallet = null; // ethers.Wallet（连上 provider 后可直接发交易）

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kv = (pairs) => pairs.map(([k, v, cls = ""]) => `<div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>`).join("");
const short = (s, n = 16) => (s && s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

// ---------- 持久化（仅本机 localStorage） ----------
const LS_KEY = "b03_wallet";
const LS_WATCH = "b03_watch"; // 观察地址：看对方余额只需要地址，不需要对方私钥
let revealSecret = false; // 私钥/助记词默认不进 DOM
// 保存时一并存助记词：原先只存 privateKey，于是"生成新钱包"时拿到的 12 词种子
// 在刷新页面后永久变成"（导入的是裸私钥，无助记词）"——用户以为自己有备份，
// 实际界面上已经给不出来了。持钥边界没变（仍是本机明文），但可恢复性必须是真的。
function save(w) {
  localStorage.setItem(LS_KEY, JSON.stringify({ pk: w.privateKey, mnemonic: w.mnemonic?.phrase || null }));
  try { localStorage.setItem("b03_wallet_addr", w.address || ""); } catch {}
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    let pk = raw, phrase = null;
    if (raw.trim().startsWith("{")) { const o = JSON.parse(raw); pk = o.pk; phrase = o.mnemonic; }
    const fromPk = new ethers.Wallet(pk);
    // 校验对象是"由助记词推导出的地址"和"由私钥得到的地址"，两者相等才敢用助记词恢复。
    // 上一版这里写成了 ethers.getAddress(pk)——pk 是私钥不是地址，getAddress 直接抛错，
    // 被外层 catch 吞掉后表现为"助记词又没了"，而且静默降级成裸私钥钱包。
    if (phrase) {
      try { const w = ethers.Wallet.fromPhrase(phrase); if (w.address.toLowerCase() === fromPk.address.toLowerCase()) return w; } catch {}
    }
    return fromPk;
  } catch { return null; }
}
function wipe() {
  [LS_KEY, "b03_wallet_addr", "b03_to", "b03_last_tx", "b03_last_claim", LS_WATCH].forEach((k) => localStorage.removeItem(k));
  wallet = null; render();
}

const loadWatch = () => { try { return JSON.parse(localStorage.getItem(LS_WATCH)) || []; } catch { return []; } };
function addWatch(addr) {
  const list = loadWatch();
  const a = ethers.getAddress(addr); // 顺手规范成 EIP-55 校验和形式再存
  if (!list.includes(a)) { list.push(a); localStorage.setItem(LS_WATCH, JSON.stringify(list.slice(-12))); }
}

// 地址校验：格式之外还要看 EIP-55 校验和。
// 原实现只用 ethers.isAddress()，它只判 "0x + 40 位 hex"，大小写打错的地址照样通过——
// 联盟链上转错地址没人能帮忙找回，所以混合大小写且校验和不对时必须拦在签名之前。
function checkAddress(input) {
  const v = String(input || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { ok: false, error: "收款地址格式非法（需 0x + 40 位十六进制）" };
  const lower = v.toLowerCase(), upper = v.toUpperCase();
  if (v !== lower && v !== upper && ethers.getAddress(lower) !== v) {
    return { ok: false, error: `校验和不匹配（EIP-55）。地址里混用了大小写却对不上校验和，多半是复制/手敲错了一位。你给的可能是想用这个：${ethers.getAddress(lower)}` };
  }
  const canonical = ethers.getAddress(lower);
  return { ok: true, address: canonical, checksummed: v === canonical };
}

// ---------- 渲染 ----------
function renderWallet() {
  const el = $("walletInfo");
  if (!wallet) { el.innerHTML = `<div class="k">状态</div><div class="v warn">未生成 / 未导入 —— 先点「生成新钱包」</div>`; return; }
  try { localStorage.setItem("b03_wallet_addr", wallet.address); } catch {} // 供浏览器页流水线检测步骤状态
  const secretRow = revealSecret
    ? [["助记词", `<span class="secret">${esc(wallet.mnemonic?.phrase || "（导入的是裸私钥，无助记词）")}</span>`],
       ["私钥", `<span class="secret">${esc(wallet.privateKey)}</span>`]]
    : [["助记词 / 私钥", `<span class="note">已隐藏。明文出现在 DOM 里会被浏览器插件、页面存档、肩窥拿走——需要时点「显示私钥/助记词」</span>`]];
  el.innerHTML = kv([
    ["地址（收款地址）", `<span class="acc">${esc(wallet.address)}</span>`, "acc"],
    ...secretRow,
    ["链", `B03 服务器专属私链 · chainId ${CHAIN_ID} · 零 gas`],
  ]);
  $("btnUse").hidden = false;
  $("claimAddr").textContent = wallet.address;
  $("btnClaim").disabled = false;
  $("btnSend").disabled = false;
}

async function renderBal() {
  const el = $("bal");
  if (!wallet) return void (el.innerHTML = `<div class="k">余额</div><div class="v warn">连接钱包后查看</div>`);
  try {
    const [bal, nonce, bn, gpRaw] = await Promise.all([
      provider.getBalance(wallet.address),
      provider.getTransactionCount(wallet.address),
      provider.getBlockNumber(),
      fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      }).then((r) => r.json()).then((j) => BigInt(j.result)),
    ]);
    el.innerHTML = kv([
      ["余额", `${ethers.formatEther(bal)} B03（${bal} wei）`, "ok"],
      ["nonce（已发交易数）", String(nonce)],
      ["gasPrice", `${gpRaw} wei（本链恒 0）`],
      ["链头块高", `#${bn}`],
      ["自查浏览器", `<a class="hash" target="_blank" href="/b03/">${esc(location.origin)}/b03/</a> — 输入地址/交易哈希逐字段核对`],
    ]);
    $("dot").className = "dot on";
  } catch (e) {
    $("dot").className = "dot off";
    el.innerHTML = `<div class="k">错误</div><div class="v warn">${esc(e.message)}</div>`;
  }
}

function render() {
  renderWallet();
  renderBal();
  renderWatch();
}

// ---------- ⑤ 双向对账 ----------
// 这里的存在理由：原页面发完交易只回读**发送方自己**的余额，
// 于是"对方到底收到没有"在界面上永远没有答案，而用户唯一的补救办法是导入对方的钱包——
// 那会把 localStorage 里唯一的钱包键覆盖掉，于是连"我自己扣了多少"也一起看不见了。
// 看对方收到没有，本来只需要对方的**地址**，不需要对方的**私钥**。
async function renderWatch() {
  const el = $("watch");
  if (!el) return;
  const list = loadWatch();
  if (!list.length) { el.innerHTML = `<p class="note">暂无观察地址。加一个对方的地址（不需要其私钥），就能随时看它到账多少。</p>`; return; }
  const rows = await Promise.all(list.map(async (a) => {
    try {
      const [b, n] = await Promise.all([provider.getBalance(a), provider.getTransactionCount(a)]);
      return `<tr><td><span class="acc">${esc(a)}</span></td><td class="ok">${esc(fmtEth(b))} B03</td><td>${esc(String(n))}</td><td><a class="hash" href="/b03/?addr=${esc(a)}" target="_blank">链上查 →</a></td></tr>`;
    } catch (e) {
      return `<tr><td><span class="acc">${esc(a)}</span></td><td class="warn" colspan="3">读取失败：${esc(e.message)}</td></tr>`;
    }
  }));
  el.innerHTML = `<table><thead><tr><th>观察地址（只要地址即可核对）</th><th>余额</th><th>nonce</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const fmtEth = (w) => ethers.formatEther(w);

function reconVerdict(r) {
  const need = r.need;
  const dA = r.a0 - r.a1;      // 付款方减少量（本链零 gas，应恰等于面值）
  const dB = r.b1 - r.b0;      // 收款方增加量
  r.dA = dA; r.dB = dB;
  if (r.status !== 1) return { cls: "warn", text: `异常 —— 交易状态 0（回滚），价值没有移动` };
  // 自转账是合法操作：钱从 A 出、又回到 A，两侧净额为 0 是**预期结果**，不是故障。
  // 不加这条时，界面对一笔 status=1 的正常交易喊"两侧都没变化"并列出 4 条吓人的候选原因。
  const self = r.to && r.from && r.to.toLowerCase() === r.from.toLowerCase();
  if (self) {
    return dA === 0n && dB === 0n
      ? { cls: "ok", text: `自转账正常 —— 付款方与收款方是同一地址，两侧净额为 0 符合预期（价值没有离开你的账户）` }
      : { cls: "warn", text: `异常 —— 自转账本应净额为 0，实测付款方减 ${fmtEth(dA)}、收款方增 ${fmtEth(dB)}` };
  }
  if (dA === need && dB === need) return { cls: "ok", text: `对账通过 —— 付款方减少 ${fmtEth(need)}，收款方增加 ${fmtEth(need)}，两侧一致` };
  if (dA !== need && dB !== need) return { cls: "warn", text: `异常 —— 两侧都没变化：付款方减 ${fmtEth(dA)}、收款方增 ${fmtEth(dB)}。见下方候选原因` };
  if (dB !== need) return { cls: "warn", text: `异常 —— 付款方已扣 ${fmtEth(dA)}，但收款方只增 ${fmtEth(dB)}。请核对收款地址是否就是你要给的那个（已按 EIP-55 规范显示）` };
  return { cls: "warn", text: `异常 —— 收款方增了 ${fmtEth(dB)}，但付款方只减 ${fmtEth(dA)}（本链零 gas，理论上不应发生）` };
}

function showRecon(r) {
  const v = reconVerdict(r);
  const el = $("recon");
  // 判定行之外还要让明细行跟着同一个结论走：自转账时"应 0.1"和那 4 条候选原因
  // 会和上面"自转账正常"自相矛盾，等于一屏之内既说没事又说有事。
  const self = r.to && r.from && r.to.toLowerCase() === r.from.toLowerCase();
  const wantA = self ? 0n : r.need;
  const wantB = self ? 0n : r.need;
  const cell = (label, before, after, delta, want) => {
    const good = delta === want;
    return [label, `${fmtEth(before)} → <b>${fmtEth(after)}</b>　<span class="${good ? "ok" : "warn"}">${good ? "✓" : "✗"}变化 ${fmtEth(delta)}（应 ${fmtEth(want)}${self ? "，自转账净额为 0" : ""}）</span>`];
  };
  const anomaly = r.status === 1 && (r.dA !== wantA || r.dB !== wantB);
  el.innerHTML = kv([
    ["判定", `<span class="${v.cls}">${esc(v.text)}</span>`, v.cls],
    cell("付款方（你的钱包）", r.a0, r.a1, r.dA, wantA),
    cell("收款方", r.b0, r.b1, r.dB, wantB),
    ["交易", `<a class="hash" target="_blank" href="/b03/?tx=${esc(r.hash)}">${esc(r.hash)}</a> · 块 #${r.block} · status ${r.status} · gasUsed ${r.gasUsed}`],
    ["候选原因", anomaly
      ? `<span class="note">① 收款地址不是你以为的那个（本页已把地址规范成校验和形式，请核对）；② 你切到了另一个钱包，本页读的是当前钱包；③ 交易还卡在池中未入块（本链同 nonce 不会自动重发，需人工按 Runbook 处置）；④ 观察到的 RPC 落在尚未同步的节点上</span>`
      : `<span class="note">无</span>`],
  ]);
}

// ---------- 等待入块 / 链健康 ----------
// 本链目标 15s 出块，但机器内存吃紧时 QBFT 会整轮超时、round 连续递增，出块漂到分钟级。
// 2026-11-10 实测：水龙头被 nginx 以 504 掐断后，那笔领币交易仍在池里，约 40 秒后成功入块。
// 所以"等不到回执"绝不能写成"失败"——界面上必须把「没入块」和「入块但失败」分开说，
// 否则用户看到的就是"钱没到账"，而真实情况只是"链慢"。
async function waitMined(tx, ms = 150_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    // 用 provider.getTransactionReceipt，而不是 tx.getTransactionReceipt()——
    // ethers v6 的 TransactionResponse 上没有后者（只有 wait()/getReceipt()）。
    // 写成后者会让"已经广播成功"的交易在界面上报成"发送失败"，正是本文件要消灭的那类假失败。
    const rec = await provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (rec) return rec;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function chainHealth(addr) {
  try {
    const [head, wd] = await Promise.all([
      provider.getBlockNumber(),
      fetch("/b03-api/api/v1/watchdog").then((r) => r.json()).catch(() => null),
    ]);
    const stuck = wd && (wd.crit > 0 || wd.ticksWithoutGrowth >= 2);
    const out = { head, wd, stuck, note: wd ? (stuck ? `链高度停滞（${wd.ticksWithoutGrowth} 轮无增长）——交易大概率还在池里等出块` : "链在正常出块") : "看门狗不可用" };
    // 判断"还在不在池中"不用 txpool_*（本链公网只有一个 RPC 口，开 txpool 等于把全链待处理交易暴露到公网）。
    // 用 B04 已验证的等效信号：pending nonce > latest nonce 说明该账户仍有交易占着号。
    // 2026-11-10 实测到反向证据：三台协同重启后，一笔已广播未入块的交易从池中消失、
    // pending nonce 回落到 latest nonce —— 此时界面必须说"不在池中了、需要重新发起"，
    // 而不是继续说"还在等出块"，否则用户会一直等一笔已经不存在的交易。
    if (addr) {
      try {
        const [latest, pending] = await Promise.all([
          provider.getTransactionCount(addr, "latest"),
          provider.getTransactionCount(addr, "pending"),
        ]);
        out.inPool = pending > latest;
        out.note += out.inPool ? `；你的账户仍有待处理交易（nonce ${latest}→${pending}）` : `；该账户已无待处理交易（nonce ${latest}），先前那笔可能已离开交易池，需要重新发起`;
      } catch {}
    }
    return out;
  } catch (e) {
    return { head: null, stuck: null, note: "链健康读取失败：" + e.message };
  }
}

// 网关把长请求掐断时返回的是 nginx 的 HTML 错误页，不是 JSON。
// 原实现直接 r.json()，于是界面报 "Unexpected token '<'" —— 一句谁也都看不懂的话，
// 掩盖了真相：请求超时了，但操作可能已经成功。
async function postJson(url, body, timeoutMs = 100_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
  finally { clearTimeout(timer); }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON：按网关错误处理 */ }
  return { ok: r.ok && j !== null, status: r.status, j, text };
}
// 覆盖前拦截：本页只有 LS_KEY 一个钱包槽位，"生成新钱包/导入"会直接盖掉前一个。
// 若前一个在链上有钱或有历史，用户点一下就永久失去了它的私钥（内存里那份没点"使用此钱包"就不会落盘），
// 表现出来就是"我明明转过账，怎么这个钱包一分钱都没有"。
async function guardReplace(action) {
  if (!wallet) return true;
  let bal0 = 0n, nonce0 = 0n;
  try { [bal0, nonce0] = await Promise.all([provider.getBalance(wallet.address), provider.getTransactionCount(wallet.address)]); } catch {}
  if (bal0 === 0n && nonce0 === 0n) return true;
  return confirm(`${action}会覆盖当前钱包 ${wallet.address}（余额 ${fmtEth(bal0)} B03、nonce ${nonce0}）。`
    + `\n\n若你从未点过「使用此钱包（本机保存）」，它的私钥只存在于内存里，覆盖后无法找回。`
    + `\n\n确认继续？`);
}

$("btnCreate").onclick = async () => {
  if (!(await guardReplace("生成新钱包"))) return;
  wallet = ethers.Wallet.createRandom();
  revealSecret = false;
  render();
};
$("btnImport").onclick = async () => {
  const v = $("importKey").value.trim();
  if (!(await guardReplace("导入"))) return;
  try {
    wallet = v.split(" ").length >= 12
      ? ethers.Wallet.fromPhrase(v)
      : new ethers.Wallet(v);
    revealSecret = false;
    render();
  } catch (e) { alert("导入失败：" + e.message); }
};
$("btnUse").onclick = () => { save(wallet); render(); };
$("btnCopyAddr").onclick = async () => {
  if (!wallet) return alert("先生成或导入钱包");
  try { await navigator.clipboard.writeText(wallet.address); alert("地址已复制：" + wallet.address); }
  catch { prompt("复制下面的地址：", wallet.address); } // 非 https 环境 clipboard API 可能不可用
};
$("btnWipe").onclick = wipe;
$("btnRefresh").onclick = renderBal;

$("btnClaim").onclick = async () => {
  const out = $("claimOut");
  if (!wallet) return;
  out.innerHTML = `<div class="k">状态</div><div class="v">领币中…（本链出块可能很慢，最长等 100 秒）</div>`;
  try {
    const before = await provider.getBalance(wallet.address);
    const { ok, status, j, text } = await postJson(FAUCET, { address: wallet.address });

    if (!ok) {
      // 关键分支：网关超时/非 JSON 不代表没领到。用链上余额说话，而不是用 HTTP 状态说话。
      const h = await chainHealth(wallet.address);
      out.innerHTML = kv([
        ["结果", `<span class="warn">接口未正常返回（HTTP ${status || "超时"}）——${status === 504 ? "这是 nginx 掐断了还在等的请求" : esc((text || "").slice(0, 80))}</span>`, "warn"],
        ["但请注意", `这**不等于没领到**。以链上余额为准，正在复查…`, "warn"],
        ["链健康", esc(h.note) + `（当前高度 ${h.head ?? "?"}）`],
      ]);
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 6000));
        const after = await provider.getBalance(wallet.address);
        if (after > before) {
          out.innerHTML = kv([
            ["结果", `<span class="ok">接口报错了，但币确实到账：${fmtEth(before)} → ${fmtEth(after)} B03</span>`, "ok"],
            ["说明", `<span class="note">典型情形：水龙头已广播并等到入块，而网关在入块之前就超时返回了 504。以链上余额为准，不要被接口文案骗了。</span>`],
          ]);
          await renderBal();
          return;
        }
      }
      out.innerHTML = kv([
        ["结果", `<span class="warn">接口未正常返回，且 60 秒内链上余额未增加（${fmtEth(before)} B03）</span>`, "warn"],
        ["判断", esc(h.note)],
        ["下一步", `<span class="note">若链高度长期不涨，这是停链/出块停滞，不是水龙头的错；按运维 Runbook 处理，不要连续重点按钮（同 nonce 自动重发在联盟链上可能永远排不进）</span>`],
      ]);
      return;
    }

    try { localStorage.setItem("b03_last_claim", j.txHash); } catch {}
    // 衔接 B07 权益凭证：水龙头配置了 CREDENTIAL_URL 时，同一次领取会带回凭证信息
    const cred = j.credential;
    const credRows = [];
    if (cred && cred.ok) {
      credRows.push(["权益凭证", `<span class="ok">已发放 #${esc(String(cred.tokenId))}</span>`, "ok"]);
      credRows.push(["凭证交易", `<a class="hash" target="_blank" href="/b03/?tx=${esc(cred.txHash)}">${esc(cred.txHash)}</a>`, "acc"]);
      if (cred.metadataUri) {
        credRows.push(["凭证元数据", `<a class="hash" target="_blank" href="${esc(cred.metadataUri)}">${esc(cred.metadataUri)}</a><span class="note">（内网对象存储，链上只存哈希）</span>`, "acc"]);
      }
    } else if (cred && !cred.ok) {
      credRows.push(["权益凭证", `<span class="warn">未发放：${esc(String(cred.error || ""))}</span><span class="note">币已到账，凭证可稍后单独申领</span>`, "warn"]);
    }
    out.innerHTML = kv([
      ["结果", `领取 ${esc(String(j.amount))} B03 成功`, "ok"],
      ["交易哈希", `<a class="hash" target="_blank" href="/b03/?tx=${esc(j.txHash)}">${esc(j.txHash)}</a>（点击直达浏览器逐字段解析）`, "acc"],
      ["入块", `#${j.block} · QBFT 单块终结`, "ok"],
      ["付款方（水龙头额度合约）", esc(j.from)],
      ...credRows,
      ["说明", esc(j.note)],
    ]);
    await renderBal();
  } catch (e) {
    out.innerHTML = `<div class="k">失败</div><div class="v warn">${esc(e.message)}</div>`;
  }
};

$("btnSend").onclick = async () => {
  const out = $("txOut");
  if (!wallet) return;
  const rawTo = $("toAddr").value.trim();
  const amt = $("amt").value;
  // 记不记录"已广播"决定 catch 里能说哪句话。广播之后的任何异常都不能写成"交易没有发出"——
  // 本轮就因为一个方法名笔误，把一笔已经成功入块的转账报成了"发送失败"。
  let broadcast = null;
  try {
    const chk = checkAddress(rawTo);
    if (!chk.ok) throw new Error(chk.error);
    const to = chk.address;
    if (!chk.checksummed) throw new Error(`地址未含 EIP-55 校验和（全小写或全大写）。请确认无误后粘贴规范形式：${to}`);
    if (!(Number(amt) > 0)) throw new Error("转账金额必须大于 0");
    const need = ethers.parseEther(String(amt));

    // 转账前先取两侧余额：没有这组"前值"，之后任何对账都无从算起。
    const w = wallet.connect(provider);
    const [a0, b0] = await Promise.all([provider.getBalance(wallet.address), provider.getBalance(to)]);
    if (a0 < need) throw new Error(`余额不足：需要 ${fmtEth(need)} B03，当前 ${fmtEth(a0)}（本链零 gas 免的是手续费，不免本金）`);

    const tx = await w.sendTransaction({
      to,
      value: need,
      gasLimit: 21000n,
      // gasPrice 0（零 gas 链）；nonce 自动取链上值
    });
    broadcast = tx.hash;
    try { localStorage.setItem("b03_to", to); localStorage.setItem("b03_last_tx", tx.hash); addWatch(to); } catch {}
    // 先立即显示交易哈希（已广播），再等入块
    out.innerHTML = kv([
      ["状态", "已广播，等待入块…"],
      ["交易哈希", `<span class="acc">${esc(tx.hash)}</span>`, "acc"],
      ["收款方", `<span class="acc">${esc(to)}</span>`, "acc"],
      ["金额", `${esc(String(amt))} B03 · gasLimit 21000 · gasPrice 0`],
    ]);
    const rec = await waitMined(tx);
    if (!rec) {
      // 没等到回执 != 失败。交易多半在池里等出块；本链内存吃紧时出块会漂到分钟级。
      const h = await chainHealth(wallet.address);
      out.innerHTML = kv([
        ["状态", `<span class="warn">已广播、尚未入块（等了 150 秒）</span>`, "warn"],
        ["交易哈希", `<a class="hash" target="_blank" href="/b03/?tx=${esc(tx.hash)}">${esc(tx.hash)}</a>`, "acc"],
        ["链健康", `${esc(h.note)}（当前高度 ${h.head ?? "?"}）`],
        ["该怎么做", `<span class="note">不要重复点「签名并发送」：同 nonce 重复发在联盟链上可能永远排不进。等出块恢复后回本页刷新，或用下方「双向对账」直接看两侧余额。若长期停滞，按运维 Runbook 处置。</span>`],
      ]);
      $("recon").innerHTML = `<div class="k">双向对账</div><div class="v warn">尚未入块，两侧余额都不会变（这不是"钱丢了"，是"链还没处理"）</div>`;
      await renderWatch();
      return;
    }
    // 入块后再取两侧余额，把"对方收到了吗"变成屏幕上的一行判定，而不是一个要靠导入对方钱包去猜的问题。
    const [a1, b1] = await Promise.all([provider.getBalance(wallet.address), provider.getBalance(to)]);
    showRecon({ a0, a1, b0, b1, need, to, from: wallet.address, hash: tx.hash, block: rec.blockNumber, status: rec.status, gasUsed: rec.gasUsed });
    out.innerHTML = kv([
      ["结果", `转账 ${esc(String(amt))} B03 → ${short(to)} 已入块（到账与否看 ⑤ 双向对账）`, "ok"],
      ["交易哈希", `<a class="hash" target="_blank" href="/b03/?tx=${esc(tx.hash)}">${esc(tx.hash)}</a>（点击直达浏览器逐字段解析）`, "acc"],
      ["入块", `#${rec.blockNumber} · 状态 ${rec.status === 1 ? "1（成功）" : "0（失败）"} · gasUsed ${rec.gasUsed} · QBFT 单块终结`, "ok"],
      ["付款方", `<span class="acc">${esc(wallet.address)}</span>`, "acc"],
      ["收款方", `<span class="acc">${esc(to)}</span>`, "acc"],
    ]);
    await renderBal();
    await renderWatch();
  } catch (e) {
    if (broadcast) {
      // 已经广播出去了，后面的错是本页面的错，不是交易的错。如实说，并给出可自查的抓手。
      const h = await chainHealth(wallet.address);
      out.innerHTML = kv([
        ["状态", `<span class="warn">交易已广播（${esc(broadcast.slice(0, 18))}…），但本页在之后的步骤出错了</span>`, "warn"],
        ["页面错误", esc(e.message)],
        ["链健康", esc(h.note)],
        ["怎么办", `<span class="note">不要用同一个表单反复重发。把下面的哈希贴进浏览器逐字段核对，或直接看 ⑤ 双向对账的两侧余额。</span>`],
        ["查这笔", `<a class="hash" target="_blank" href="/b03/?tx=${esc(broadcast)}">${esc(broadcast)}</a>`],
      ]);
      await renderBal();
      await renderWatch();
      return;
    }
    out.innerHTML = `<div class="k">发送失败</div><div class="v warn">${esc(e.shortMessage || e.message)}</div>`;
    $("recon").innerHTML = `<div class="k">双向对账</div><div class="v note">未执行（交易确实没有发出，两侧余额都不会变）</div>`;
  }
};

$("btnShowPriv").onclick = () => {
  revealSecret = !revealSecret;
  $("btnShowPriv").textContent = revealSecret ? "隐藏私钥/助记词" : "显示私钥/助记词";
  renderWallet();
  if (revealSecret) setTimeout(() => { if (revealSecret) { revealSecret = false; $("btnShowPriv").textContent = "显示私钥/助记词"; renderWallet(); } }, 20000);
};

$("btnWatch").onclick = async () => {
  const chk = checkAddress($("watchAddr").value);
  if (!chk.ok) return alert(chk.error);
  addWatch(chk.address); $("watchAddr").value = "";
  await renderWatch();
};
$("btnWatchRefresh").onclick = renderWatch;

// 恢复上次保存的钱包
wallet = load();
render();
setInterval(renderBal, 6000);
