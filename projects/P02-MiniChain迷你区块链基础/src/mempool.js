// 待打包交易池：进池即做形/签名/状态预检，并实现「同 nonce 高费替换」这条真实链都有的规则。
import { checkTx, txId, precheck } from "./tx.js";

export function createMempool() {
  const byId = new Map();
  const bySenderNonce = new Map(); // `${from}:${nonce}` -> tx

  const key = (tx) => `${tx.from}:${tx.nonce}`;

  return {
    get size() {
      return byId.size;
    },
    list() {
      return [...byId.values()];
    },
    async add(tx, state) {
      const shape = await checkTx(tx);
      if (!shape.ok) return { ok: false, reason: shape.reason };
      const id = await txId(tx);
      if (byId.has(id)) return { ok: false, reason: "重复交易（已在池中）" };

      const pre = precheck(state, tx);
      if (!pre.ok) return { ok: false, reason: pre.reason };

      const k = key(tx);
      const existing = bySenderNonce.get(k);
      if (existing) {
        if (tx.fee <= existing.fee) return { ok: false, reason: `同 nonce 手续费未超过已有一笔（${existing.fee}）` };
        byId.delete(await txId(existing)); // 替换：低费的那条退出
      }
      byId.set(id, tx);
      bySenderNonce.set(k, tx);
      return { ok: true, reason: "" };
    },
    async remove(tx) {
      // 两张表都要删：只删索引会让已上链的交易继续被选中，下一块就因 nonce 冲突永远出不来
      const id = await txId(tx);
      byId.delete(id);
      bySenderNonce.delete(key(tx));
      return true;
    },
    removeIds(ids) {
      for (const [id, tx] of byId) {
        if (ids.includes(id)) {
          byId.delete(id);
          bySenderNonce.delete(key(tx));
        }
      }
    },
    // 重组后把被丢弃的交易放回池里（先清掉索引，避免与已在链上的重复计数）
    async readd(txs) {
      for (const tx of txs) {
        const id = await txId(tx);
        if (!byId.has(id)) {
          byId.set(id, tx);
          bySenderNonce.set(key(tx), tx);
        }
      }
    },
    // 打包顺序：手续费高的优先（这是「费用市场」的最小形态）
    select(limit = 20) {
      return [...byId.values()].sort((a, b) => b.fee - a.fee || a.nonce - b.nonce).slice(0, limit);
    },
  };
}
