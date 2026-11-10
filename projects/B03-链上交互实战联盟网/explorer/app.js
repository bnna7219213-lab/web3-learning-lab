// B03 联盟链浏览器 · 零依赖：只用 fetch 直连 JSON-RPC（经 nginx /b03-rpc/ 反代，同源无 CORS）
const RPC = document.getElementById("rpcUrl").value;
const $ = (id) => document.getElementById(id);

// ---------- RPC ----------
async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code ?? ""} ${j.error.message ?? ""}`.trim());
  return j.result;
}

// ---------- 索引器查询 API（b03-indexer / SQLite，同源 /b03-api/）----------
const API = "/b03-api";
async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  return r.json();
}

// ---------- 解码素材 ----------
// 4 字节选择器：P03 知识点「input 拆成 selector + 参数」
const SELECTORS = {
  "0xa9059cbb": ["transfer(address,uint256)", "to:address / value:uint256（按 32 字节词切分）"],
  "0x095ea7b3": ["approve(address,uint256)", "spender:address / value:uint256"],
  "0x23b872dd": ["transferFrom(address,address,uint256)", "from / to / value"],
  "0x70a08231": ["balanceOf(address)", "owner:address"],
  "0x18160ddd": ["totalSupply()", "无参数"],
  "0xdd62ed3e": ["allowance(address,address)", "owner / spender"],
  "0x40c10f19": ["mint(address,uint256)", "to / value"],
  "0x42966c68": ["burn(uint256)", "value"],
  "0x3ccfd60b": ["withdraw()", "无参数"],
  "0xd0e30db0": ["deposit()", "无参数"],
  "0x6a42cb71": ["支持的写入函数（未知）", "见 ABI"],
  "0x": ["空 input（原生转账）", "无 calldata"],
};
// 事件 topic0：logs 逐字段解析
const TOPICS = {
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef":
    ["Transfer(address indexed from, address indexed to, uint256 value)", "topic1=from topic2=to data=value"],
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925":
    ["Approval(address indexed owner, address indexed spender, uint256 value)", "topic1=owner topic2=spender data=value"],
};

const hex = (n) => "0x" + BigInt(n).toString(16);
const dec = (h) => (h ? BigInt(h).toString(10) : "0");
const short = (s, n = 14) => (s && s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function kv(pairs) {
  return pairs
    .map(([k, v, cls = ""]) => `<div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>`)
    .join("");
}
function timeOf(hexTs) {
  const t = typeof hexTs === "number" ? hexTs * 1000 : Number(BigInt(hexTs)) * 1000;
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

// ---------- 顶部状态 ----------
async function stats() {
  const [bn, gp, peers, vals] = await Promise.all([
    rpc("eth_blockNumber"), rpc("eth_gasPrice"), rpc("net_peerCount"),
    rpc("qbft_getValidatorsByBlockNumber", ["latest"]).catch(() => null),
  ]);
  const b = await rpc("eth_getBlockByNumber", [bn, false]);
  $("s_block").textContent = hex(bn) + "（十进制 " + dec(bn) + "）";
  $("s_gas").textContent = dec(gp) + " wei";
  $("s_base").textContent = dec(b.baseFeePerGas) + " wei";
  $("s_peers").textContent = dec(peers);
  // qbft_getValidatorsByBlockNumber 返回的是**验证者集合**（由 genesis/投票决定，恒为 4），
  // 不是"几台在跑"。早先这里写成"N 个在线"，在只剩 3 台时直接误导排障（2026-10-16）。
  // 在线台数只能逐节点探（/api/v1/nodes），见 topology()。
  $("s_vals").textContent = vals ? `${vals.length} 个（集合）` : "—";
  $("chainIdBadge").textContent = String(await rpc("eth_chainId").then(Number));
  $("dot").className = "dot on";
  if (vals) {
    $("validators").innerHTML = kv(
      vals.map((v, i) => [`验证者 ${i + 1}`, `<span class="acc">${esc(v)}</span>`, "acc"])
    );
  }
}

// ---------- 拓扑真实化：在线几台 / quorum / 容错余量 / gasPrice 漂移 ----------
async function topology() {
  const q = $("valQuorum");
  if (!q) return;
  try {
    const n = await api("/api/v1/nodes");
    const spare = n.faultTolerance;
    const cls = !n.healthy ? "topo bad" : spare === 0 ? "topo warn" : "topo ok";
    q.innerHTML = `<span class="${cls}" title="在线 ${n.online}/${n.total} · 高度差 ${n.heightSpread} 块">` +
      `集合 ${n.validatorsExpected} · 在线 ${n.online} · quorum ${n.quorum} · ` +
      `还能再挂 ${spare} 台</span>` +
      (n.gasPriceDriftNodes.length
        ? `<div class="topo bad">⚠ ${esc(n.gasPriceDriftNodes.join(", "))} 的 min-gas-price ≠ 0，会静默丢弃零 gas 交易</div>`
        : "");
    $("s_online").textContent = `${n.online}/${n.total}`;
  } catch {
    // 索引器不可用时不假装知道在线数——宁可显示"未知"也不要给出错的结论
    q.textContent = "在线数未知（索引器探针不可用）";
    $("s_online").textContent = "未知";
  }
}

// ---------- 区块列表（走索引器 API，支持分页） ----------
let blocksPage = 1;
async function blocks() {
  try {
    const d = await api(`/api/v1/blocks?page=${blocksPage}&limit=15`);
    const rows = d.items.map((b) => `<tr data-block="${hex(b.number)}">
      <td>#${dec(b.number)}</td>
      <td>${timeOf("0x" + b.timestamp.toString(16))}</td>
      <td>${b.tx_count}</td>
      <td>${b.gas_used}</td>
      <td><span class="hash">${short(b.hash)}</span></td></tr>`).join("");
    $("blocks").querySelector("tbody").innerHTML = rows;
    $("blocks").querySelectorAll("tr").forEach((tr) =>
      tr.addEventListener("click", () => show(tr.dataset.block))
    );
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const nav = $("blocksNav");
    if (nav) nav.innerHTML = `
      <button class="blkPage" data-page="${blocksPage - 1}" ${blocksPage <= 1 ? "disabled" : ""}>← 上一页</button>
      <span class="note">第 ${blocksPage}/${pages} 页 · 共 ${d.total} 块</span>
      <button class="blkPage" data-page="${blocksPage + 1}" ${blocksPage >= pages ? "disabled" : ""}>下一页 →</button>`;
    nav?.querySelectorAll(".blkPage").forEach((btn) =>
      btn.addEventListener("click", () => { blocksPage = Number(btn.dataset.page); blocks(); }));
  } catch (e) {
    // 索引器不可用时降级到 RPC 直查最近 10 块（保住浏览器基本可用）
    const bn = BigInt(await rpc("eth_blockNumber"));
    const rows = [];
    for (let i = 0n; i < 10n && bn - i >= 0n; i++) {
      const b = await rpc("eth_getBlockByNumber", [hex(bn - i), false]);
      rows.push(`<tr data-block="${hex(bn - i)}">
        <td>#${dec(bn - i)}</td>
        <td>${timeOf(b.timestamp)}</td>
        <td>${BigInt(b.transactions.length)}</td>
        <td>${dec(b.gasUsed)}</td>
        <td><span class="hash">${short(b.hash)}</span></td></tr>`);
    }
    $("blocks").querySelector("tbody").innerHTML = rows.join("");
    $("blocks").querySelectorAll("tr").forEach((tr) =>
      tr.addEventListener("click", () => show(tr.dataset.block))
    );
  }
}

// ---------- 逐字段解析：交易 ----------
async function showTx(hash) {
  const [tx, rec] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]),
    rpc("eth_getTransactionReceipt", [hash]),
  ]);
  if (!tx) return $("detail").innerHTML = `<div class="empty">交易不存在或尚未被收录：${esc(hash)}</div>`;

  const input = tx.input || "0x";
  const sel = input.slice(0, 10);
  const [sig, argsNote] = SELECTORS[sel] ?? [`未知选择器 ${sel}`, "按 32 字节词切分，需 ABI 才能命名"];
  const status = rec?.status === "0x1" ? `<span class="tag ok">成功</span>` : `<span class="tag warn">失败</span>`;
  const block = await rpc("eth_getBlockByNumber", [tx.blockNumber, false]);
  const confirmNote =
    `QBFT 单块终结：该块被 4 个验证者中 ≥3（quorum）签过即最终，` +
    // 同一页里同一个块号一会儿十六进制一会儿十进制，用户没法对照（尤其列表用 #十进制）。
    // 统一成"十进制为主、十六进制括注"。
    `无需等待 N 个确认。当前链头 #${dec(await rpc("eth_blockNumber"))}，` +
    `本交易所在块 #${dec(tx.blockNumber)} 与链头相差 ` +
    `${Number(BigInt(await rpc("eth_blockNumber")) - BigInt(tx.blockNumber))} 块（仅表示进度，不是"未终结"）。`;

  $("detail").innerHTML = kv([
    ["交易哈希", `<span class="acc">${esc(hash)}</span>`, "acc"],
    ["状态", status],
    ["所在区块", `<a class="hash" href="#${esc(tx.blockNumber)}" data-block="${esc(tx.blockNumber)}">#${dec(tx.blockNumber)}</a>（${hex(tx.blockNumber)}） · ${timeOf(block.timestamp)}`],
    ["区块哈希", esc(tx.blockHash)],
    ["from", esc(tx.from), "acc"],
    ["to", tx.to ? esc(tx.to) : "（合约创建，空）", "acc"],
    ["nonce", `${dec(tx.nonce)}（该账户发出的第 ${Number(dec(tx.nonce)) + 1} 笔，多成员并发靠它互不干扰）`],
    // 详情里只给 wei、列表里只给 B03，用户得自己除 1e18 才能对照——两边都补齐。
    ["value", `${dec(tx.value)} wei（${weiUnit(tx.value)} B03）`],
    ["gas 限额", dec(tx.gas)],
    ["gasPrice", `${dec(tx.gasPrice)} wei（本链零 gas：值应为 0）`],
    ["maxFeePerGas", tx.maxFeePerGas ? dec(tx.maxFeePerGas) : "—"],
    ["input 字节", `${(input.length - 2) / 2} 字节`],
    ["· 4 字节选择器", `<span class="warn">${esc(sel)}</span> → ${esc(sig)}`, "warn"],
    ["· 参数说明", esc(argsNote)],
    ["· input 原文", `<span style="color:var(--dim)">${esc(short(input, 40))}</span>`],
    ["交易类型", tx.type ? hex(tx.type) : "0x0（Legacy）"],
    ["v / r / s", `${tx.v}<br/>${esc(short(tx.r, 20))}<br/>${esc(short(tx.s, 20))}<br/><span style="color:var(--dim)">签名恢复出的地址必须等于 from</span>`],
    ["回执 · 成功", rec?.status === "0x1" ? "是" : "否"],
    ["回执 · gasUsed", `${dec(rec.gasUsed)}（零 gas 链上不扣费，但字段照常有值）`],
    ["回执 · 合约地址", rec.contractAddress ? esc(rec.contractAddress) : "—"],
    ["回执 · 日志数", String(rec.logs.length)],
    ["终结性", esc(confirmNote)],
    ...(rec.logs.length ? parseLogs(rec.logs) : [["日志", "无（纯转账或未触发事件）"]]),
  ]);

  $("detail").querySelectorAll("[data-block]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); show(a.dataset.block); })
  );
}

function parseLogs(logs) {
  const out = [];
  logs.forEach((l, i) => {
    const [sig, note] = TOPICS[l.topics[0]] ?? [`未知事件 topic0`, "需 ABI 才能解名"];
    out.push([`日志 ${i + 1} · 地址`, esc(l.address), "acc"]);
    out.push([`日志 ${i + 1} · 事件`, esc(sig)]);
    out.push([`日志 ${i + 1} · topics(${l.topics.length})`, l.topics.map((t, j) => `topic${j}: ${esc(t)}`).join("<br/>")]);
    out.push([`日志 ${i + 1} · data`, `${esc(l.data)}<br/><span style="color:var(--dim)">→ ${esc(note)}</span>`]);
  });
  return out;
}

// ---------- 逐字段解析：区块 ----------
async function showBlock(tag) {
  const b = await rpc("eth_getBlockByNumber", [tag, false]).catch(() => null) ??
            (await rpc("eth_getBlockByHash", [tag, false]));
  if (!b) return $("detail").innerHTML = `<div class="empty">区块不存在：${esc(tag)}</div>`;
  const vals = await rpc("qbft_getValidatorsByBlockNumber", [tag]).catch(() => null);
  $("detail").innerHTML = kv([
    ["区块号", "#" + dec(b.number) + "（" + hex(b.number) + "）"],
    ["区块哈希", esc(b.hash), "acc"],
    ["父块哈希", esc(b.parentHash)],
    ["时间戳", `${hex(b.timestamp)} → ${timeOf(b.timestamp)}`],
    ["出块间隔", `${dec(b.difficulty)}（QBFT：难度恒 0/1，出块由 blockperiodseconds=5 驱动）`],
    ["共识", `QBFT · mixHash=<span style="color:var(--dim)">${esc(b.mixHash)}</span>`],
    ["验证者", vals ? vals.length + " 个" : "—"],
    ["交易数", String(b.transactions.length)],
    ["gasLimit", dec(b.gasLimit)],
    ["gasUsed", dec(b.gasUsed)],
    ["baseFeePerGas", `${dec(b.baseFeePerGas)} wei（零 gas 链：恒 0）`],
    ["nonce", esc(b.nonce)],
    ["extraData", esc(short(b.extraData, 40))],
    ["stateRoot", esc(b.stateRoot)],
    ["transactionsRoot", esc(b.transactionsRoot)],
    ["receiptsRoot", esc(b.receiptsRoot)],
    ["miner/coinbase", esc(b.miner)],
    ...(b.transactions.length
      ? [["交易列表", b.transactions.map((h) => `<a class="hash tx" href="#" data-tx="${esc(h)}">${esc(short(h, 18))}</a>`).join("<br/>")]]
      : [["交易列表", "本块无交易"]]),
  ]);
  $("detail").querySelectorAll("[data-tx]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); show(a.dataset.tx); })
  );
}

// ---------- 逐字段解析：地址（余额/nonce + 索引器交易历史） ----------
async function showAddress(addr) {
  const [bal, nonce, bn, code] = await Promise.all([
    rpc("eth_getBalance", [addr, "latest"]),
    rpc("eth_getTransactionCount", [addr, "latest"]),
    rpc("eth_blockNumber"),
    rpc("eth_getCode", [addr, "latest"]).catch(() => "0x"),
  ]);
  const isContract = code && code !== "0x";
  const b = await rpc("eth_getBlockByNumber", [hex(bn), false]);
  $("detail").innerHTML = kv([
    ["地址", `<span class="acc">${esc(addr)}</span>`, "acc"],
    ["类型", `<div id="tokenBadge">检测中…</div>`],
    ["余额", `${dec(bal)} wei（${weiUnit(bal)} B03 · 本链零 gas，余额仅用于资产语义）`, "ok"],
    ["nonce（已发交易数）", dec(nonce)],
    ["当前链头", `#${dec(bn)} · ${timeOf(b.timestamp)}`],
    ...(isContract ? [["runtime 字节码", `${(code.length - 2) / 2} 字节 · keccak=<span class="hash">${esc(short(keccakLike(code), 18))}</span>
      <span style="color:var(--dim)">（本页现算，与登记表独立）</span>`]] : []),
    ["交易历史", `<div id="addrHist">加载中…</div>`],
    ...(isContract ? [["源码登记与指纹自证", `<div id="contractReg">加载中…</div>`]] : []),
    ["多节点一致性", `<div id="addrConsistency">检测中…</div>`],
  ]);
  renderAddrHistory(addr, "all", 1);
  renderConsistency(addr);
  if (isContract) renderContractReg(addr);
  // 搜索增强：若该地址是已索引的 ERC-20 合约，附代币元数据
  api("/api/v1/tokens").then((t) => {
    const tok = (t.items || []).find((x) => x.address === addr.toLowerCase());
    const box = $("tokenBadge");
    if (!box) return;
    if (tok) {
      box.innerHTML = `<span class="tag ok">ERC-20 代币合约</span> ${esc(tok.name || "?")} · ${esc(tok.symbol || "?")} · decimals ${tok.decimals ?? "?"} · 供应量 ${tok.total_supply ? Number(tok.total_supply) / 10 ** (tok.decimals ?? 18) : "?"}`;
    } else if (isContract) {
      box.innerHTML = `<span class="tag">智能合约</span> <span class="note">有字节码但非 ERC-20（无 Transfer 事件索引）</span>`;
    } else {
      box.innerHTML = `<span class="note">外部账户（EOA）· 链上无字节码</span>`;
    }
  }).catch(() => {});
}

// 浏览器里没有 keccak。这里只做"长度+首尾"的弱指纹用于肉眼对照，
// 真正的 keccak 由索引器（ethers）算、由客户用 cast 独立算——三者独立，不拿这个当证明。
const keccakLike = (h) => `len${(h.length - 2) / 2}B:${h.slice(0, 10)}…${h.slice(-8)}`;

// 跨节点一致性自动核验：原来这行字是"请你自己在 4 个节点分别查"——把验收动作推给客户。
async function renderConsistency(addr) {
  const box = $("addrConsistency");
  if (!box) return;
  try {
    const c = await api(`/api/v1/consistency/${addr}`);
    const rows = c.nodes.map((n) => `<tr><td>${esc(n.url.replace(/^https?:\/\//, ""))}</td><td>${
      n.ok ? `<span class="tag ok">一致</span> ${n.balance ? weiUnit(n.balance) : "0"} B03 · nonce ${n.nonce}`
           : `<span class="tag bad">不可达</span> <span class="note">${esc(n.error || "")}</span>`}</td></tr>`).join("");
    box.innerHTML = `<table><tbody>${rows}</tbody></table>` +
      (c.agree && c.checked >= c.topology.quorum
        // 措辞刻意避开 "3/4 一致"——那会被读成"4 台里有 1 台不一致"，而实际是 3 台可比对、1 台根本没在跑
        ? `<div class="tag ok">已比对 ${c.checked} 个可达节点，余额与 nonce 完全一致${c.nodes.length - c.checked ? `（另 ${c.nodes.length - c.checked} 台不可达）` : ""}</div>
           <div class="note">QBFT 单块终结：各节点状态由共识确定，不一致意味着某台在追块或已脱队。</div>`
        : `<div class="tag bad">一致性未通过（可比对 ${c.checked} 台，quorum ${c.topology.quorum}）</div>`);
  } catch (e) {
    box.innerHTML = `<span class="note">索引器探针不可用：${esc(e.message)}</span>`;
  }
}

// 源码登记 + 指纹自证：替代公网 Etherscan 的 Verify Contract
async function renderContractReg(addr) {
  const box = $("contractReg");
  if (!box) return;
  try {
    const c = await api(`/api/v1/contract/${addr}`);
    const badge = c.verified === 1 ? `<span class="tag ok">已登记源码</span>`
      : c.verified === 2 ? `<span class="tag bad">登记指纹不一致</span>`
      : `<span class="tag">仅链上事实（未登记源码）</span>`;
    box.innerHTML = kv([
      ["状态", badge],
      ["合约名", esc(c.name || "—")],
      ["部署者", esc(c.creator || "—")],
      ["部署交易", `<span class="hash">${esc(c.deploy_tx || "—")}</span>`],
      ["所在区块", c.block_number ?? "—"],
      ["runtime 指纹（索引器实测）", `<span class="hash">${esc(c.deployed_hash || "—")}</span>`],
      ["源码指纹（登记方主张）", `<span class="hash">${esc(c.source_hash || "—")}</span>`],
      ["git commit", esc(c.git_commit || "—")],
      ["ABI", c.abi ? `${c.abi.length} 项` : "未登记"],
      ["你如何独立复核", `<div class="note">不要信任本页面。任选一个节点执行下面命令，比对结果是否等于上面的 runtime 指纹：</div>
        <pre class="cmd">cast code --rpc-url &lt;联盟网RPC&gt; ${esc(addr)} | xxd -r -p | cast keccak</pre>
        <div class="note">期望值：<code>${esc(c.deployed_hash || "—")}</code><br/>
        源码一致性：按登记的 git_commit 检出同一份源码自行编译，再比 runtime 字节码。</div>`],
    ]);
  } catch (e) {
    box.innerHTML = `<span class="note">该合约尚未登记（${esc(e.message)}）。登记方式：在服务器上跑
      <code>node register.js --addr ${esc(addr)} --name &lt;名&gt; --source &lt;xx.sol&gt; --git-commit &lt;sha&gt;</code></span>`;
  }
}

// 地址交易历史（走索引器 /b03-api/，支持收/发/全部过滤 + 翻页）
async function renderAddrHistory(addr, direction, page) {
  const box = $("addrHist");
  if (!box) return;
  try {
    const d = await api(`/api/v1/address/${addr}/txs?direction=${direction}&page=${page}&limit=10`);
    const rows = d.items.map((t) => `<tr data-tx="${esc(t.hash)}">
      <td><span class="hash">${esc(short(t.hash, 10))}</span></td>
      <td>#${t.block_number}</td>
      <td>${t.dir === "out" ? '<span class="tag warn">出</span>' : '<span class="tag ok">入</span>'}</td>
      <td>${esc(short(t.from_addr, 8))}</td>
      <td>${t.to_addr ? esc(short(t.to_addr, 8)) : "（合约创建）"}</td>
      <td title="${esc(String(t.value))} wei">${weiUnit(t.value)} B03</td>
      <td>${t.status === 1 ? '<span class="tag ok">成功</span>' : '<span class="tag warn">失败</span>'}</td>
    </tr>`).join("");
    const total = d.total, pages = Math.max(1, Math.ceil(total / d.limit));
    box.innerHTML = `
      <div class="row" style="margin:0 0 8px">
        <button class="histDir ${direction === "all" ? "primary" : ""}" data-dir="all">全部</button>
        <button class="histDir ${direction === "in" ? "primary" : ""}" data-dir="in">转入</button>
        <button class="histDir ${direction === "out" ? "primary" : ""}" data-dir="out">转出</button>
        <span class="note" style="margin-left:auto">共 ${total} 笔 · 第 ${page}/${pages} 页</span>
      </div>
      <table><thead><tr><th>哈希</th><th>区块</th><th>方向</th><th>from</th><th>to</th><th>金额</th><th>状态</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">本页无记录</td></tr>'}</tbody></table>
      <div class="row" style="margin-top:8px">
        <button class="histPage" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>← 上一页</button>
        <button class="histPage" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页 →</button>
      </div>`;
    box.querySelectorAll(".histDir").forEach((btn) =>
      btn.addEventListener("click", () => renderAddrHistory(addr, btn.dataset.dir, 1)));
    box.querySelectorAll(".histPage").forEach((btn) =>
      btn.addEventListener("click", () => renderAddrHistory(addr, direction, Number(btn.dataset.page))));
    box.querySelectorAll("[data-tx]").forEach((tr) =>
      tr.addEventListener("click", () => show(tr.dataset.tx)));
  } catch (e) {
    box.innerHTML = `<span class="warn">交易历史加载失败：${esc(e.message)}（索引器可能仍在追赶，稍后刷新）</span>`;
  }
}

// ---------- 钱包操作流水线（6 步指引，状态由 localStorage 标记 + 链上数据实时检测） ----------
const LS = { W: "b03_wallet", ADDR: "b03_wallet_addr", TO: "b03_to", TX: "b03_last_tx", CLAIM: "b03_last_claim" };

async function pipeline() {
  const addr = localStorage.getItem(LS.ADDR);
  const hasWallet = !!localStorage.getItem(LS.W) || !!addr;
  const to = localStorage.getItem(LS.TO);
  const lastTx = localStorage.getItem(LS.TX);
  const lastClaim = localStorage.getItem(LS.CLAIM);
  const anyHash = lastTx || lastClaim;   // 领币哈希也能逐字段解析，第 6 步不必非等发出交易
  let bal = 0n, nonce = 0n;
  if (addr) {
    [bal, nonce] = await Promise.all([
      rpc("eth_getBalance", [addr, "latest"]).then(BigInt),
      rpc("eth_getTransactionCount", [addr, "latest"]).then(BigInt),
    ]);
  }
  const fmtBal = (b) => weiUnit(b);

  const steps = [
    { t: "创建私有钱包", d: "在钱包页本地生成 secp256k1 密钥对——纯计算不联网，私钥只存本机浏览器",
      done: hasWallet, st: hasWallet ? "已生成" : "未创建", a: "wallet.html#secCreate", al: "打开钱包页 →" },
    { t: "提取地址", d: "复制 0x…40 位收款地址，这就是你在本链的身份",
      done: !!addr, st: addr ? short(addr, 6) : "待提取", a: "wallet.html#secCreate", al: "去复制地址 →" },
    { t: "领取币", d: "水龙头 POST /b03-faucet/claim：每次 10 B03，每地址 60s 冷却，币来自本链运营方",
      done: bal > 0n, st: bal > 0n ? `余额 ${fmtBal(bal)} B03` : "余额 0", a: "wallet.html#secClaim", al: "去领币 →" },
    { t: "填入收款地址", d: "在发交易区粘贴对方 0x 地址并填金额（校验：40 位 hex + 金额>0）",
      done: !!to, st: to ? `→ ${short(to, 6)}` : "未填写", a: "wallet.html#secSend", al: "去填写 →" },
    { t: "发起交易", d: "客户端私钥签名 → eth_sendRawTransaction，5s 出块、QBFT 单块终结（零 gas：0 值交易无需余额，转账面值需 balance ≥ value）",
      done: nonce > 0n || !!lastTx, st: nonce > 0n ? `已上链 nonce ${nonce}` : (lastTx ? "已广播待入块" : "未发送"),
      a: "wallet.html#secSend", al: "去发送 →" },
    { t: "浏览器自查", d: "把交易哈希贴进搜索框，逐字段解析 selector/nonce/receipt/终结性——替代 Etherscan",
      done: !!anyHash, st: anyHash ? (lastTx ? "有哈希可查" : "领币哈希可查") : "等待交易", q: anyHash,
      // a 不能省：没有哈希时走 `./${s.a}` 分支，缺字段会渲染出 href="./undefined"（点了是 404）
      a: "wallet.html#secSend", al: anyHash ? "查这笔交易 →" : "先去发交易 →" },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const firstPending = steps.findIndex((s) => !s.done);

  $("pipe").innerHTML = steps.map((s, i) => {
    const cls = s.done ? "done" : i === firstPending ? "active" : "";
    const stateCls = s.done ? "ok" : i === firstPending ? "acc" : "";
    const link = s.q
      ? `<a class="plink" href="#" data-q="${esc(s.q)}">${s.al}</a>`
      : `<a class="plink" href="./${s.a}">${s.al}</a>`;
    return `<div class="pstep ${cls}">
      <div class="pn"><span class="pnum">${i + 1}</span><span class="ptitle">${esc(s.t)}</span></div>
      <div class="pdesc">${esc(s.d)}</div>
      <div class="pstate ${stateCls}">${esc(s.st)}</div>
      ${link}
    </div>`;
  }).join("");

  $("pipe").querySelectorAll("[data-q]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); $("q").value = a.dataset.q; show(a.dataset.q); $("detail").scrollIntoView({ behavior: "smooth" }); })
  );

  $("pipeSummary").textContent =
    `已完成 ${doneCount}/${steps.length} 步 · ` +
    (firstPending >= 0 ? `下一步：${steps[firstPending].t}` : "全流程走完，可在下方搜索框继续逐字段核对");
  const nextA = firstPending >= 0 ? steps[firstPending].a : steps[steps.length - 1].a;
  $("pipeNext").setAttribute("href", "./" + nextA);
  $("pipeNext").textContent = firstPending >= 0 ? `去第 ${firstPending + 1} 步 →` : "打开钱包操作页 →";
}

// ---------- 代币视图（列表 → 详情：元数据/持仓分布/转账记录） ----------
async function tokensView() {
  const box = $("tokensView");
  if (!box) return;
  try {
    const d = await api("/api/v1/tokens");
    const items = d.items || [];
    if (!items.length) {
      box.innerHTML = `<div class="empty">暂无 ERC-20 代币。部署 DemoToken 后（见 README「代币页」）此处自动出现。</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>代币</th><th>符号</th><th>decimals</th><th>供应量</th><th>转账笔数</th><th>合约地址</th></tr></thead><tbody>
      ${items.map((t) => `<tr data-token="${esc(t.address)}">
        <td>${esc(t.name || "?")}</td>
        <td>${esc(t.symbol || "?")}</td>
        <td>${t.decimals ?? "?"}</td>
        <td>${t.total_supply ? fmtUnits(t.total_supply, t.decimals ?? 18) : "?"}</td>
        <td>${t.transfers}</td>
        <td><span class="acc">${esc(short(t.address, 10))}</span></td>
      </tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-token]").forEach((tr) =>
      tr.addEventListener("click", () => tokenDetail(tr.dataset.token)));
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--warn)">代币列表加载失败：${esc(e.message)}</div>`;
  }
}

// 按 decimals 还原显示（BigInt 安全）
function fmtUnits(wei, dec) {
  try {
    const v = BigInt(wei);
    const base = 10n ** BigInt(dec);
    const frac = (v % base).toString().padStart(dec, "0").replace(/0+$/, "");
    // 原先写成 `整数 + "." + 小数.replace(/\.$/,"")`，那个 replace 作用在小数串上、
    // 永远删不掉整数后面那个点，于是供应量显示成 "1000000."。整串拼完再去尾点。
    return ((v / base).toString() + (frac ? "." + frac : "")).replace(/\.$/, "");
  } catch { return String(wei); }
}

// wei → 人类单位的精确转换。
// 这里原先四处都用 Number(wei)/1e18：double 的精确整数范围只有 2^53≈9.0e15，
// 而 1 B03 就有 1e18 wei，所以**任何余额都要先被舍入一次**。实测两个后果：
//   3499999999999999998 wei 显示成 "3.5"（把 2 wei 抹掉了，数值是错的）
//   1 wei 显示成 "1e-18"（科学计数法，用户读不出来）
// 一律走 BigInt 定点字符串，不做浮点。
const weiUnit = (w) => fmtUnits(w, 18);

async function tokenDetail(addr) {
  const box = $("tokensView");
  try {
    const [toks, holders, transfers] = await Promise.all([
      api("/api/v1/tokens"),
      api(`/api/v1/tokens/${addr}/holders?limit=20`),
      api(`/api/v1/tokens/${addr}/transfers?limit=15`),
    ]);
    const t = (toks.items || []).find((x) => x.address === addr) || {};
    const dec = t.decimals ?? 18;
    box.innerHTML = `
      <div class="row" style="margin:0 0 10px">
        <button id="tokBack">← 返回代币列表</button>
        <b>${esc(t.name || "?")} (${esc(t.symbol || "?")})</b>
        <span class="note">合约 <span class="acc">${esc(addr)}</span> · decimals ${dec} · 供应量 ${t.total_supply ? fmtUnits(t.total_supply, dec) : "?"}</span>
      </div>
      <h2 style="font-size:14px;margin:12px 0 6px">持仓分布（${holders.items.length}）</h2>
      <table><thead><tr><th>#</th><th>地址</th><th>余额</th></tr></thead><tbody>
        ${holders.items.map((h, i) => `<tr><td>${i + 1}</td><td><span class="acc">${esc(h.addr)}</span></td><td>${fmtUnits(h.balance, dec)}</td></tr>`).join("")}
      </tbody></table>
      <p class="note">${esc(holders.note || "")}</p>
      <h2 style="font-size:14px;margin:12px 0 6px">转账记录（最近 ${transfers.items.length} / 共 ${transfers.total}）</h2>
      <table><thead><tr><th>交易哈希</th><th>区块</th><th>from</th><th>to</th><th>数量</th></tr></thead><tbody>
        ${transfers.items.map((x) => `<tr data-tx="${esc(x.tx_hash)}">
          <td><span class="hash">${esc(short(x.tx_hash, 10))}</span></td>
          <td>#${x.block_number}</td>
          <td>${x.from_addr === "0x0000000000000000000000000000000000000000" ? '<span class="tag ok">mint</span>' : esc(short(x.from_addr, 8))}</td>
          <td>${esc(short(x.to_addr, 8))}</td>
          <td>${fmtUnits(x.value, dec)}</td>
        </tr>`).join("")}
      </tbody></table>`;
    $("tokBack")?.addEventListener("click", tokensView);
    box.querySelectorAll("[data-tx]").forEach((tr) =>
      tr.addEventListener("click", () => show(tr.dataset.tx)));
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--warn)">代币详情加载失败：${esc(e.message)}</div>`;
  }
}

// ---------- 统计图表（手写内联 SVG，零依赖）：每日交易数柱 + 活跃地址折线 ----------
async function statsChart() {
  const svg = $("statsChart");
  if (!svg) return;
  let d;
  try { d = await api("/api/v1/stats/daily?days=14"); } catch { return; }
  const items = d.items || [];
  const W = 720, H = 220, PADL = 42, PADR = 12, PADT = 16, PADB = 34;
  const iw = W - PADL - PADR, ih = H - PADT - PADB;
  const n = items.length;
  if (!n) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#8fa3c0" text-anchor="middle" font-size="13">暂无数据（索引器追赶中）</text>`; return; }

  const maxTx = Math.max(1, ...items.map((x) => x.txs));
  const maxAct = Math.max(1, ...items.map((x) => x.activeAddresses));
  const bw = Math.min(28, iw / n - 6);
  const cx = (i) => PADL + (iw / n) * (i + 0.5);
  const yTx = (v) => PADT + ih - (v / maxTx) * ih;
  const yAct = (v) => PADT + ih - (v / maxAct) * ih;

  const bars = items.map((x, i) =>
    `<rect x="${cx(i) - bw / 2}" y="${yTx(x.txs)}" width="${bw}" height="${PADT + ih - yTx(x.txs)}" rx="3"
           fill="#4da3ff" opacity="0.85"><title>${x.date} · ${x.txs} 笔交易 · ${x.activeAddresses} 活跃地址 · ${x.blocks} 块</title></rect>`).join("");
  const linePts = items.map((x, i) => `${cx(i)},${yAct(x.activeAddresses)}`).join(" ");
  const dots = items.map((x, i) =>
    `<circle cx="${cx(i)}" cy="${yAct(x.activeAddresses)}" r="3" fill="#39d98a"><title>${x.date} · ${x.activeAddresses} 活跃地址</title></circle>`).join("");

  const yTicks = [0, 0.5, 1].map((f) => {
    const v = Math.round(maxTx * f);
    return `<text x="${PADL - 8}" y="${yTx(v) + 4}" fill="#8fa3c0" font-size="10" text-anchor="end">${v}</text>
            <line x1="${PADL}" y1="${yTx(v)}" x2="${W - PADR}" y2="${yTx(v)}" stroke="#1f2a3d" stroke-dasharray="3 3"/>`;
  }).join("");
  const xLabels = items.map((x, i) =>
    n > 8 && i % Math.ceil(n / 8) !== 0 ? "" :
    `<text x="${cx(i)}" y="${H - 12}" fill="#8fa3c0" font-size="9" text-anchor="middle">${x.date.slice(5)}</text>`).join("");

  svg.innerHTML = `${yTicks}${bars}
    <polyline points="${linePts}" fill="none" stroke="#39d98a" stroke-width="2"/>${dots}${xLabels}`;
  $("statsLegend").innerHTML = `
    <span class="legend"><i style="background:#4da3ff"></i>每日交易数（柱，左轴 ${maxTx}）</span>
    <span class="legend"><i style="background:#39d98a;border-radius:50%"></i>活跃地址（折线，右轴 ${maxAct}）</span>
    <span class="legend">悬停柱/点查看当日出块数</span>`;
}

// ---------- 看门狗横幅：把"最近一次体检"顶到页面最上方 ----------
// 停链时页面其它部分照样一切正常（RPC 通、区块列表有数据、绿点亮着），
// 只有高度不动——所以这个横幅必须放在最上面，且必须显示"体检是什么时候做的"。
async function healthBanner() {
  const box = $("healthBanner");
  if (!box) return;
  try {
    const w = await api("/api/v1/watchdog");
    if (!w.available) { box.innerHTML = ""; return; }
    const crit = (w.problems || []).filter((p) => p.sev === "CRIT");
    const warn = (w.problems || []).filter((p) => p.sev === "WARN");
    const cls = w.stale ? "hb stale" : crit.length ? "hb crit" : warn.length ? "hb warn" : "hb ok";
    const head = w.stale ? `⚠ 看门狗已 ${Math.round(w.ageSec / 60)} 分钟未更新，健康状态未知`
      : crit.length ? `⛔ ${crit[0].what}`
      : warn.length ? `⚠ ${warn[0].what}`
      : `✓ 链正常出块（高度 ${w.height}，体检于 ${w.ageSec}s 前）`;
    box.innerHTML = `<div class="${cls}">${esc(head)}` +
      (crit.length > 1 || warn.length ? `<ul class="hblist">` +
        [...crit, ...warn].slice(1).map((p) => `<li><b>[${p.sev}]</b> ${esc(p.what)} — ${esc(p.detail)}</li>`).join("") +
        `</ul>` : "") +
      (crit.length === 1 && crit[0].detail ? `<div class="hbfix">${esc(crit[0].detail)}</div>` : "") +
      `</div>`;
  } catch { box.innerHTML = ""; }
}

// ---------- 合约列表（登记视图）----------
async function contractsCard() {
  const box = $("contractsView");
  if (!box) return;
  try {
    const d = await api("/api/v1/contracts?limit=20");
    if (!d.items.length) {
      box.innerHTML = `<div class="empty">链上还没有被索引到的合约创建交易</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>地址</th><th>名称</th><th>部署者</th><th>区块</th><th>字节码</th><th>登记</th></tr></thead><tbody>` +
      d.items.map((c) => `<tr data-addr="${esc(c.address)}">
        <td><span class="hash">${short(c.address, 10)}</span></td>
        <td>${esc(c.name || "—")}</td>
        <td><span class="hash">${short(c.creator || "—", 8)}</span></td>
        <td>${c.block_number ?? "—"}</td>
        <td>${c.deployed_size ? c.deployed_size + "B" : "—"}</td>
        <td>${c.verified === 1 ? `<span class="tag ok">已登记</span>`
             : c.verified === 2 ? `<span class="tag bad">不一致</span>`
             : `<span class="tag">未登记</span>`}</td></tr>`).join("") +
      `</tbody></table>
      <div class="note" style="margin-top:6px">共 ${d.total} 个合约，其中 ${d.verified} 个已登记源码。点行看指纹与独立复核命令。</div>`;
    box.querySelectorAll("[data-addr]").forEach((tr) =>
      tr.addEventListener("click", () => { $("q").value = tr.dataset.addr; show(tr.dataset.addr); $("detail").scrollIntoView({ behavior: "smooth" }); })
    );
  } catch (e) {
    box.innerHTML = `<div class="empty">索引器不可用：${esc(e.message)}（降级：直接用搜索框查地址）</div>`;
  }
}

// ---------- 入口分发 ----------
class Unrecognized extends Error {}

function show(q) {
  q = String(q).trim();
  $("detail").innerHTML = `<div class="empty">查询中…</div>`;
  if (!q) return ($("detail").innerHTML = `<div class="empty">请输入查询内容</div>`);
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      showTx(q);
    } else if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      showAddress(q); // 40 位 hex → 地址
    } else if (/^0x[0-9a-fA-F]+$/.test(q)) {
      showBlock(q); // 其他 0x → 区块号（hex）
    } else if (/^\d+$/.test(q)) {
      showBlock(hex(q)); // 纯数字 → 区块号
    } else {
      // 原先这里直接 hex(q)，遇到非数字就抛 "Cannot convert hello world to a BigInt"，
      // 把一个库内部错误原样摊给用户看。识别不了的输入应当说"识别不了"。
      throw new Unrecognized(q);
    }
  } catch (e) {
    if (e instanceof Unrecognized) {
      $("detail").innerHTML = `<div class="empty" style="color:var(--warn)">无法识别「${esc(q.slice(0, 60))}」。支持三种输入：64 位交易哈希、40 位地址、区块号（十进制或 0x 十六进制）。</div>`;
      return;
    }
    $("detail").innerHTML = `<div class="empty" style="color:var(--warn)">查询失败：${esc(e.shortMessage || e.message)}</div>`;
  }
}

$("go").addEventListener("click", () => show($("q").value));
$("q").addEventListener("keydown", (e) => e.key === "Enter" && show($("q").value));

// 钱包页的深链：/b03/?tx=0x…（交易哈希）与 /b03/?addr=0x…（地址）
// 进来就自动查询并滚到解析区，省掉手工复制粘贴。
// 地址这条是随"双向对账"一起加的：对账判定里给出的"链上查 →"若指向一个不会被解析的 ?q=，
// 用户点了只会看到一个空白搜索框——那等于把验证责任又推回给人。
const usp = new URLSearchParams(location.search);
const txParam = usp.get("tx");
const addrParam = usp.get("addr");
const deepLink = /^0x[0-9a-fA-F]{64}$/.test(txParam || "") ? txParam
  : /^0x[0-9a-fA-F]{40}$/.test(addrParam || "") ? addrParam : null;
if (deepLink) {
  $("q").value = deepLink;
  show(deepLink);
  addEventListener("load", () => $("detail").scrollIntoView({ behavior: "smooth" }), { once: true });
}

// ---------- 轮询 ----------
let tickCount = 0;
async function tick() {
  try {
    await Promise.all([stats(), blocks(), topology(), contractsCard(), healthBanner(), pipeline().catch((e) => console.warn("流水线检测失败", e))]);
    // 统计图表/代币列表变化慢，60s 刷一次即可
    if (tickCount++ % 12 === 0) {
      statsChart().catch(() => {});
      // 代币列表只在首屏渲染；用户已点进详情时不覆盖
      if (tickCount <= 13) tokensView().catch(() => {});
    }
  } catch (e) {
    $("dot").className = "dot off";
    console.warn("RPC 不可达", e);
  }
}
tick();
setInterval(tick, 5000);
