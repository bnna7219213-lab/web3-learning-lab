-- P09 表设计（教学口径对齐 PostgreSQL 的 tx/log/asset/holder 四类，见 docs/01 设计.md 的 PG DDL 对照）
-- 幂等写入主键：blocks/txs/logs 都以链上不可变标识（hash/blockHash+logIndex）为主键/唯一键，
-- 重复扫描同一段区间 = INSERT OR REPLACE，不会重复计数。

CREATE TABLE IF NOT EXISTS blocks (
  number     INTEGER PRIMARY KEY,
  hash       TEXT NOT NULL,
  parentHash TEXT NOT NULL,
  timestamp  INTEGER NOT NULL,
  txCount    INTEGER NOT NULL DEFAULT 0,
  indexedAt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS txs (
  hash        TEXT PRIMARY KEY,
  blockNumber INTEGER NOT NULL,
  blockHash   TEXT NOT NULL,
  txIndex     INTEGER NOT NULL,
  fromAddr    TEXT NOT NULL,
  toAddr      TEXT,
  value       TEXT NOT NULL,
  input       TEXT NOT NULL,
  selector    TEXT,
  method      TEXT,
  status      INTEGER,
  gasUsed     TEXT,
  UNIQUE(blockHash, txIndex)
);
CREATE INDEX IF NOT EXISTS idx_txs_block ON txs(blockNumber);
CREATE INDEX IF NOT EXISTS idx_txs_from ON txs(fromAddr);
CREATE INDEX IF NOT EXISTS idx_txs_to   ON txs(toAddr);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  blockNumber INTEGER NOT NULL,
  blockHash   TEXT NOT NULL,
  txHash      TEXT NOT NULL,
  logIndex    INTEGER NOT NULL,
  address     TEXT NOT NULL,
  topic0      TEXT,
  topics      TEXT NOT NULL,
  data        TEXT NOT NULL,
  eventName   TEXT,
  decoded     TEXT,          -- 解码后的参数 JSON
  fromAddr    TEXT,          -- 抽平的过滤列（Transfer/OrderFilled 等的 from/seller）
  toAddr      TEXT,          -- 抽平的过滤列（to/buyer/holder）
  tokenId     TEXT,          -- ERC721/1155 id
  batch       TEXT,          -- 批次（LabCredential.batchId / 市场 listingId），B09 主力筛选列
  UNIQUE(blockHash, logIndex)
);
CREATE INDEX IF NOT EXISTS idx_logs_block  ON logs(blockNumber);
CREATE INDEX IF NOT EXISTS idx_logs_addr   ON logs(address);
CREATE INDEX IF NOT EXISTS idx_logs_event  ON logs(eventName);
CREATE INDEX IF NOT EXISTS idx_logs_from   ON logs(fromAddr);
CREATE INDEX IF NOT EXISTS idx_logs_to     ON logs(toAddr);
CREATE INDEX IF NOT EXISTS idx_logs_token  ON logs(tokenId);
CREATE INDEX IF NOT EXISTS idx_logs_batch  ON logs(batch);

-- 派生状态：由 logs 重放得到（rollback 后 rebuild_assets 全量重算，保证与链上一致）
CREATE TABLE IF NOT EXISTS assets (
  contract  TEXT NOT NULL,
  tokenId   TEXT NOT NULL,
  standard  TEXT,
  owner     TEXT,
  uri       TEXT,
  updatedAt INTEGER,
  PRIMARY KEY(contract, tokenId)
);

CREATE TABLE IF NOT EXISTS holders (
  contract TEXT NOT NULL,
  address  TEXT NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contract, address)
);

-- 游标：单行（id=1），lastBlock/lastHash 用于断点续扫与重组检测
CREATE TABLE IF NOT EXISTS cursor (
  id        INTEGER PRIMARY KEY CHECK(id = 1),
  chainKey  TEXT,
  lastBlock INTEGER NOT NULL,
  lastHash  TEXT,
  updatedAt INTEGER NOT NULL
);

