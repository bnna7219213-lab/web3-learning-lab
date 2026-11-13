// P05 面板：零依赖 fetch JSON-RPC + 手写 ABI 编解码（静态类型与 string）。
// 写演示走 anvil 解锁账户（eth_sendTransaction 由节点代签）——联盟网/公链上请换钱包签名（P06）。
const $ = (id) => document.getElementById(id);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ANVIL0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

async function rpc(method, params = []) {
  const res = await fetch($("rpc").value, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const strip = (h) => h.replace(/^0x/, "");
const pad32 = (h) => strip(h).padStart(64, "0");
const addrArg = (a) => pad32(a.slice(2));
const uintArg = (n) => pad32(BigInt(n).toString(16));
const word = (hex, i) => strip(hex).slice(i * 64, (i + 1) * 64);
const asAddr = (w) => "0x" + w.slice(24);
const asUint = (w) => BigInt("0x" + w);

// string 是动态类型：偏移量 → 长度 → 内容（P04 踩过的坑：偏移是字节偏移，不是字符下标）
function decodeString(hex) {
  const off = Number(asUint(word(hex, 0))) * 2;
  const s = strip(hex);
  const len = Number(BigInt("0x" + s.slice(off, off + 64))) * 2;
  const bytes = s.slice(off + 64, off + 64 + len);
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g).map((b) => parseInt(b, 16))));
}

function row(k, v, cls = "") {
  const b = document.createElement("b");
  b.textContent = k;
  const s = document.createElement("span");
  s.textContent = v;
  if (cls) s.className = cls;
  return [b, s];
}
const note = (t) => Object.assign(document.createElement("p"), { className: "note", textContent: t });
const fmt = (wei) => `${(Number(wei) / 1e18).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} LAB（${wei} wei）`;

let selectors = {};
let token = "";

async function call(sig, args = "") {
  const key = sig.replace(/\(.*$/, "");
  const sel = selectors[key] ?? selectors[sig];
  if (!sel) throw new Error(`选择器缺失：${sig}`);
  return rpc("eth_call", [{ to: token, data: sel + args }, "latest"]);
}

async function resolveToken() {
  token = $("token").value.trim();
  if (!token) {
    const rec = await (await fetch("../deployments/latest.json")).json();
    token = rec.address;
    $("token").value = token;
  }
}

async function loadMeta() {
  const host = $("meta");
  host.replaceChildren();
  const [name, symbol, decimals, version, cap, supply] = await Promise.all([
    call("name()"), call("symbol()"), call("decimals()"), call("VERSION()"), call("CAP()"), call("totalSupply()"),
  ]);
  host.append(
    ...row("name", decodeString(name)),
    ...row("symbol", decodeString(symbol)),
    ...row("decimals", asUint(word(decimals, 0)).toString()),
    ...row("VERSION", decodeString(version)),
    ...row("CAP", fmt(asUint(word(cap, 0)))),
    ...row("totalSupply", fmt(asUint(word(supply, 0)))),
  );
}

async function loadFingerprint() {
  const host = $("fingerprint");
  host.replaceChildren();
  try {
    const onchain = await rpc("eth_getCode", [token, "latest"]);
    const artifact = await (await fetch("../out/LabToken.sol/LabToken.json")).json();
    const local = artifact.deployedBytecode.object;
    // immutable（CAP）在部署时才回填进字节码：out/ 产物里是占位槽。
    // 比对前按 immutableReferences 掩掉这些槽，否则"同一份代码"会被误判为不同。
    const mask = (hex) => {
      let s = strip(hex).toLowerCase();
      for (const slots of Object.values(artifact.deployedBytecode.immutableReferences || {})) {
        for (const { start, length } of slots) {
          s = s.slice(0, start * 2) + "0".repeat(length * 2) + s.slice((start + length) * 2);
        }
      }
      return s;
    };
    const same = mask(onchain) === mask(local);
    host.append(
      ...row("链上 code 长度", `${(strip(onchain).length / 2)} 字节`),
      ...row("本地产物长度", `${(strip(local).length / 2)} 字节`),
      ...row("immutable 槽", Object.keys(artifact.deployedBytecode.immutableReferences || {}).join(", ") || "无"),
      ...row("是否同一份编译产物", same ? "是（掩掉 immutable 槽后逐字节一致）" : "否 → 换过编译参数或源码（看 deployments 记录的 evmVersion）", same ? "ok" : "note"),
    );
  } catch (e) {
    host.append(note(`指纹核对不可用：${e.message}（先 forge build）`));
  }
}

async function lookup() {
  const host = $("lookupOut");
  host.replaceChildren();
  const holder = $("holder").value.trim();
  if (!holder) return host.append(note("先填持有人地址"));
  const bal = await call("balanceOf(address)", addrArg(holder));
  host.append(...row("balanceOf", fmt(asUint(word(bal, 0)))));
  const nonce = await call("nonces(address)", addrArg(holder));
  host.append(...row("permit nonce", asUint(word(nonce, 0)).toString()));
  const spender = $("spender").value.trim();
  if (spender) {
    const al = await call("allowance(address,address)", addrArg(holder) + addrArg(spender));
    host.append(...row(`allowance(${spender.slice(0, 8)}…)`, fmt(asUint(word(al, 0)))));
  }
}

async function loadEvents() {
  const host = $("events");
  host.replaceChildren();
  const head = Number(await rpc("eth_blockNumber"));
  const from = "0x" + Math.max(0, head - 500).toString(16);
  const logs = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: "latest" }]);
  if (!logs.length) return host.append(note("最近 500 块没有 Transfer 事件"));
  const table = document.createElement("table");
  table.append(Object.assign(document.createElement("tr"), { innerHTML: "<th>块</th><th>from</th><th>to</th><th>value</th><th>类型</th>" }));
  for (const log of logs.slice(-20).reverse()) {
    const from = asAddr(word(log.topics[1], 0));
    const to = asAddr(word(log.topics[2], 0));
    const value = asUint(word(log.data, 0));
    const kind = from === "0x" + "0".repeat(40) ? "mint" : to === "0x" + "0".repeat(40) ? "burn" : "transfer";
    const tr = document.createElement("tr");
    for (const t of [Number(log.blockNumber), from.slice(0, 10) + "…", to.slice(0, 10) + "…", fmt(value), kind]) {
      tr.append(Object.assign(document.createElement("td"), { textContent: t }));
    }
    table.append(tr);
  }
  host.append(table, note(`共 ${logs.length} 条，显示最近 20 条`));
}

async function sendTransfer() {
  const host = $("sendOut");
  host.replaceChildren();
  const to = $("to").value.trim();
  const amount = BigInt(Math.round(Number($("amount").value) * 1e18));
  const data = (selectors["transfer"] ?? selectors["transfer(address,uint256)"]) + addrArg(to) + uintArg(amount);
  const hash = await rpc("eth_sendTransaction", [{ from: ANVIL0, to: token, data }]);
  host.append(...row("tx", hash));
  let rec = null;
  for (let i = 0; i < 20 && !rec; i++) {
    await new Promise((r) => setTimeout(r, 500));
    rec = await rpc("eth_getTransactionReceipt", [hash]);
  }
  if (!rec) return host.append(note("20 次轮询仍无回执——anvil 没在跑？"));
  host.append(
    ...row("status", rec.status === "0x1" ? "1 成功" : "0 失败", rec.status === "0x1" ? "ok" : "note"),
    ...row("gasUsed", Number(rec.gasUsed).toString()),
    ...row("logs", `${rec.logs.length} 条 Transfer`),
  );
  await loadMeta();
  await loadEvents();
}

async function loadSelectors() {
  const host = $("selectors");
  selectors = await (await fetch("../abi/LabToken.selectors.json")).json();
  const table = document.createElement("table");
  table.append(Object.assign(document.createElement("tr"), { innerHTML: "<th>选择器</th><th>函数签名</th>" }));
  for (const [sig, sel] of Object.entries(selectors).sort((a, b) => a[1].localeCompare(b[1]))) {
    const tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), { textContent: sel }), Object.assign(document.createElement("td"), { textContent: sig }));
    table.append(tr);
  }
  host.replaceChildren(table);
}

async function loadAll() {
  try {
    await resolveToken();
    await loadSelectors();
    await Promise.all([loadMeta(), loadFingerprint(), loadEvents()]);
  } catch (e) {
    $("meta").replaceChildren(note(`加载失败：${e.message}（先起 anvil 并 bash script/deploy.sh anvil）`));
  }
}

$("load").onclick = loadAll;
$("lookup").onclick = () => lookup().catch((e) => $("lookupOut").replaceChildren(note(e.message)));
$("send").onclick = () => sendTransfer().catch((e) => $("sendOut").replaceChildren(note(e.message)));
loadAll();