#!/usr/bin/env node
// B04 · 卡单观测与处置台（BFF）
//
// 为什么是「观测 + 处置」两件事，而不是一个「一键清理」按钮：
//   B04 实测教训（见 README「实跑踩到的两个硬坑」）：
//   ① 「重启单节点即可清池」是**方向对、强度错**——重启只是临时清掉，gossip 会在几分钟内回填；
//      真要清干净得重启整个集群（= 停链）。所以本台**刻意不提供**「重启节点」动作，
//      并在 /api/actions 里显式说明原因。
//   ② 已实测可行的处置路径是「注入最小余额 → 同 nonce、更高 gasPrice、更低 gas 的空交易替换」，
//      且必须落在窗口：替换成本 ≤ 注入额 < 卡单成本。窗口没设计好，实验会给出
//      「看似成功实则无效」的操作指引（例如按水龙头额度直接打 10 B03 —— 卡单自己就变成可执行了）。
//
// 安全口径（同 B06/B08）：私钥只从 B07 的 env/.env.local 读，密钥不出服务器；
// 实验用的「卡单账户」由服务端现场生成，私钥只留在服务端内存，浏览器永远看不到。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8804);
const RPC = process.env.RPC || "http://127.0.0.1:8551";
const CHAIN_ID = Number(process.env.CHAIN_ID || 19880601);
const NODES = (process.env.NODES || "8551,8552,8553")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((p) => (/^http/.test(p) ? p : `http://127.0.0.1:${p}`));
const FRONTEND = __dirname;
const EVIDENCE = path.join(FRONTEND, "..", "docs", "evidence");

// 卡单交易的形状（B04 坑 1 的原样复现）：legacy / gasPrice=1 / value=0 / gas=505440
const STUCK_GAS = 505440n;
const STUCK_GAS_PRICE = 1n;
// 替换交易：同 nonce、更高 gasPrice、更低 gas（空交易）
const REPLACE_GAS = 21000n;
const REPLACE_GAS_PRICE = 2n;
// 水龙头单次额度（10 B03）——用它注入会**跳出窗口**，页面要显式拦下并解释
const FAUCET_CLAIM_WEI = 10n ** 19n;

const REPLACEMENT_COST = REPLACE_GAS * REPLACE_GAS_PRICE; // 42000 wei
const STUCK_COST = STUCK_GAS * STUCK_GAS_PRICE; // 505440 wei

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });

/** 读 B07 的 env/.env.local（密钥只在服务端） */
function cfg() {
  const f = path.resolve(__dirname, "..", "..", "B07-NFT市场联盟网", "env", ".env.local");
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    // 行内注释：值后面常跟 "# 0x地址"，不剥掉会被当成私钥的一部分
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).split("#")[0].trim();
  }
  return out;
}
const C = cfg();
/** 注入方：成员 B（链上余额充足），只做「注入最小余额」这一件事 */
const funder = new ethers.Wallet(C.MEMBER_B_PRIVATE_KEY || "", provider);

/** 实验态：卡单账户（现场生成，私钥只留内存） */
let lab = null;

function json(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** 一笔交易的三个等效信号（不用 txpool_content——它会把全链待处理交易暴露到公网 RPC）
 *  accountHint：交易被顶掉后 eth_getTransactionByHash 会返回 null，此时仍要靠账户地址读 nonce 缺口 */
async function signals(url, txHash, accountHint) {
  const tx = await rpc(url, "eth_getTransactionByHash", [txHash]);
  const rec = await rpc(url, "eth_getTransactionReceipt", [txHash]);
  let latest = null;
  let pending = null;
  const from = (tx && tx.from) || accountHint || null;
  if (from) {
    latest = Number(BigInt(await rpc(url, "eth_getTransactionCount", [from, "latest"])));
    pending = Number(BigInt(await rpc(url, "eth_getTransactionCount", [from, "pending"])));
  }
  const pendBlk = await rpc(url, "eth_getBlockByNumber", ["pending", true]);
  const head = Number(BigInt(await rpc(url, "eth_blockNumber")));
  return {
    url,
    head,
    tx_seen: !!tx,
    in_pool: !!tx && tx.blockNumber === null,
    receipt: rec ? Number(BigInt(rec.status)) : null,
    nonce_latest: latest,
    nonce_pending: pending,
    pending_block_has_tx: !!(pendBlk && pendBlk.transactions && pendBlk.transactions.some((t) => (t.hash || t) === txHash)),
  };
}

/** 判读：in_pool 恒 true 且 receipt 恒 null 且 nonce 有缺口 = 卡单实锤 */
function verdict(sig) {
  if (sig.receipt !== null) return { stuck: false, code: "mined", text: "已有回执：交易已执行，不是卡单" };
  if (sig.in_pool && sig.nonce_pending > sig.nonce_latest) {
    return { stuck: true, code: "stuck", text: "卡单实锤：在池里 + 无回执 + pending nonce 高于 latest" };
  }
  if (sig.in_pool) return { stuck: true, code: "stuck-weak", text: "在池里但 nonce 无缺口：疑似卡单，需再采样确认" };
  return { stuck: false, code: "gone", text: "已不在池里且无回执：交易已被顶掉或被清池" };
}

/** 证据留痕：每次观测/处置都落一行 JSONL（B04 的证据链习惯） */
function record(obj) {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const at = new Date().toISOString();
    const f = path.join(EVIDENCE, `console-${Date.now()}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ at, ...obj }) + "\n");
    return f;
  } catch {
    return null;
  }
}

async function chainState() {
  const head = await provider.getBlockNumber();
  // baseFee 是网络配置的直接证据；gasPrice 只是节点对 pending 交易的估计。
  // 实验会故意发 gasPrice=1/2 的 legacy 交易，因此报价非零不能推断网络配置非零。
  const [gasPriceHex, latestBlock] = await Promise.all([
    rpc(RPC, "eth_gasPrice"),
    rpc(RPC, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const gasPrice = BigInt(gasPriceHex);
  const baseFee = BigInt(latestBlock?.baseFeePerGas ?? 0);
  const nodes = [];
  for (const u of NODES) {
    try {
      const n = Number(BigInt(await rpc(u, "eth_blockNumber")));
      const b = await rpc(u, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
      nodes.push({ url: u, head: n, hash: b ? b.hash : null, ok: true });
    } catch (e) {
      nodes.push({ url: u, ok: false, error: e.message });
    }
  }
  const hashes = nodes.filter((n) => n.ok && n.hash).map((n) => n.hash);
  return {
    ok: true,
    chainId: CHAIN_ID,
    head,
    gasPrice: gasPrice.toString(),
    baseFeePerGas: baseFee.toString(),
    zeroGas: gasPrice === 0n && baseFee === 0n,
    zeroBaseFee: baseFee === 0n,
    nodes,
    finalityConsistent: new Set(hashes).size <= 1 && hashes.length > 0,
    funder: funder.address || null,
    funderBalance: funder.address ? (await provider.getBalance(funder.address)).toString() : null,
  };
}

/** 造一笔卡单：随机账户 + 付不起手续费的 legacy 交易（私钥只留服务端内存） */
async function makeStuck() {
  const net = await provider.getNetwork();
  const wallet = ethers.Wallet.createRandom().connect(provider);
  const signed = await wallet.signTransaction({
    to: wallet.address,
    value: 0n,
    nonce: 0,
    gasLimit: STUCK_GAS,
    gasPrice: STUCK_GAS_PRICE,
    type: 0,
    chainId: Number(net.chainId),
  });
  const txHash = await provider.send("eth_sendRawTransaction", [signed]);
  lab = { wallet, address: wallet.address, txHash, createdAt: new Date().toISOString() };
  const sig = await signals(RPC, txHash);
  record({ kind: "make-stuck", account: lab.address, txHash, signals: sig });
  return { ok: true, account: lab.address, txHash, signals: sig, verdict: verdict(sig) };
}

/** 处置：注入最小余额 → 同 nonce 更高 gasPrice 更低 gas 替换（窗口校验是硬门槛） */
async function resolve(injectWei) {
  if (!lab) throw new Error("没有实验中的卡单：请先点「造一笔卡单」");
  const stuck = await provider.getTransaction(lab.txHash);
  if (!stuck) throw new Error(`链上找不到卡单交易 ${lab.txHash}`);
  const stuckCost = BigInt(stuck.gasLimit) * BigInt(stuck.gasPrice ?? 0n);
  const replaceCost = REPLACEMENT_COST;
  const inject = BigInt(injectWei);
  const inWindow = inject >= replaceCost && inject < stuckCost;

  const plan = {
    inject: inject.toString(),
    replaceCost: replaceCost.toString(),
    stuckCost: stuckCost.toString(),
    lowerBound: replaceCost.toString(),
    upperBound: stuckCost.toString(),
    inWindow,
    faucetAmount: FAUCET_CLAIM_WEI.toString(),
    note: !inWindow
      ? inject < replaceCost
        ? "注入额小于替换成本：替换交易自己付不起手续费，替换会失败"
        : "注入额不小于卡单成本：卡单本身变成可执行，会在原 nonce 直接入块 —— 测的根本不是替换"
      : "窗口成立：替换成本 ≤ 注入额 < 卡单成本",
  };
  if (!inWindow) {
    record({ kind: "resolve-rejected", account: lab.address, txHash: lab.txHash, plan });
    return { ok: false, rejected: true, plan };
  }

  const before = await signals(RPC, lab.txHash, lab.address);
  // 1) 注入最小余额（零 gas：gasPrice=0，但本金照扣）
  const injectTx = await funder.sendTransaction({
    to: lab.address,
    value: inject,
    gasLimit: 21000n,
    gasPrice: 0n,
    type: 0,
  });
  const injectRec = await injectTx.wait();
  // 2) 同 nonce 替换
  const replacement = await lab.wallet.sendTransaction({
    to: lab.address,
    value: 0n,
    nonce: Number(stuck.nonce),
    gasLimit: REPLACE_GAS,
    gasPrice: REPLACE_GAS_PRICE,
    type: 0,
  });
  const rec = await replacement.wait();
  // 3) 判读
  const after = await signals(RPC, lab.txHash, lab.address);
  const stuckExecuted = !!(after.receipt !== null && after.receipt === 1);
  const okReplaced = Number(rec.status) === 1 && after.nonce_latest === Number(stuck.nonce) + 1 && !stuckExecuted;
  const out = {
    ok: okReplaced,
    injectTx: injectTx.hash,
    injectBlock: injectRec.blockNumber,
    replacement: replacement.hash,
    replacementBlock: rec.blockNumber,
    replacementStatus: Number(rec.status),
    before,
    after,
    verdict: verdict(after),
  };
  record({ kind: "resolve", account: lab.address, txHash: lab.txHash, plan, result: out });
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/state") return json(res, 200, await chainState());

    if (url.pathname === "/api/actions") {
      return json(res, 200, {
        ok: true,
        actions: [
          { id: "make-stuck", label: "造一笔卡单", desc: "随机账户发一笔付不起手续费的 legacy 交易（私钥只留服务端）" },
          { id: "observe", label: "观测三信号", desc: "in_pool / receipt / nonce 缺口（跨 3 节点）" },
          { id: "resolve", label: "注入并替换", desc: "窗口校验 → 注入最小余额 → 同 nonce 替换" },
        ],
        notSupported: [
          {
            id: "restart-node",
            label: "重启节点清池",
            why:
              "B04 实测：重启单节点只是临时清掉待处理交易，gossip 会在几分钟内回填；" +
              "真要清干净必须重启所有仍持有它的节点（整个集群 = 停链）。" +
              "既无效又有停链风险，所以本台不提供这个动作。",
            useInstead: "注入最小余额 + 同 nonce 替换（已实测可行）",
          },
        ],
      });
    }

    if (url.pathname.startsWith("/api/tx/")) {
      const txHash = url.pathname.slice("/api/tx/".length);
      const sigs = [];
      for (const u of NODES) {
        try {
          sigs.push(await signals(u, txHash, lab && lab.txHash === txHash ? lab.address : null));
        } catch (e) {
          sigs.push({ url: u, ok: false, error: e.message });
        }
      }
      const tx = await provider.getTransaction(txHash);
      const stuckCost = tx ? BigInt(tx.gasLimit) * BigInt(tx.gasPrice ?? 0n) : null;
      const ev = record({ kind: "observe", txHash, signals: sigs });
      return json(res, 200, {
        ok: true,
        txHash,
        account: tx ? tx.from : null,
        nonce: tx ? Number(tx.nonce) : null,
        gasLimit: tx ? tx.gasLimit.toString() : null,
        gasPrice: tx ? tx.gasPrice?.toString() ?? null : null,
        stuckCost: stuckCost ? stuckCost.toString() : null,
        replaceCost: REPLACEMENT_COST.toString(),
        signals: sigs,
        verdict: sigs[0] && sigs[0].url ? verdict(sigs[0]) : null,
        evidence: ev,
      });
    }

    if (url.pathname === "/api/lab/make-stuck" && req.method === "POST") {
      return json(res, 200, await makeStuck());
    }

    if (url.pathname === "/api/lab/resolve" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const b = JSON.parse(body || "{}");
      return json(res, 200, await resolve(b.inject ?? "100000"));
    }

    // 同源 RPC 反代：浏览器永远只连本服务（联盟网 Besu 的 CORS 白名单为空，直连必被拒）
    if (url.pathname === "/rpc" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      const result = await rpc(RPC, parsed.method, parsed.params || []);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result }));
    }

    // 静态前端
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(FRONTEND, path.normalize(file).replace(/^([/\\])+/, ""));
    if (full.startsWith(FRONTEND) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      res.writeHead(200, {
        "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      return res.end(fs.readFileSync(full));
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[b04] 卡单观测与处置台 http://127.0.0.1:${PORT}`);
  console.log(`  链 ${RPC}（chainId ${CHAIN_ID}） 节点 ${NODES.join(", ")}`);
  console.log(`  注入方 ${funder.address || "（未读到 MEMBER_B_PRIVATE_KEY）"}`);
  console.log(`  替换成本 ${REPLACEMENT_COST} wei · 卡单成本 ${STUCK_COST} wei · 窗口 [${REPLACEMENT_COST}, ${STUCK_COST})`);
});
