// 数据层：node:sqlite（Node 内置，无原生编译）。
// 三个不变式：①幂等写入（主键=链上不可变标识，重扫同区间不重复计数）
//            ②重组回滚 = 删掉高度 > N 的行（blocks/txs/logs 同事务）
//            ③派生状态（assets/holders）由 logs 重放重建，回滚后必重算
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const now = () => Date.now();

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(fs.readFileSync(new URL("./migrations/001-init.sql", import.meta.url), "utf8"));
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this._cache = new Map();
  }
  q(sql) {
    if (!this._cache.has(sql)) this._cache.set(sql, this.db.prepare(sql));
    return this._cache.get(sql);
  }

  // ---- 游标 ----
  getCursor() {
    return this.q("SELECT * FROM cursor WHERE id = 1").get() ?? null;
  }
  setCursor(lastBlock, lastHash, chainKey = null) {
    this.q(
      `INSERT INTO cursor(id, chainKey, lastBlock, lastHash, updatedAt) VALUES(1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lastBlock = excluded.lastBlock, lastHash = excluded.lastHash, updatedAt = excluded.updatedAt`
    ).run(chainKey, lastBlock, lastHash ?? null, now());
  }

  // ---- 写入（全部幂等）----
  insertBlock(b) {
    this.q(
      `INSERT INTO blocks(number, hash, parentHash, timestamp, txCount, indexedAt) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(number) DO UPDATE SET hash = excluded.hash, parentHash = excluded.parentHash,
         timestamp = excluded.timestamp, txCount = excluded.txCount`
    ).run(b.number, b.hash, b.parentHash, b.timestamp, b.txCount ?? 0, now());
  }
  insertTx(t) {
    this.q(
      `INSERT INTO txs(hash, blockNumber, blockHash, txIndex, fromAddr, toAddr, value, input, selector, method, status, gasUsed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET blockNumber = excluded.blockNumber, blockHash = excluded.blockHash,
         txIndex = excluded.txIndex, status = excluded.status, gasUsed = excluded.gasUsed`
    ).run(t.hash, t.blockNumber, t.blockHash, t.txIndex, t.fromAddr, t.toAddr ?? null, t.value, t.input ?? "0x",
      t.selector ?? null, t.method ?? null, t.status ?? null, t.gasUsed ?? null);
  }
  insertLog(l) {
    this.q(
      `INSERT INTO logs(blockNumber, blockHash, txHash, logIndex, address, topic0, topics, data, eventName, decoded, fromAddr, toAddr, tokenId, batch)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(blockHash, logIndex) DO UPDATE SET txHash = excluded.txHash, address = excluded.address,
         topic0 = excluded.topic0, topics = excluded.topics, data = excluded.data, eventName = excluded.eventName,
         decoded = excluded.decoded, fromAddr = excluded.fromAddr, toAddr = excluded.toAddr,
         tokenId = excluded.tokenId, batch = excluded.batch`
    ).run(l.blockNumber, l.blockHash, l.txHash, l.logIndex, l.address, l.topic0 ?? null, l.topics, l.data,
      l.eventName ?? null, l.decoded ?? null, l.fromAddr ?? null, l.toAddr ?? null, l.tokenId ?? null, l.batch ?? null);
  }

  getBlock(number) {
    return this.q("SELECT * FROM blocks WHERE number = ?").get(number) ?? null;
  }

  // ---- 重组回滚：删掉高度 > number 的一切（同事务），游标退回 ----
  rollbackTo(number) {
    this.db.exec("BEGIN");
    try {
      this.q("DELETE FROM logs WHERE blockNumber > ?").run(number);
      this.q("DELETE FROM txs WHERE blockNumber > ?").run(number);
      this.q("DELETE FROM blocks WHERE number > ?").run(number);
      const b = this.getBlock(number);
      this.setCursor(number, b ? b.hash : null);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.rebuildAssets();
    return number;
  }

  // ---- 派生状态重放：assets/holders 全部由 logs 重算（回滚后必调）----
  rebuildAssets() {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM assets; DELETE FROM holders;");
      const rows = this.q(
        `SELECT address, eventName, decoded, tokenId, fromAddr, toAddr FROM logs
         WHERE eventName IN ('Transfer', 'TransferSingle') ORDER BY blockNumber, logIndex`
      ).all();
      const holders = new Map(); // contract|addr -> count
      const bump = (contract, addr, delta) => {
        const k = contract.toLowerCase() + "|" + addr.toLowerCase();
        const v = (holders.get(k) ?? 0) + delta;
        holders.set(k, v);
      };
      for (const r of rows) {
        const contract = r.address;
        const zero = "0x0000000000000000000000000000000000000000";
        if (r.eventName === "Transfer") {
          const from = r.fromAddr ?? zero;
          const to = r.toAddr ?? zero;
          const tokenId = r.tokenId ?? "";
          if (from !== zero) bump(contract, from, -1);
          if (to === zero) {
            // burn：资产销毁，holder 与 assets 同步减，保持 Σholders == #assets 的不变式
            this.q("DELETE FROM assets WHERE contract = ? AND tokenId = ?").run(contract, tokenId);
          } else {
            bump(contract, to, +1);
            this.q(
              `INSERT INTO assets(contract, tokenId, standard, owner, uri, updatedAt) VALUES(?, ?, 'erc721', ?, NULL, ?)
               ON CONFLICT(contract, tokenId) DO UPDATE SET owner = excluded.owner, updatedAt = excluded.updatedAt`
            ).run(contract, tokenId, to, now());
          }
        } else if (r.eventName === "TransferSingle") {
          const d = r.decoded ? JSON.parse(r.decoded) : {};
          const from = r.fromAddr ?? zero;
          const to = r.toAddr ?? zero;
          const qty = Number(d.value ?? 1);
          if (from !== zero) bump(contract, from, -qty);
          if (to !== zero) bump(contract, to, +qty);
        }
      }
      for (const [k, v] of holders) {
        if (v <= 0) continue;
        const [contract, address] = k.split("|");
        this.q("INSERT INTO holders(contract, address, tokens) VALUES(?, ?, ?) ON CONFLICT(contract, address) DO UPDATE SET tokens = excluded.tokens")
          .run(contract, address, v);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- 统计（看板卡片）----
  stats() {
    const one = (sql) => this.q(sql).get();
    return {
      blocks: one("SELECT COUNT(*) c FROM blocks").c,
      txs: one("SELECT COUNT(*) c FROM txs").c,
      logs: one("SELECT COUNT(*) c FROM logs").c,
      assets: one("SELECT COUNT(*) c FROM assets").c,
      holders: one("SELECT COUNT(*) c FROM holders").c,
      events: this.q("SELECT eventName, COUNT(*) c FROM logs GROUP BY eventName ORDER BY c DESC").all(),
      lastBlock: this.getCursor()?.lastBlock ?? null,
    };
  }

  // ---- 查询：游标分页（cursor = "blockNumber:logIndex"，按 (blockNumber, logIndex) 倒序，翻页稳定）----
  queryLogs(f = {}, { after = null, limit = 20 } = {}) {
    const where = [];
    const args = [];
    // 地址列入库时统一小写 → 查询也小写；eventName/tokenId/batch 大小写敏感（Transfer≠transfer）
    const eqLc = (col, val) => {
      if (val) {
        where.push(`${col} = ?`);
        args.push(String(val).toLowerCase());
      }
    };
    const eq = (col, val) => {
      if (val) {
        where.push(`${col} = ?`);
        args.push(String(val));
      }
    };
    eqLc("address", f.address);
    eq("eventName", f.eventName);
    eqLc("fromAddr", f.fromAddr);
    eqLc("toAddr", f.toAddr);
    eq("tokenId", f.tokenId);
    eq("batch", f.batch);
    if (f.blockFrom != null) { where.push("blockNumber >= ?"); args.push(Number(f.blockFrom)); }
    if (f.blockTo != null) { where.push("blockNumber <= ?"); args.push(Number(f.blockTo)); }
    if (f.q) { where.push("(txHash LIKE ? OR address LIKE ? OR decoded LIKE ?)"); const like = `%${f.q}%`; args.push(like, like, like); }
    if (after) {
      const [b, i] = String(after).split(":").map(Number);
      where.push("(blockNumber < ? OR (blockNumber = ? AND logIndex < ?))");
      args.push(b, b, i);
    }
    const sql = `SELECT * FROM logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY blockNumber DESC, logIndex DESC LIMIT ?`;
    args.push(Number(limit) + 1);
    const rows = this.q(sql).all(...args);
    const items = rows.slice(0, Number(limit));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > Number(limit) && last ? `${last.blockNumber}:${last.logIndex}` : null,
    };
  }

  queryTxs(f = {}, { after = null, limit = 20 } = {}) {
    const where = [];
    const args = [];
    if (f.fromAddr) { where.push("fromAddr = ?"); args.push(f.fromAddr.toLowerCase()); }
    if (f.toAddr) { where.push("toAddr = ?"); args.push(f.toAddr.toLowerCase()); }
    if (f.blockFrom != null) { where.push("blockNumber >= ?"); args.push(Number(f.blockFrom)); }
    if (after) {
      const [b, i] = String(after).split(":").map(Number);
      where.push("(blockNumber < ? OR (blockNumber = ? AND txIndex < ?))");
      args.push(b, b, i);
    }
    const sql = `SELECT * FROM txs ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY blockNumber DESC, txIndex DESC LIMIT ?`;
    args.push(Number(limit) + 1);
    const rows = this.q(sql).all(...args);
    const items = rows.slice(0, Number(limit));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > Number(limit) && last ? `${last.blockNumber}:${last.txIndex}` : null,
    };
  }
}

