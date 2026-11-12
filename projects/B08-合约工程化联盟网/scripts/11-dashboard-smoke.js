// scripts/11-dashboard-smoke.js —— B08 运维看板（frontend/）端到端冒烟
// 起 BFF → 逐端点断言 → 关 BFF。覆盖：静态页、链状态、零 gas、终结性、
// Vault 实现槽、Create2 双算、Merkle 根对账、链上工程事件、同源 /rpc 反代。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ok, summary, hr, PROJECT } = require("./lib/b08");

const PORT = Number(process.env.B08_PORT || 8808);
const BASE = "http://127.0.0.1:" + PORT;

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + "/api/state");
      if (r.ok) return true;
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  hr("11 dashboard smoke (B08 运维看板)");
  const child = spawn(process.execPath, ["frontend/server.js"], {
    cwd: PROJECT,
    env: { ...process.env, B08_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdout.on("data", () => {});

  const ready = await waitReady();
  ok(ready, "BFF 启动并就绪（127.0.0.1:" + PORT + "）");
  if (!ready) {
    console.error(stderr);
    child.kill();
    process.exit(1);
  }

  // ① 静态页
  const html = await (await fetch(BASE + "/")).text();
  ok(html.includes("B08 · 合约工程化运维看板"), "静态页可访问且标题正确（零构建，无打包步骤）");
  const jsRes = await fetch(BASE + "/app.js");
  const cssRes = await fetch(BASE + "/style.css");
  ok(jsRes.status === 200 && cssRes.status === 200, "静态资源 /app.js 与 /style.css 可访问");

  // ② 链状态（/api/state）
  const st = await (await fetch(BASE + "/api/state")).json();
  ok(st.ok === true, "/api/state 返回 ok");
  ok(st.chain.chainId === 19880601, "chainId 正确（" + st.chain.chainId + "）");
  ok(
    st.chain.zeroGas === true,
    "零 gas 语义成立（gasPrice=" + st.chain.gasPrice + " baseFee=" + st.chain.baseFeePerGas + "）"
  );
  ok(
    st.chain.finality.consistent === true,
    "终结性：块 #" + st.chain.finality.targetBlock + " 哈希在 " + st.chain.finality.nodes.length + " 节点一致"
  );

  // ③ Vault 实现槽对齐登记
  const vault = st.vault;
  ok(vault && vault.implMatchesRegister === true, "ERC-1967 实现槽 == 部署登记实现（" + (vault && vault.implOnChain) + "）");
  ok(
    vault && vault.owner && vault.version !== undefined,
    "Vault 状态可读（owner=" + (vault && vault.owner) + " version=" + (vault && vault.version) + "）"
  );

  // ④ Create2 双算对账
  const c2 = await (await fetch(BASE + "/api/create2")).json();
  ok(c2.ok === true, "/api/create2 返回 ok");
  ok(Number(c2.data.deployCount) >= 1, "Create2 工厂已部署计数 = " + c2.data.deployCount);
  ok(
    c2.data.crossCheck === null || c2.data.crossCheck.registeredMatchesEvent === true,
    "Create2 链上登记地址 == Deployed 事件地址"
  );

  // ⑤ Merkle 根对账
  const mk = await (await fetch(BASE + "/api/merkle")).json();
  ok(mk.ok === true && mk.data.matches === true, "链上 root() == 部署记录 merkleRoot");

  // ⑥ 链上工程事件（含 ERC-1967 Upgraded）
  const ev = await (await fetch(BASE + "/api/events?limit=80")).json();
  const names = new Set(ev.data.items.map((i) => i.eventName));
  ok(ev.data.items.length > 0, "链上工程事件可查（" + ev.data.items.length + " 条：" + [...names].join(", ") + "）");
  ok(
    names.has("Upgraded") || names.has("Deployed") || names.has("Claimed"),
    "至少命中 Upgraded / Deployed / Claimed 之一"
  );

  // ⑦ 同源 /rpc 反代（绕开 Besu 空 CORS 白名单的关键）
  const rpcRes = await fetch(BASE + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const rpcJson = await rpcRes.json();
  ok(rpcRes.status === 200 && Number(rpcJson.result) === 19880601, "同源 /rpc 反代可用（eth_chainId 正确）");

  // ⑧ 实测记录落盘
  const out = path.join(PROJECT, "deployments", "dashboard-smoke.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        port: PORT,
        chain: st.chain,
        vault,
        events: { count: ev.data.items.length, names: [...names] },
        create2: c2.data,
        merkle: mk.data,
      },
      null,
      2
    )
  );
  console.log("  实测记录：" + out);

  child.kill();
  summary("11 dashboard smoke");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
}); 
