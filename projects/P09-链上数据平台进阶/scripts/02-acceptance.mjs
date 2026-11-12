// P09 验收（质量门禁，README 六条里的前四条）：
//   A. confirmations 深度语义：只索引到 safe = head - N
//   B. 事件可查询 + 游标分页稳定：翻页途中出新块，已翻过的页不重排
//   C. 人为分叉后回滚重放：evm_snapshot → 事件 → evm_revert → 换一批事件 → 旧记录消失、新记录入库
//   D. 看板筛选（合同号/批次/事件/地址）< 1s
//   E. 幂等：重复 sync 行数不变；F. BFF 管理口鉴权
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, rpc, sendTx, head, snapshot, revert, loadDeployment, loadAbi, ok, hr, summary, ROOT } from "./lib.mjs";
import { openDb } from "../indexer/db.js";
import { Scanner } from "../indexer/scanner.js";
import { createServer } from "../indexer/server.js";

const DB = path.join(ROOT, "data", "acceptance.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const dep = loadDeployment();
const accs = await rpc("eth_accounts");
const [admin, alice, bob, carol] = accs;
const nftIface = new ethers.Interface(loadAbi("LabNFT"));
const marketIface = new ethers.Interface(loadAbi("NFTMarket"));
const enc = (iface, fn, args) => iface.encodeFunctionData(fn, args);
const mint = (to, uri) => sendTx(admin, dep.nft, enc(nftIface, "mint", [to, uri]));
const count = (store, sql, ...a) => store.q(sql).get(...a).c;

// ============ A. confirmations 深度 ============
hr("A. confirmations depth (safe = head - confirmations)");
const store = openDb(DB);
const scan = new Scanner({
  store,
  rpc: RPC,
  contracts: [dep.nft, dep.editions, dep.market],
  confirmations: 2,
  logChunk: 500,
  startBlock: 0,
  chainKey: "anvil-acceptance",
});
let r = await scan.syncOnce();
ok(r.cursor.lastBlock === r.safe, `confirmations=2 → 游标停在 safe=${r.safe}，链头=${r.head}（不追头）`);
for (let i = 0; i < 3; i++) await rpc("evm_mine", []);
r = await scan.syncOnce();
ok(r.cursor.lastBlock === r.safe, `再挖 3 块后游标跟进到 ${r.cursor.lastBlock}（= 新 safe）`);

// settle：交易上链后再补 confirmations 个空块，事件才进入安全区（真实使用的深度语义）
const settle = async () => {
  for (let i = 0; i < scan.confirmations; i++) await rpc("evm_mine", []);
  return scan.syncOnce();
};

// ============ B. 查询 + 游标分页稳定 ============
hr("B. query + cursor pagination stability");
await mint(alice, "ipfs://p09-page/1");
await settle();
const PORT = 8899;
const server = createServer({ store, scanner: scan, apiKey: "acceptance-key", port: PORT });
const api = async (p) => {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return { j: await res.json(), ms: Date.now() - t0, status: res.status };
};
const page1 = await api("/api/logs?limit=5");
ok(page1.j.items.length === 5 && !!page1.j.nextCursor, `首页 5 条 + nextCursor（${page1.ms}ms）`);
// 翻页途中出新块（会排在倒序列表更前面）
await mint(alice, "ipfs://p09-page/2");
await settle();
const page2 = await api(`/api/logs?limit=5&after=${page1.j.nextCursor}`);
const ids1 = new Set(page1.j.items.map((x) => x.id));
const overlap = page2.j.items.filter((x) => ids1.has(x.id));
ok(overlap.length === 0, "翻页途中出新块，第二页与第一页无重复（分页稳定）");
const minB1 = Math.min(...page1.j.items.map((x) => x.blockNumber));
const maxB2 = Math.max(...page2.j.items.map((x) => x.blockNumber));
ok(maxB2 <= minB1, `第二页整体不高于第一页（${maxB2} <= ${minB1}，倒序游标单调）`);

// ============ C. 人为分叉后回滚重放 ============
hr("C. artificial fork -> rollback & replay");
const snapAt = await head();
const snapId = await snapshot();
// 用交易哈希标记两批事件（mint 的 URI 在 input 里，事件 decoded 里没有 → 按 txHash 判定归属）
const forkA = [];
forkA.push((await mint(alice, "ipfs://fork-a/1")).hash);
forkA.push((await mint(alice, "ipfs://fork-a/2")).hash);
await settle();
const aInDb = count(store, `SELECT COUNT(*) c FROM logs WHERE eventName = 'Transfer' AND txHash IN ('${forkA.join("','")}')`);
ok(aInDb === 2, `分叉前：fork-a 的 2 条 mint 转账事件已入库（实测 ${aInDb}）`);

const reverted = await revert(snapId);
ok(reverted === true, `evm_revert 成功，链回退到快照高度 ${snapAt}（当前链高 ${await head()}）`);
// 换一批事件（calldata 不同 → txHash 必不同，避免与旧分叉混淆）
const forkB = [];
forkB.push((await mint(alice, "ipfs://fork-b/1")).hash);
forkB.push((await mint(bob, "ipfs://fork-b/2")).hash);
forkB.push((await mint(bob, "ipfs://fork-b/3")).hash);
// 两阶段：先触发回滚协议，再重放（syncOnce 内部自带重试，这里跑两次保险）
const r1 = await scan.syncOnce();
const r2 = await settle();
const reorg = r1.reorgDuring ?? r2.reorgDuring;
ok(!!reorg, `检测到分叉并回滚（kind=${reorg?.kind}，rolledBackTo=${reorg?.rolledBackTo}）`);
const aAfter = count(store, `SELECT COUNT(*) c FROM logs WHERE txHash IN ('${forkA.join("','")}')`);
const bAfter = count(store, `SELECT COUNT(*) c FROM logs WHERE eventName = 'Transfer' AND txHash IN ('${forkB.join("','")}')`);
ok(aAfter === 0, `旧分叉的 fork-a 事件全部消失（实测 ${aAfter} 条残留）`);
ok(bAfter === 3, `新分叉的 fork-b 转账事件已重放入库（实测 ${bAfter}）`);
const oldTxsGone = forkA.every((h) => count(store, "SELECT COUNT(*) c FROM txs WHERE hash = ?", h) === 0);
ok(oldTxsGone, "旧分叉的交易记录也一并清除（txs 表无孤儿）");
const newTxsIn = forkB.every((h) => count(store, "SELECT COUNT(*) c FROM txs WHERE hash = ?", h) === 1);
ok(newTxsIn, "新分叉的交易记录已入库（txs 表无缺漏）");
const cursorNow = store.getCursor();
const chainHeadNow = await head();
ok(
  cursorNow.lastBlock === chainHeadNow - scan.confirmations,
  `回滚重放后游标停在安全区（${cursorNow.lastBlock} == ${chainHeadNow} - ${scan.confirmations}）`
);
// 721 不变式：Σ持有人持仓 == 资产数（1155 是数量语义，另计）
const holderSum = count(store, "SELECT COALESCE(SUM(tokens), 0) c FROM holders WHERE contract = ?", dep.nft.toLowerCase());
const assetsTotal = count(store, "SELECT COUNT(*) c FROM assets WHERE contract = ?", dep.nft.toLowerCase());
ok(assetsTotal > 0 && holderSum === assetsTotal, `派生状态已重算且自洽（721）：Σ持仓 == 资产数（${holderSum} == ${assetsTotal}）`);

// ============ D. 筛选延迟 ============
hr("D. filter latency < 1s");
const f1 = await api(`/api/logs?address=${dep.nft}&eventName=Transfer&limit=20`);
ok(f1.status === 200 && f1.ms < 1000 && f1.j.items.length > 0, `合同号+事件筛选 ${f1.ms}ms < 1000ms（${f1.j.items.length} 条）`);
const someBatch = store.q("SELECT batch FROM logs WHERE batch IS NOT NULL LIMIT 1").get();
const f2 = await api(`/api/logs?batch=${someBatch ? someBatch.batch : ""}&limit=20`);
ok(f2.status === 200 && f2.ms < 1000 && f2.j.items.length > 0, `批次筛选 ${f2.ms}ms < 1000ms（${f2.j.items.length} 条）`);
const f3 = await api(`/api/logs?fromAddr=${alice.toLowerCase()}&limit=20`);
ok(f3.status === 200 && f3.ms < 1000, `地址筛选 ${f3.ms}ms < 1000ms（${f3.j.items.length} 条）`);

// ============ E. 幂等 ============
hr("E. idempotent re-sync");
const before = {
  blocks: count(store, "SELECT COUNT(*) c FROM blocks"),
  txs: count(store, "SELECT COUNT(*) c FROM txs"),
  logs: count(store, "SELECT COUNT(*) c FROM logs"),
};
await scan.syncOnce();
await scan.syncOnce();
const after = {
  blocks: count(store, "SELECT COUNT(*) c FROM blocks"),
  txs: count(store, "SELECT COUNT(*) c FROM txs"),
  logs: count(store, "SELECT COUNT(*) c FROM logs"),
};
ok(JSON.stringify(before) === JSON.stringify(after), `重复 sync 不改行数（blocks=${after.blocks} txs=${after.txs} logs=${after.logs}）`);

// ============ F. BFF 管理口鉴权 ============
hr("F. admin API auth");
const noKey = await fetch(`http://127.0.0.1:${PORT}/admin/sync`, { method: "POST" });
ok(noKey.status === 401, `无 X-API-Key 调管理口被拒（HTTP ${noKey.status}）`);
const withKey = await fetch(`http://127.0.0.1:${PORT}/admin/sync`, { method: "POST", headers: { "x-api-key": "acceptance-key" } });
ok(withKey.status === 200, `带密钥调用成功（HTTP ${withKey.status}）`);

server.close();
summary("02 acceptance");

