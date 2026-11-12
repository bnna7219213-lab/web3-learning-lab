// P09 索引器配置：全部走环境变量，默认值适合本机 anvil + P07 三件套。
// 复用 P03 解析器思路（scripts/lib.mjs 的 decodeLog/decodeInput）与 P07 事件流（LabNFT/LabEditions/NFTMarket）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RPC = process.env.RPC || "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
export const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "index.db");

// confirmations 深度：只把 head-N 之前的高度视为安全区（NFT 交易 2 个块足够；
// QBFT 单块终结的链可设 0——见 B09 差异矩阵）
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 2);
export const LOG_CHUNK = Number(process.env.LOG_CHUNK || 2000);
export const START_BLOCK = Number(process.env.START_BLOCK || 0);

export const API_PORT = Number(process.env.API_PORT || 8801);
export const API_KEY = process.env.API_KEY || "p09-dev-key";
export const POLL_MS = Number(process.env.POLL_MS || 2000);

// 监控合约清单：env CONTRACTS=0x..,0x.. 优先；缺省读 P07 部署记录（nft/editions/market）。
// 为空 = 不过滤地址，索引全链日志（调试用）。
export function watchContracts() {
  const env = (process.env.CONTRACTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length) return env;
  const f = path.resolve(ROOT, "..", "P07-NFT市场进阶", "deployments", String(CHAIN_ID), "P07.json");
  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
    return [d.nft, d.editions, d.market].filter(Boolean);
  }
  return [];
}

