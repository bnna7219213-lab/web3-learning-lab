// 节点：HTTP 做 P2P（gossip 广播）+ 状态机（链、账本、交易池）+ 出块循环。
// 只绑定 127.0.0.1：这是本地学习网络，不要暴露到公网。
import { createServer } from "node:http";
import { applyTx, txId } from "./tx.js";
import { createGenesis, sealBlock, validateBlock, proposerFor } from "./block.js";
import { replayChain, planAdoption, chainWeight, confirmations } from "./chain.js";
import { createMempool } from "./mempool.js";

const MAX_BODY = 1_000_000;

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const send = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

/**
 * 面板跑在 tools/serve.mjs（:8787），节点在 :53xx，属于跨源请求。
 * 只放行本机来源，不用 `*`：这是一份要给别人看的代码，默认值就该是安全的。
 */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createNode(options) {
  const {
    port,
    name = `node-${port}`,
    peers = [],
    consensus = "pow",
    difficulty = 2,
    validatorSet = [],
    wallet,
    allocations = [],
    intervalMs = 1500,
    quiet = false,
  } = options;

  const log = (...args) => {
    if (!quiet) console.log(`[${name}]`, ...args);
  };

  const mempool = createMempool();
  const genesis = await createGenesis(validatorSet[0] ?? wallet.address, consensus, difficulty, allocations);
  let chain = [genesis];
  let state = (await replayChain(chain, { validators: validatorSet })).state;
  const stats = { mined: 0, received: 0, rejected: 0, adopted: 0, reorgs: 0, txSeen: 0 };

  const tip = () => chain.at(-1);

  /** 结构 + 链接 + 状态三层校验后追加；失败原因一律回给调用方。 */
  async function tryAppend(block) {
    if (block.index !== chain.length) return { ok: false, reason: `高度不匹配：期望 ${chain.length}，收到 ${block.index}` };
    if (block.prevHash !== tip().hash) return { ok: false, reason: "prevHash 未接上本地链尖" };
    const shape = await validateBlock(block, { validatorSet });
    if (!shape.ok) return { ok: false, reason: shape.reason };

    const next = structuredClone(state);
    for (const tx of block.txs) {
      const applied = applyTx(next, tx, block.proposer);
      if (!applied.ok) return { ok: false, reason: `区块内交易无效：${applied.reason}` };
    }
    chain.push(block);
    state = next;
    for (const tx of block.txs) await mempool.remove(tx);
    stats.received += 1;
    return { ok: true, reason: "" };
  }

  /** 拿到别人的整条链：只在严格更重时切换，并把被丢弃的交易放回池里。 */
  async function adoptIfHeavier(remoteChain) {
    if (!Array.isArray(remoteChain) || !remoteChain.length) return { adopted: false, reason: "空链" };
    const plan = planAdoption(chain, remoteChain, { validators: validatorSet });
    if (!plan.adopt) return { adopted: false, reason: plan.reason };
    const replay = await replayChain(plan.newChain, { validators: validatorSet });
    if (!replay.ok) return { adopted: false, reason: `对方链无效：${replay.reason}` };

    const lost = chain.length - (plan.forkAt + 1);
    chain = plan.newChain;
    state = replay.state;
    mempool.removeIds(await Promise.all(chain.flatMap((b) => b.txIds)));
    await mempool.readd(plan.orphanedTxs);
    stats.adopted += 1;
    if (lost > 0) stats.reorgs += 1;
    log(`重组：丢弃 ${lost} 块（共同祖先 #${plan.forkAt}），回炉 ${plan.orphanedTxs.length} 笔交易 ｜ ${plan.reason}`);
    return { adopted: true, reason: plan.reason, orphaned: plan.orphanedTxs.length };
  }

  async function broadcast(kind, payload) {
    await Promise.allSettled(
      peers.map(async (peer) => {
        try {
          if (kind === "block") {
            const answer = await postJson(`${peer}/block`, payload);
            if (!answer.accepted) {
              // 接不上就说明我们落后或分叉了：拉对方整条链来比权重
              await adoptIfHeavier(await getJson(`${peer}/chain`).then((r) => r.chain));
            }
          } else {
            await postJson(`${peer}/tx`, payload);
          }
        } catch (error) {
          log(`广播到 ${peer} 失败：${error.message}（对方可能已下线）`);
        }
      })
    );
  }

  async function mine({ broadcast: gossip = true } = {}) {
    if (consensus === "pos" && proposerFor(validatorSet, chain.length) !== wallet.address) {
      return { ok: false, reason: "未到本节点轮次" };
    }
    // 先在状态副本上预演一遍，丢掉此刻不可执行的交易：
    // 否则只要池里留一条过期交易，这个节点就再也出不了块（真实节点就是这么防自锁的）。
    const probe = structuredClone(state);
    const txs = [];
    for (const tx of mempool.select(20)) {
      if (applyTx(probe, tx, wallet.address).ok) txs.push(tx);
    }
    const block = await sealBlock(
      {
        index: chain.length,
        prevHash: tip().hash,
        txs,
        proposer: wallet.address,
        consensus,
        difficulty,
      },
      { validatorSet }
    );
    if (!block) return { ok: false, reason: "出块失败（轮值不匹配或超出尝试上限）" };
    const appended = await tryAppend(block);
    if (!appended.ok) return { ok: false, reason: appended.reason };
    stats.mined += 1;
    if (gossip) await broadcast("block", block);
    return { ok: true, block };
  }

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, {
          name,
          port,
          address: wallet.address,
          peers,
          consensus,
          difficulty,
          height: chain.length - 1,
          tip: tip().hash,
          weight: chainWeight(chain),
          mempool: mempool.size,
          stats,
          balances: state.accounts,
        });
      }
      if (req.method === "GET" && url.pathname === "/chain") return send(res, 200, { chain });
      if (req.method === "GET" && url.pathname === "/mempool") return send(res, 200, { txs: mempool.list() });
      if (req.method === "GET" && url.pathname === "/balance") {
        const addr = url.searchParams.get("addr");
        return send(res, 200, { addr, account: state.accounts[addr] ?? { balance: 0, nonce: 0 } });
      }
      if (req.method === "GET" && url.pathname === "/confirm") {
        const hash = url.searchParams.get("hash");
        return send(res, 200, { hash, confirmations: confirmations(chain, hash) });
      }

      if (req.method === "POST" && url.pathname === "/tx") {
        const tx = await readJson(req);
        const added = await mempool.add(tx, state);
        if (!added.ok) {
          stats.rejected += 1;
          return send(res, 400, { accepted: false, reason: added.reason });
        }
        stats.txSeen += 1;
        if (url.searchParams.get("gossip") !== "0") await broadcast("tx", tx);
        return send(res, 200, { accepted: true, id: await txId(tx) });
      }

      if (req.method === "POST" && url.pathname === "/block") {
        const block = await readJson(req);
        const appended = await tryAppend(block);
        if (appended.ok) return send(res, 200, { accepted: true, height: chain.length - 1 });
        stats.rejected += 1;
        return send(res, 200, { accepted: false, reason: appended.reason });
      }

      if (req.method === "POST" && url.pathname === "/sync") {
        const { chain: remote } = await readJson(req);
        return send(res, 200, await adoptIfHeavier(remote));
      }

      if (req.method === "POST" && url.pathname === "/mine") {
        const gossip = url.searchParams.get("broadcast") !== "false";
        return send(res, 200, await mine({ broadcast: gossip }));
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        send(res, 200, { bye: true });
        setTimeout(() => server.close(() => process.exit(0)), 50);
        return;
      }
      return send(res, 404, { error: "未知路径" });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  });

  // 注意：不能用 .listen() 后再 once("listening")——本机端口通常几十微秒就就绪，
  // 监听器注册晚于事件就会永久挂住（这个坑真实踩过，测试全部超时）。
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  // 冷启动追赶：新加入或重启的节点先向邻居要整条链，比完权重再决定接受与否
  for (const peer of peers) {
    try {
      const { chain: remote } = await getJson(`${peer}/chain`);
      const result = await adoptIfHeavier(remote);
      if (result.adopted) {
        log(`启动追赶：从 ${peer} 同步到高度 ${chain.length - 1}`);
        break;
      }
    } catch {
      /* 邻居没起来就跳过，后续靠广播/手动 sync 补齐 */
    }
  }

  const timer = setInterval(() => mine().catch(() => {}), intervalMs);
  timer.unref?.();

  return {
    name,
    port,
    address: wallet.address,
    url: `http://127.0.0.1:${port}`,
    get chain() {
      return chain;
    },
    get state() {
      return state;
    },
    mempool,
    mine,
    stop: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        // fetch 默认 keep-alive：不主动断开连接，server.close() 会一直挂着
        server.closeAllConnections?.();
        server.close(resolve);
      }),
    submitTx: (tx) => postJson(`http://127.0.0.1:${port}/tx`, tx),
    status: () => getJson(`http://127.0.0.1:${port}/status`),
    fetchChain: () => getJson(`http://127.0.0.1:${port}/chain`).then((r) => r.chain),
    syncFrom: (remoteChain) => postJson(`http://127.0.0.1:${port}/sync`, { chain: remoteChain }),
  };
}
