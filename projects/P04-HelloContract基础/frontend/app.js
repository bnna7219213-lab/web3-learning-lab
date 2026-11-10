// P04 只读面板：零依赖，只用 fetch 打 JSON-RPC。
// 刻意不引入 viem/ethers：P04 的目的就是让你亲手做一遍「编码 → eth_call → 解码」，
// 到 P06 再用库，你就知道库替你做了什么。

const $ = (id) => document.getElementById(id);

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

const pad32 = (hexNoPrefix) => hexNoPrefix.padStart(64, "0");
const toArg = (n) => pad32(BigInt(n).toString(16));

function row(k, v, cls = "") {
  const b = document.createElement("b");
  b.textContent = k;
  const s = document.createElement("span");
  s.textContent = v;
  if (cls) s.className = cls;
  return [b, s];
}

const note = (text) => Object.assign(document.createElement("p"), { className: "note", textContent: text });

async function loadSelectors() {
  const host = $("selectors");
  try {
    const selectors = await (await fetch("../abi/Counter.selectors.json")).json();
    const entries = Object.entries(selectors).sort((a, b) => a[1].localeCompare(b[1]));
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const t of ["选择器", "函数签名"]) head.append(Object.assign(document.createElement("th"), { textContent: t }));
    table.append(head);
    for (const [sig, sel] of entries) {
      const tr = document.createElement("tr");
      tr.append(
        Object.assign(document.createElement("td"), { textContent: sel }),
        Object.assign(document.createElement("td"), { textContent: sig })
      );
      table.append(tr);
    }
    host.replaceChildren(table);
    return selectors;
  } catch (error) {
    host.replaceChildren(note(`读不到 abi/Counter.selectors.json —— 先跑 bash script/deploy.sh anvil（${error.message}）`));
    return {};
  }
}

async function readViews(selectors) {
  const host = $("views");
  const calls = [
    ["count()", "count"],
    ["previousCount()", "previousCount"],
    ["owner()", "owner"],
    ["VERSION()", "VERSION"],
    ["history()", "history"],
  ];
  const out = [];
  for (const [label, key] of calls) {
    const sel = selectors[key] ?? selectors[`${key}()`];
    if (!sel) {
      out.push(...row(label, "（ABI 里没找到该选择器）", "bad"));
      continue;
    }
    try {
      const raw = await rpc("eth_call", [{ to: $("addr").value, data: sel }, "latest"]);
      const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
      if (key === "history") {
        const items = (hex.match(/.{64}/g) ?? []).map((x) => BigInt("0x" + x).toString());
        out.push(...row(label, `[${items.join(", ")}]`));
      } else if (key === "VERSION") {
        // 动态 string 返回：第 1 个字是偏移量（单位=字节），偏移处第 1 个字是长度，之后才是数据
        const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2; // 转成 hex 字符下标
        const len = Number(BigInt("0x" + hex.slice(offset, offset + 64)));
        const bytes = hex.slice(offset + 64, offset + 64 + len * 2);
        let text = "";
        for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
        out.push(...row(label, text));
      } else if (key === "owner") {
        out.push(...row(label, `0x${hex.slice(24)}`));
      } else {
        out.push(...row(label, hex ? BigInt("0x" + hex).toString() : "0"));
      }
    } catch (error) {
      out.push(...row(label, error.message, "bad"));
    }
  }
  host.replaceChildren(...out);
}

async function connect() {
  const net = $("net");
  try {
    const [chainId, blockNumber, gasPrice] = await Promise.all([
      rpc("eth_chainId"),
      rpc("eth_blockNumber"),
      rpc("eth_gasPrice"),
    ]);
    net.replaceChildren(
      ...row("连接", "成功", "ok"),
      ...row("chainId", `${BigInt(chainId)} （profile 里应一致）`),
      ...row("最新区块", BigInt(blockNumber).toString()),
      ...row("gasPrice", `${Number(BigInt(gasPrice)) / 1e9} gwei`)
    );
    const selectors = await loadSelectors();
    await readViews(selectors);
    await checkRecordMatch();
  } catch (error) {
    net.replaceChildren(...row("连接", error.message, "bad"), ...row("提示", "anvil 没起？RPC 地址不对？跨源被拒？"));
  }
}

async function loadRecord() {
  try {
    const record = await (await fetch("../deployments/latest.json")).json();
    if (!$("addr").value) $("addr").value = record.address;
    $("record").replaceChildren(
      ...row("contract", record.contract),
      ...row("address", record.address),
      ...row("chainId", String(record.chainId)),
      ...row("deployer", record.deployer),
      ...row("version", record.version),
      ...row("构造参数 initial", String(record.constructorInitial)),
      ...row("网络 profile", record.networkProfile),
      ...row("deployedBytecodeHash", record.deployedBytecodeHash)
    );
    return record;
  } catch {
    $("record").replaceChildren(...row("部署记录", "读不到 deployments/latest.json"));
    return null;
  }
}

// 链上字节码 vs 本地编译产物：不需要 keccak 就能证明"跑的是这份代码"
async function checkRecordMatch() {
  const out = $("verifyOut");
  try {
    const [code, artifact] = await Promise.all([
      rpc("eth_getCode", [$("addr").value, "latest"]),
      fetch("../out/Counter.sol/Counter.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error("无 out/ 产物")))),
    ]);
    const local = artifact.deployedBytecode?.object ?? artifact.deployedBytecode;
    if (typeof local !== "string") throw new Error("产物里没有 deployedBytecode 字符串");
    const same = local.toLowerCase() === code.toLowerCase();
    out.replaceChildren(
      ...row("链上字节码长度", `${(code.length - 2) / 2} 字节`),
      ...row("与本地 out/ 产物一致", same ? "是 → 链上跑的就是这份编译产物" : "否 → 版本或地址不匹配", same ? "ok" : "bad"),
      ...row("独立复算哈希", `cast keccak $(cast code --rpc-url ${$("rpc").value} ${$("addr").value})`)
    );
  } catch (error) {
    out.replaceChildren(...row("复核", error.message, "bad"));
  }
}

async function write() {
  const out = $("txOut");
  out.hidden = false;
  out.textContent = "发送中…";
  try {
    const selectors = await (await fetch("../abi/Counter.selectors.json")).json();
    const sel = selectors["increment(uint256)"];
    if (!sel) throw new Error("找不到 increment(uint256) 选择器");
    const data = sel + toArg($("by").value);
    const hash = await rpc("eth_sendTransaction", [
      { from: $("from").value, to: $("addr").value, data },
    ]);
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    out.textContent = JSON.stringify(
      {
        请求数据: data,
        交易哈希: hash,
        状态: receipt?.status,
        消耗gas: receipt?.gasUsed ? BigInt(receipt.gasUsed).toString() : "尚未打包",
        所在区块: receipt?.blockNumber ? BigInt(receipt.blockNumber).toString() : "-",
      },
      null,
      2
    );
    await connect();
  } catch (error) {
    out.textContent = `失败：${error.message}\n\n这通常意味着节点没有解锁该账户（anvil 默认解锁，联盟网/测试网不行 → 写路径要在客户端签名，见 P06）。`;
  }
}

$("connect").addEventListener("click", connect);
$("write").addEventListener("click", write);
$("verifyCode").addEventListener("click", checkRecordMatch);

await loadRecord();
await connect();
