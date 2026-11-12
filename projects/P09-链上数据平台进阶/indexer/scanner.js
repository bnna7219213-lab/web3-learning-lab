// 扫块与日志过滤（address/topics）+ 区块重组处理（confirmations 深度 + 回滚重放）。
//
// 重组协议（三步，全部在 syncOnce 里）：
//   1. 链高 < 游标高  → 链回卷：rollbackTo(链高)
//   2. parentHash 不连续 → 找公共祖先 findCommonAncestor() → rollbackTo(祖先) → 重放
//   3. 向前扫 safe = head - confirmations 的区间，幂等写入
// 回滚后派生状态（assets/holders）由 logs 全量重放重建。
import { ethers } from "ethers";
import { decodeLog, decodeMethod } from "./abi.js";

export async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const qty = (n) => ethers.toQuantity(n);

export class Scanner {
  constructor({ store, rpc, contracts = [], confirmations = 2, logChunk = 2000, startBlock = 0, chainKey = "" }) {
    this.store = store;
    this.rpc = rpc;
    this.contracts = contracts;
    this.confirmations = confirmations;
    this.logChunk = logChunk;
    this.startBlock = startBlock;
    this.chainKey = chainKey;
  }

  async head() {
    return Number(await rpcCall(this.rpc, "eth_blockNumber"));
  }

  async syncOnce() {
    // 聚合整个调用周期内的重组信息：即使重试后扫描成功，也要让调用方知道发生过回滚
    let reorgDuring = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this._attempt();
      if (r.reorg) {
        reorgDuring = r;
        continue;
      }
      return { ...r, reorgDuring };
    }
    throw new Error("重组检测连续触发 5 次仍未稳定，请人工核对链状态");
  }

  async _attempt() {
    const head = await this.head();
    const safe = head - this.confirmations;
    const cur = this.store.getCursor();

    // 1) 链回卷：链高已经低于游标高（evm_revert / 节点换链）
    if (cur && cur.lastBlock > head) {
      const to = await this.findCommonAncestor(head);
      this.store.rollbackTo(to);
      return { reorg: true, kind: "rewind", rolledBackTo: to, head, safe };
    }

    // 2) 分叉：游标块在链上换了哈希（或已消失）
    if (cur && cur.lastBlock >= this.startBlock) {
      const ancestor = await this.findCommonAncestor(cur.lastBlock);
      if (ancestor < cur.lastBlock) {
        this.store.rollbackTo(ancestor);
        return { reorg: true, kind: "fork", rolledBackTo: ancestor, head, safe };
      }
    }

    // 3) 向前扫（区间幂等，可断点续扫）
    let from = (this.store.getCursor()?.lastBlock ?? this.startBlock - 1) + 1;
    if (from < this.startBlock) from = this.startBlock;
    let ingestedLogs = 0;
    let touchedTransfers = false;
    for (; from <= safe; from += this.logChunk) {
      const to = Math.min(from + this.logChunk - 1, safe);
      const r = await this.ingestRange(from, to);
      ingestedLogs += r.logs;
      touchedTransfers = touchedTransfers || r.touchedTransfers;
    }
    if (touchedTransfers) this.store.rebuildAssets();
    return { reorg: false, head, safe, ingestedLogs, cursor: this.store.getCursor() };
  }

  /** 从 n 往下找最后一个「本地与链上哈希一致」的高度；全不一致返回 startBlock-1 */
  async findCommonAncestor(n) {
    for (let i = n; i >= this.startBlock; i--) {
      const local = this.store.getBlock(i);
      if (!local) return i; // 本地没有该高度 → 从这里续扫即可
      const remote = await rpcCall(this.rpc, "eth_getBlockByNumber", [qty(i), false]);
      if (!remote) return i - 1; // 链上高度消失（回卷）
      if (remote.hash === local.hash) return i;
    }
    return this.startBlock - 1;
  }

  async ingestRange(from, to) {
    let logsCount = 0;
    let touchedTransfers = false;

    for (let n = from; n <= to; n++) {
      const blk = await rpcCall(this.rpc, "eth_getBlockByNumber", [qty(n), true]);
      if (!blk) break;
      // 连续性校验：parentHash 必须接上本地上一块
      const prev = this.store.getBlock(n - 1);
      if (prev && prev.hash !== blk.parentHash) {
        // 分叉就在 n-1 处：交给 syncOnce 的回滚协议
        this.store.rollbackTo(await this.findCommonAncestor(n - 1));
        return { logs: 0, touchedTransfers: false, reorg: true };
      }
      this.store.insertBlock({
        number: n,
        hash: blk.hash,
        parentHash: blk.parentHash,
        timestamp: Number(BigInt(blk.timestamp)),
        txCount: blk.transactions.length,
      });
      for (let i = 0; i < blk.transactions.length; i++) {
        const tx = blk.transactions[i];
        const { selector, method } = decodeMethod(tx.input);
        this.store.insertTx({
          hash: tx.hash,
          blockNumber: n,
          blockHash: blk.hash,
          txIndex: Number(BigInt(tx.transactionIndex ?? i)),
          fromAddr: (tx.from || "").toLowerCase(),
          toAddr: tx.to ? tx.to.toLowerCase() : null,
          value: BigInt(tx.value ?? 0).toString(),
          input: tx.input ?? "0x",
          selector,
          method,
          status: null, // 回执稍后补（批量）
          gasUsed: null,
        });
      }
    }

    // 日志：按合约过滤（address），topics 不设限 → 未知事件也入库（可查询、可出证）
    const filter = { fromBlock: qty(from), toBlock: qty(to) };
    if (this.contracts.length) filter.address = this.contracts;
    const logs = await rpcCall(this.rpc, "eth_getLogs", [filter]);
    for (const l of logs) {
      const d = decodeLog(l);
      this.store.insertLog({
        blockNumber: Number(BigInt(l.blockNumber)),
        blockHash: l.blockHash,
        txHash: l.transactionHash,
        logIndex: Number(BigInt(l.logIndex)),
        address: l.address.toLowerCase(),
        topic0: l.topics[0] ?? null,
        topics: JSON.stringify(l.topics),
        data: l.data,
        eventName: d.eventName,
        decoded: d.decoded,
        fromAddr: d.fromAddr ? d.fromAddr.toLowerCase() : null,
        toAddr: d.toAddr ? d.toAddr.toLowerCase() : null,
        tokenId: d.tokenId,
        batch: d.batch,
      });
      logsCount++;
      if (d.eventName === "Transfer" || d.eventName === "TransferSingle") touchedTransfers = true;
    }

    const last = this.store.getBlock(to) ?? this.store.getBlock(to - 1);
    if (last) this.store.setCursor(last.number, last.hash, this.chainKey);
    return { logs: logsCount, touchedTransfers };
  }
}

