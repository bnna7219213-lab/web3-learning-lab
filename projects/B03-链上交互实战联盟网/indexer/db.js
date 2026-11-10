// b03-indexer 存储层：better-sqlite3（Node20 无内置 node:sqlite；服务器有 gcc/make 可源码编译装）
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA cache_size=2000;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS blocks (
  number      INTEGER PRIMARY KEY,
  hash        TEXT UNIQUE,
  parent_hash TEXT,
  timestamp   INTEGER,
  tx_count    INTEGER,
  gas_used    INTEGER
);

CREATE TABLE IF NOT EXISTS txs (
  hash             TEXT PRIMARY KEY,
  block_number     INTEGER,
  tx_index         INTEGER,
  from_addr        TEXT,
  to_addr          TEXT,
  value            TEXT,        -- wei 十进制字符串（bigint 用 TEXT，避免浮点）
  input            TEXT,
  nonce            INTEGER,
  status           INTEGER,     -- 1 成功 / 0 失败
  gas_used         INTEGER,
  contract_address TEXT         -- 合约创建时新合约地址
);
CREATE INDEX IF NOT EXISTS idx_txs_from ON txs(from_addr, block_number);
CREATE INDEX IF NOT EXISTS idx_txs_to   ON txs(to_addr,   block_number);
CREATE INDEX IF NOT EXISTS idx_txs_block ON txs(block_number);

CREATE TABLE IF NOT EXISTS token_transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash      TEXT,
  block_number INTEGER,
  log_index    INTEGER,
  token        TEXT,            -- 代币合约地址
  from_addr    TEXT,
  to_addr      TEXT,
  value        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tt_token ON token_transfers(token, block_number);
CREATE INDEX IF NOT EXISTS idx_tt_from  ON token_transfers(from_addr);
CREATE INDEX IF NOT EXISTS idx_tt_to    ON token_transfers(to_addr);

CREATE TABLE IF NOT EXISTS tokens (
  address      TEXT PRIMARY KEY,
  name         TEXT,
  symbol       TEXT,
  decimals     INTEGER,
  total_supply TEXT,
  first_block  INTEGER
);

-- 合约登记：替代公网 Etherscan 的 "Verify Contract"。
-- created_* 由 scanner 从链上事实写入（谁在哪个交易创建了哪个地址、runtime 字节码指纹）；
-- 其余字段由 indexer/register.js 这个 CLI 事后登记（源码指纹、git commit、ABI）。
-- 分开放是因为链上永远查不到源码：verified 是"登记方主张"，不是"链证明"，
-- 客户复核的动作是拿 source_hash/git_commit 自己重编译再比 deployed_hash。
CREATE TABLE IF NOT EXISTS contracts (
  address        TEXT PRIMARY KEY,
  creator        TEXT,            -- 部署者
  deploy_tx      TEXT,
  block_number   INTEGER,
  deployed_hash  TEXT,            -- keccak(runtime bytecode)，链上实测
  deployed_size  INTEGER,
  name           TEXT,            -- 以下四列来自登记
  source_hash    TEXT,
  git_commit     TEXT,
  abi            TEXT,
  verified       INTEGER DEFAULT 0,   -- 0 未登记 / 1 已登记 / 2 登记了但指纹对不上
  registered_at  INTEGER,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_contracts_tx ON contracts(deploy_tx);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(DDL);
  return db;
}

// ---- 游标 ----
function getMeta(db, key) {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return r ? r.value : null;
}
function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

// ---- 写入（scanner 每批单事务包起来调用）----
function insertBlock(db, b) {
  db.prepare(`INSERT OR REPLACE INTO blocks(number,hash,parent_hash,timestamp,tx_count,gas_used)
              VALUES(?,?,?,?,?,?)`).run(b.number, b.hash, b.parentHash, b.timestamp, b.txCount, b.gasUsed);
}
function insertTx(db, t) {
  db.prepare(`INSERT OR REPLACE INTO txs(hash,block_number,tx_index,from_addr,to_addr,value,input,nonce,status,gas_used,contract_address)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.hash, t.blockNumber, t.txIndex, t.from, t.to, t.value, t.input, t.nonce, t.status, t.gasUsed, t.contractAddress);
}
function insertTransfer(db, x) {
  db.prepare(`INSERT INTO token_transfers(tx_hash,block_number,log_index,token,from_addr,to_addr,value)
              VALUES(?,?,?,?,?,?,?)`).run(x.txHash, x.blockNumber, x.logIndex, x.token, x.from, x.to, x.value);
}
function upsertToken(db, t) {
  db.prepare(`INSERT INTO tokens(address,name,symbol,decimals,total_supply,first_block)
              VALUES(?,?,?,?,?,?)
              ON CONFLICT(address) DO UPDATE SET
                name=COALESCE(excluded.name,name),
                symbol=COALESCE(excluded.symbol,symbol),
                decimals=COALESCE(excluded.decimals,decimals),
                total_supply=COALESCE(excluded.total_supply,total_supply)`).run(
    t.address, t.name, t.symbol, t.decimals, t.totalSupply, t.firstBlock);
}
function tokenExists(db, addr) {
  return !!db.prepare("SELECT 1 FROM tokens WHERE address=?").get(addr);
}

// ---- 合约登记 ----
// 链上事实（scanner 写）：只补空，不覆盖已登记源码，避免重扫把客户登记冲掉
function upsertContractCreated(db, c) {
  db.prepare(`INSERT INTO contracts(address,creator,deploy_tx,block_number,deployed_hash,deployed_size)
              VALUES(?,?,?,?,?,?)
              ON CONFLICT(address) DO UPDATE SET
                deployed_hash=excluded.deployed_hash,
                deployed_size=excluded.deployed_size,
                creator=COALESCE(contracts.creator,excluded.creator),
                deploy_tx=COALESCE(contracts.deploy_tx,excluded.deploy_tx),
                block_number=COALESCE(contracts.block_number,excluded.block_number)`).run(
    c.address, c.creator, c.deployTx, c.blockNumber, c.deployedHash, c.deployedSize);
}
// 源码登记（CLI 写）
function registerContractSource(db, r) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO contracts(address,name,source_hash,git_commit,abi,verified,registered_at,note)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(address) DO UPDATE SET
                name=excluded.name, source_hash=excluded.source_hash, git_commit=excluded.git_commit,
                abi=excluded.abi, verified=excluded.verified, registered_at=excluded.registered_at,
                note=excluded.note`).run(
    r.address, r.name, r.sourceHash, r.gitCommit, r.abi ? JSON.stringify(r.abi) : null,
    r.verified, now, r.note || null);
}
function getContract(db, addr) {
  return db.prepare("SELECT * FROM contracts WHERE address=?").get(addr);
}
function listContracts(db, limit) {
  return db.prepare(`SELECT address,name,creator,deploy_tx,block_number,verified,deployed_size,source_hash,git_commit
                     FROM contracts ORDER BY block_number DESC LIMIT ?`).all(limit);
}
function contractCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM contracts").get().c;
}
function verifiedCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM contracts WHERE verified=1").get().c;
}

// ---- 重组保护：删掉 ≥ 该高度的所有数据（QBFT 单块终结，理论不触发）----
function deleteFrom(db, number) {
  db.prepare("DELETE FROM blocks WHERE number>=?").run(number);
  db.prepare("DELETE FROM txs WHERE block_number>=?").run(number);
  db.prepare("DELETE FROM token_transfers WHERE block_number>=?").run(number);
}

module.exports = {
  open, getMeta, setMeta, insertBlock, insertTx, insertTransfer, upsertToken, tokenExists, deleteFrom,
  upsertContractCreated, registerContractSource, getContract, listContracts, contractCount, verifiedCount,
};
