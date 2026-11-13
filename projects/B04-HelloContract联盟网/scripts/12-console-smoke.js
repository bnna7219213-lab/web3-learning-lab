#!/usr/bin/env node
// scripts/12-console-smoke.js —— B04「卡单观测与处置台」端到端冒烟
//
// 覆盖 6 段：
//   1. 页面与静态资源可达（零构建：无打包步骤）
//   2. 链状态（零 gas / 3 节点终结性一致）
//   3. 造卡单 → 观测三信号（in_pool / receipt=null / nonce 缺口，跨 3 节点）
//   4. 窗口校验：注入额太小被拒；水龙头额度（10 B03）也被拒并给出原因
//   5. 处置成功：注入 + 同 nonce 替换 → 原卡单出池、nonce 前进、替换交易 status=1
//   6. 动作清单里**没有**「重启节点」这一项（B04 实测教训：既无效又有停链风险）
//
// 用法: node scripts/12-console-smoke.js [--port 8804]
const { spawn } = require("child_process");
const path = require("path");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("port", 8804));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${msg}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${msg}`);
  }
  return !!cond;
}
const hr = (t) => console.log(`\n=== ${t} ===\n`);

async function get(p) {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 静态页不是 JSON */
  }
  return { status: res.status, text, json: j, headers: res.headers };
}
async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json() };
}

(async () => {
  hr("启动 BFF");
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "frontend", "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", (d) => process.stdout.write("  [bff] " + d.toString().trim() + "\n"));
  srv.stderr.on("data", (d) => process.stderr.write("  [bff!] " + d.toString().trim() + "\n"));
  // 等端口就绪
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const s = await get("/api/state");
      ready = s.status === 200;
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) {
    console.log("  [FAIL] BFF 未在 10s 内就绪");
    srv.kill();
    process.exit(1);
  }
  ok(true, `BFF 就绪（${BASE}）`);

  try {
    hr("1. 静态页与资源（零构建）");
    const page = await get("/");
    ok(page.status === 200 && page.text.includes("卡单观测与处置台"), "静态页可访问且标题正确");
    const js = await get("/app.js");
    ok(js.status === 200 && js.text.includes("checkWindow"), "/app.js 可访问");
    const css = await get("/style.css");
    ok(css.status === 200, "/style.css 可访问");
    ok(js.text.includes("!j.rejected"), "前端把业务拒绝与 HTTP 异常分开（不会把拒绝显示成 HTTP 200 异常）");

    hr("2. 链状态");
    const st = (await get("/api/state")).json;
    ok(st.ok === true, "/api/state 返回 ok");
    ok(st.chainId === 19880601, `chainId 正确（${st.chainId}）`);
    ok(st.zeroBaseFee === true, `零 baseFee 成立（节点报价=${st.gasPrice} baseFee=${st.baseFeePerGas}）`);
    ok(st.nodes.length >= 3, `已连 ${st.nodes.length} 个节点`);
    ok(st.finalityConsistent === true, "终结性：同一高度块哈希在多节点一致");

    hr("3. 造卡单 + 三信号观测");
    const made = (await post("/api/lab/make-stuck")).json;
    ok(made.ok === true, `卡单已造（${made.txHash}）`);
    ok(made.signals.in_pool === true, "信号① in_pool=true（tx 非 null 且 blockNumber=null）");
    ok(made.signals.receipt === null, "信号② receipt=null（永远等不到回执）");
    ok(made.signals.nonce_pending > made.signals.nonce_latest, "信号③ nonce 缺口（pending > latest）");
    ok(made.verdict.stuck === true, `判读为卡单（${made.verdict.code}）`);

    const obs = (await get("/api/tx/" + made.txHash)).json;
    ok(obs.signals.length >= 3, `跨 ${obs.signals.length} 个节点采样`);
    ok(
      obs.signals.every((s) => s.in_pool === true && s.receipt === null),
      "三个节点一致判定为卡单（不是单节点假象）"
    );
    ok(!!obs.evidence && obs.evidence.includes("console-"), `证据留痕已落盘（${obs.evidence ? obs.evidence.split(/[\\/]/).pop() : "-"}）`);
    ok(obs.stuckCost === "505440", `卡单成本 = ${obs.stuckCost} wei（gas 505440 × gasPrice 1）`);
    ok(obs.replaceCost === "42000", `替换成本 = ${obs.replaceCost} wei（gas 21000 × gasPrice 2）`);

    hr("4. 窗口校验（拒绝无效注入额）");
    const small = (await post("/api/lab/resolve", { inject: "1000" })).json;
    ok(small.rejected === true, "注入额 1000 wei 被拒（小于替换成本）");
    ok(String(small.plan.note).includes("替换交易自己付不起手续费"), "拒绝理由可读：替换交易自己付不起手续费");
    const faucet = (await post("/api/lab/resolve", { inject: "10000000000000000000" })).json;
    ok(faucet.rejected === true, "水龙头额度 10 B03 被拒（不小于卡单成本）");
    ok(
      String(faucet.plan.note).includes("卡单本身变成可执行"),
      "拒绝理由可读：卡单本身变成可执行，测的不是替换"
    );

    hr("5. 处置：注入最小余额 + 同 nonce 替换");
    const done = (await post("/api/lab/resolve", { inject: "100000" })).json;
    ok(done.ok === true, "处置成功");
    ok(done.replacementStatus === 1, `替换交易入块 status=1（block ${done.replacementBlock}）`);
    ok(done.before.in_pool === true && done.after.in_pool === false, "原卡单已从池中消失（被顶掉）");
    ok(done.after.nonce_latest === done.before.nonce_latest + 1, `账户 nonce 前进（${done.before.nonce_latest} → ${done.after.nonce_latest}）`);
    ok(done.after.receipt === null, "原卡单始终没有回执（它从没被执行）");
    ok(done.verdict.stuck === false, `处置后判读不再是卡单（${done.verdict.code}）`);
    const afterState = (await get("/api/state")).json;
    ok(afterState.zeroBaseFee === true && afterState.baseFeePerGas === "0", "legacy 实验交易后仍按 baseFee 正确显示零 gas 网络");
    const zeroGasTx = (await post("/rpc", { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [done.injectTx] })).json;
    ok(zeroGasTx.result?.gasPrice === "0x0" && zeroGasTx.result?.blockNumber !== null, "真正的 gasPrice=0 注入交易已入块（报价估计不代替实际交易）");

    hr("6. 动作清单：不含「重启节点」");
    const acts = (await get("/api/actions")).json;
    ok(acts.ok === true, "/api/actions 返回 ok");
    ok(!acts.actions.some((a) => /restart|重启/i.test(a.id + a.label)), "支持的动作里没有重启节点");
    ok(
      acts.notSupported.some((n) => n.id === "restart-node" && /gossip|回填/.test(n.why)),
      "「重启节点」被显式列为不支持，并说明 gossip 回填的原因"
    );
    ok(
      acts.notSupported.some((n) => n.useInstead && /替换/.test(n.useInstead)),
      "给出了替代路径（注入 + 同 nonce 替换）"
    );
  } catch (e) {
    fail++;
    console.log(`  [FAIL] 冒烟异常：${e.message}`);
  } finally {
    srv.kill();
  }

  console.log(`\n12 console smoke (B04): ${fail === 0 ? "ALL PASS" : `FAILED (${fail})`}  (pass=${pass} fail=${fail})`);
  if (fail) process.exit(1);
})();
