// b03-indexer 扫块器：批量拉块+回执 → 单事务写入 → 推进游标
// 原则：游标只在整批写入成功后推进；失败退避重试不丢块；追平链头才背压 sleep
const db = require("./db");
const { extractTransfers, fetchTokenMeta } = require("./erc20");
const cfg = require("./config");

async function rpcCall(method, params = []) {
  const r = await fetch(cfg.RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code ?? ""} ${j.error.message ?? ""}`.trim());
  return j.result;
}

const num = (h) => (h == null ? 0 : Number(BigInt(h)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanBatch(d, provider, from) {
  const head = num(await rpcCall("eth_blockNumber"));
  const to = Math.min(from + cfg.BATCH - 1, head);
  if (to < from) return { done: 0, head };

  // 批量取块（带交易对象）与整块回执
  const blockNums = [];
  for (let n = from; n <= to; n++) blockNums.push("0x" + n.toString(16));
  const blocks = [];
  const receipts = [];
  for (const tag of blockNums) {
    const [b, rc] = await Promise.all([
      rpcCall("eth_getBlockByNumber", [tag, true]),
      rpcCall("eth_getBlockReceipts", [tag]),
    ]);
    if (!b) {
      // 链头附近的块偶发返回 null（节点尚未持久化完）→ 截断本批，下次从该高度续扫
      console.warn(`[scanner] 块 ${tag} 暂不可读，截断本批到 ${blocks.length} 块`);
      break;
    }
    blocks.push(b);
    receipts.push(rc || []);
  }
  if (!blocks.length) return { done: 0, head };
  const lastBlock = from + blocks.length - 1; // 中途截断时以此为准，避免游标跳块

  const seenTokens = new Set();
  const created = [];   // 本批新合约：字节码指纹要 eth_getCode（异步），留到事务外做
  const write = d.transaction(() => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const n = num(b.number);
      db.insertBlock(d, {
        number: n, hash: b.hash, parentHash: b.parentHash,
        timestamp: num(b.timestamp), txCount: (b.transactions || []).length,
        gasUsed: num(b.gasUsed),
      });
      for (let ti = 0; ti < (b.transactions || []).length; ti++) {
        const t = b.transactions[ti];
        const rec = (receipts[i] || []).find((r) => r.transactionHash === t.hash) || {};
        db.insertTx(d, {
          hash: t.hash,
          blockNumber: n,
          txIndex: ti,
          from: String(t.from).toLowerCase(),
          to: t.to ? String(t.to).toLowerCase() : null,
          value: BigInt(t.value || "0x0").toString(10),
          input: t.input || "0x",
          nonce: num(t.nonce),
          status: rec.status === "0x1" ? 1 : 0,
          gasUsed: rec.gasUsed ? num(rec.gasUsed) : 0,
          contractAddress: rec.contractAddress ? String(rec.contractAddress).toLowerCase() : null,
        });
        if (rec.contractAddress && rec.status === "0x1") {
          created.push({
            address: String(rec.contractAddress).toLowerCase(),
            creator: String(t.from).toLowerCase(),
            deployTx: t.hash,
            blockNumber: n,
          });
        }
      }
      for (const r of receipts[i] || []) {
        for (const x of extractTransfers(r)) {
          db.insertTransfer(d, x);
          seenTokens.add(x.token);
        }
      }
    }
    db.setMeta(d, "last_scanned", lastBlock);
  });
  write();

  // 合约 runtime 字节码指纹：链上事实，不依赖任何人登记。
  // 存的是 keccak(getCode(addr,"latest"))，注意是"当前"字节码——代理合约或自毁重建会变，
  // 所以它在事务外、每批都刷（同一地址重复 upsert 成本可忽略），保证指纹不腐化。
  for (const c of created) {
    try {
      const code = await rpcCall("eth_getCode", [c.address, "latest"]);
      c.deployedHash = code && code !== "0x" ? require("ethers").keccak256(code) : null;
      c.deployedSize = code ? Math.max(0, (code.length - 2) / 2) : 0;
      db.upsertContractCreated(d, c);
    } catch (e) {
      console.warn(`[scanner] 合约 ${c.address} 取字节码失败（下批重试）：`, e.message);
    }
  }

  // 元数据拉取放在事务外（异步 eth_call），失败不影响游标。
  // 每批对「涉及的代币」都刷新元数据：total_supply 只在 mint/transfer 时变化（必带 Transfer 事件），
  // 所以最后一次刷新值 == 当前链上供应量；只在首次出现时缓存会导致 total_supply 停在旧快照。
  for (const token of seenTokens) {
    const meta = await fetchTokenMeta(provider, token, lastBlock).catch(() => ({
      address: token, name: null, symbol: null, decimals: null, totalSupply: null, firstBlock: lastBlock,
    }));
    db.upsertToken(d, meta);
  }
  return { done: blocks.length, head };
}

// 续扫 + 重组保护：游标处块 hash 与链上不一致 → 删 ≥ 该高度重扫
async function reorgCheck(d) {
  const last = Number(db.getMeta(d, "last_scanned") ?? -1);
  if (last < 0) return;
  const local = d.prepare("SELECT hash FROM blocks WHERE number=?").get(last);
  const remote = await rpcCall("eth_getBlockByNumber", ["0x" + last.toString(16), false]).catch(() => null);
  if (local && remote && local.hash !== remote.hash) {
    console.warn(`[scanner] 检测到分叉 @${last}：${local.hash} != ${remote.hash}，删 ≥${last} 重扫`);
    db.deleteFrom(d, last);
    db.setMeta(d, "last_scanned", last - 1);
  }
}

async function run() {
  const d = db.open(cfg.DB_PATH);
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(cfg.RPC, cfg.CHAIN_ID, { staticNetwork: true });

  console.log(`[scanner] 启动 RPC=${cfg.RPC} DB=${cfg.DB_PATH} 游标=${db.getMeta(d, "last_scanned") ?? "空（从 0 起）"}`);
  for (;;) {
    try {
      await reorgCheck(d);
      let from = Number(db.getMeta(d, "last_scanned") ?? -1) + 1;
      const { done, head } = await scanBatch(d, provider, from);
      if (done === 0) {
        await sleep(cfg.IDLE_MS);          // 追平链头 → 背压
      } else {
        console.log(`[scanner] 扫入 ${done} 块 → ${from + done - 1} / 链头 ${head}`);
        // 追块期不 sleep；仅在追平时自然进入下一轮的 sleep 分支
        if (from + done > head) await sleep(cfg.IDLE_MS);
      }
    } catch (e) {
      console.error(`[scanner] 批失败（游标不推进，${cfg.RETRY_MS}ms 后重试）：`, e.message);
      await sleep(cfg.RETRY_MS);
    }
  }
}

module.exports = { run, rpcCall };
