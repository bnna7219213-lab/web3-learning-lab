// 多节点探针：浏览器打的是 nginx 轮询池（/b03-rpc/），无法定点查"某一台"，
// 而"4 个验证者里有几个活着""同一笔余额在各节点是否一致"这两件事必须按节点分别问。
// 所以探针跑在服务端（索引器进程内），前端只读结论。
//
// 这是 api.js "全部只读 SQLite、不回链" 原则的**唯一例外**，且是有意为之：
// 一致性核验的语义就要求真的去问每个节点，用缓存值自证等于没证。
const cfg = require("./config");

async function call(url, method, params = [], timeoutMs = 4000) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code ?? ""} ${j.error.message ?? ""}`.trim());
  return { result: j.result, ms: Date.now() - t0 };
}

const num = (h) => (h == null ? null : Number(BigInt(h)));

// QBFT n=4 → f=1 → quorum=2f+1=3。在线数低于 quorum 就停链，且 RPC 照样全通，
// 所以"进程在不在"不能当健康指标，只有"高度会不会涨"才是。
function quorumOf(validatorCount) {
  const f = Math.floor((validatorCount - 1) / 3);
  return { f, quorum: 2 * f + 1 };
}

async function probeNodes() {
  const rows = await Promise.all(cfg.NODES.map(async (url) => {
    const label = url.replace(/^https?:\/\//, "").replace(/:\/?$/, "");
    try {
      const [bn, peers, gp] = await Promise.all([
        call(url, "eth_blockNumber"), call(url, "net_peerCount"), call(url, "eth_gasPrice"),
      ]);
      return {
        url, label, ok: true,
        blockNumber: num(bn.result),
        peerCount: num(peers.result),
        gasPrice: num(gp.result),
        latencyMs: bn.ms,
      };
    } catch (e) {
      return { url, label, ok: false, error: e.message, blockNumber: null, latencyMs: null };
    }
  }));

  const online = rows.filter((r) => r.ok);
  const heights = online.map((r) => r.blockNumber);
  const spread = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
  // 5s 出块，节点间差 1–2 块是轮询时差，属正常；差太多才是某台在追块
  const heightsAgree = heights.length === 0 ? false : spread <= 2;
  const gasPriceDrift = online.filter((r) => r.gasPrice !== 0).map((r) => r.label);
  const { f, quorum } = quorumOf(cfg.VALIDATORS_EXPECTED);

  return {
    nodes: rows,
    online: online.length,
    total: cfg.NODES.length,
    validatorsExpected: cfg.VALIDATORS_EXPECTED,
    quorum,
    // 容错余量：还能再挂几台而不停链
    faultTolerance: Math.max(0, online.length - quorum),
    heightsAgree,
    maxBlock: heights.length ? Math.max(...heights) : null,
    heightSpread: spread,
    // ③ 风险点：任何节点 min-gas-price > 0 会静默丢弃零 gas 交易，这里直接点名
    gasPriceDriftNodes: gasPriceDrift,
    healthy: online.length >= quorum && heightsAgree && gasPriceDrift.length === 0,
  };
}

// 按地址做跨节点一致性核验：同一个 getBalance/getTransactionCount 问每台
async function probeAddress(addr) {
  const a = addr.toLowerCase();
  const rows = await Promise.all(cfg.NODES.map(async (url) => {
    try {
      const [bal, nonce, code] = await Promise.all([
        call(url, "eth_getBalance", [a, "latest"]),
        call(url, "eth_getTransactionCount", [a, "latest"]),
        call(url, "eth_getCode", [a, "latest"]),
      ]);
      return {
        url, ok: true,
        balance: BigInt(bal.result).toString(10),
        nonce: num(nonce.result),
        hasCode: code.result && code.result !== "0x",
        codeSize: code.result ? Math.max(0, (code.result.length - 2) / 2) : 0,
      };
    } catch (e) {
      return { url, ok: false, error: e.message };
    }
  }));
  const ok = rows.filter((r) => r.ok);
  const bals = new Set(ok.map((r) => r.balance));
  const nonces = new Set(ok.map((r) => r.nonce));
  return {
    address: a,
    nodes: rows.map((r) => ({ url: r.url, ok: r.ok, balance: r.balance ?? null, nonce: r.nonce ?? null, error: r.error ?? null })),
    checked: ok.length,
    balanceAgree: ok.length > 0 && bals.size === 1,
    nonceAgree: ok.length > 0 && nonces.size === 1,
    agree: ok.length > 0 && bals.size === 1 && nonces.size === 1,
  };
}

// 短 TTL 缓存：前端 5s 轮询会同时打好几个端点，不去重的话每轮打 N 台 ×3 次
let cache = { at: 0, data: null };
async function nodesCached(ttlMs = 4000) {
  const now = Date.now();
  if (cache.data && now - cache.at < ttlMs) return cache.data;
  const data = await probeNodes();
  cache = { at: now, data };
  return data;
}

module.exports = { probeNodes, probeAddress, nodesCached, quorumOf };
