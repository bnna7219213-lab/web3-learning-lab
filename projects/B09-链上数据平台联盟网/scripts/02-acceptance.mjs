// B09 验收（联盟网版）：
//   A. 链上数据正确性：事件派生口径与链上独立复核一致（CredentialIssued.count 合计 == nextId）
//   B. 查询 + 游标分页稳定（翻页途中出新块不打乱）
//   C. 回滚重放（注入式）：篡改本地块哈希模拟被重组 → 检测 → 回滚 → 重放恢复
//   D. 筛选（合同号/批次/持有人）< 1s
//   E. 幂等 ｜ F. B 分支四条增量：多成员 / 零 gas / 终结性 / 权限负例留痕
//   G. B08 × B09 联动：工程事件源（代理升级 / 空投 / CREATE2 落址）也进同一个索引
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, RPCS, rpc, head, blockHashes, loadDeployment, loadAbi, cfg, ok, hr, summary, ROOT, CHAIN_ID } from "./lib.mjs";
import { openDb } from "../indexer/db.js";
import { Scanner } from "../indexer/scanner.js";
import { createServer } from "../indexer/server.js";
import { watchContracts, watchSources } from "../indexer/config.js";

const DB = path.join(ROOT, "data", "acceptance.db");
// REUSE_DB=1 时复用已同步的库（全量同步 ~7 分钟，迭代断言时用）；默认每次清库重来
if (!process.env.REUSE_DB) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

const dep = loadDeployment();
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const cred = new ethers.Contract(dep.credential, loadAbi("LabCredential"), provider);
const count = (store, sql, ...a) => store.q(sql).get(...a).c;
const snapshotCounts = (store) => ({
  blocks: count(store, "SELECT COUNT(*) c FROM blocks"),
  txs: count(store, "SELECT COUNT(*) c FROM txs"),
  logs: count(store, "SELECT COUNT(*) c FROM logs"),
});

hr("0. full sync (consortium chain, from block 0)");
const store = openDb(DB);
const scan = new Scanner({
  store,
  rpc: RPC,
  contracts: watchContracts(), // B07 业务源 + B08 工程源（联动）
  confirmations: 0,
  logChunk: 500,
  startBlock: 0,
  chainKey: `chain:${CHAIN_ID}`,
});
const t0 = Date.now();
const r0 = await scan.syncOnce();
const syncMs = Date.now() - t0;
const st = store.stats();
console.log(`  全量同步耗时 ${syncMs}ms：blocks=${st.blocks} txs=${st.txs} logs=${st.logs}（链高 ${r0.head}）`);
ok(st.logs > 0, `联盟链历史事件已入库（${st.logs} 条日志）`);

// ============ A. 链上数据正确性 ============
hr("A. on-chain data integrity (independent cross-check)");
const issuedSum = count(store, "SELECT COALESCE(SUM(CAST(json_extract(decoded, '$.count') AS INTEGER)), 0) c FROM logs WHERE eventName = 'CredentialIssued'");
const nextId = BigInt(await cred.nextId());
ok(BigInt(issuedSum) === nextId, `CredentialIssued 的 count 合计 == 链上 nextId（${issuedSum} == ${nextId}）`);
const payoutDb = count(store, "SELECT COUNT(*) c FROM logs WHERE eventName = 'Payout'");
const PAYOUT_TOPIC = ethers.id("Payout(address,uint256,uint256,uint256)");
// Besu 的 eth_getLogs 单次区间上限 5000 块（直接 0..latest 会被拒）→ 复核查询也要分片
const chainLogCount = async (filter) => {
  const to = await head();
  let n = 0;
  for (let lo = 0; lo <= to; lo += 4000) {
    const hi = Math.min(lo + 3999, to);
    const ls = await rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }]);
    n += ls.length;
  }
  return n;
};
const payoutChain = await chainLogCount({ address: dep.faucet, topics: [PAYOUT_TOPIC] });
ok(payoutDb === payoutChain, `Payout 事件数与链上 eth_getLogs 一致（${payoutDb} == ${payoutChain}）`);
const blocked = count(store, "SELECT COUNT(*) c FROM logs WHERE eventName = 'TransferBlocked'");
ok(blocked >= 1, `权限负例留痕可查：TransferBlocked 审计事件 ${blocked} 条（被拒的转让也在索引里）`);
const oneBlocked = store.q("SELECT decoded FROM logs WHERE eventName = 'TransferBlocked' LIMIT 1").get();
console.log("  样例:", oneBlocked ? oneBlocked.decoded.slice(0, 120) : "-");

// ============ B. 分页稳定 ============
hr("B. cursor pagination stability");
const PORT = 8812;
const server = createServer({ store, scanner: scan, apiKey: "acceptance-key", port: PORT });
const api = async (p) => {
  const t = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return { j: await res.json(), ms: Date.now() - t, status: res.status };
};
const page1 = await api("/api/logs?limit=5");
ok(page1.j.items.length === 5 && !!page1.j.nextCursor, `首页 5 条 + nextCursor（${page1.ms}ms）`);
// 翻页途中出新块：memberA 调 fund(value=0) → 产生一条新 Funded 日志（零余额也能发，价值 0 也入块）
const c = cfg();
const memberA = new ethers.Wallet(c.MEMBER_A_PRIVATE_KEY, provider);
const faucet = new ethers.Contract(dep.faucet, loadAbi("LabFaucet"), memberA);
const tx = await faucet.fund({ value: 0n, gasLimit: 100000n, gasPrice: 0n, type: 0 });
await tx.wait();
await scan.syncOnce();
const page2 = await api(`/api/logs?limit=5&after=${page1.j.nextCursor}`);
const ids1 = new Set(page1.j.items.map((x) => x.id));
ok(page2.j.items.filter((x) => ids1.has(x.id)).length === 0, "翻页途中出新块，第二页与第一页无重复（分页稳定）");

// ============ C. 回滚重放（注入式） ============
hr("C. injected reorg -> rollback & replay");
const beforeC = snapshotCounts(store);
// 注入点必须在游标高度上：真实分叉里「被换的块」就是索引器刚收下的那块（P09 的 anvil 测试同款语义）。
// 游标以下的损坏属于另一种问题（本地 DB 损坏），协议不主张自动发现它。
const victim = store.q("SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1").get();
ok(!!victim, `选定注入目标块 #${victim?.number}（游标高度）`);
const FAKE = "0x" + "de".repeat(32);
store.q("UPDATE blocks SET hash = ? WHERE number = ?").run(FAKE, victim.number);
const tampered = store.q("SELECT hash FROM blocks WHERE number = ?").get(victim.number);
ok(tampered.hash === FAKE, "注入生效（本地块哈希已被篡改）");
const rC = await scan.syncOnce();
ok(rC.reorgDuring?.kind === "fork", `检测到本地块被换 → 回滚（kind=${rC.reorgDuring?.kind}，rolledBackTo=${rC.reorgDuring?.rolledBackTo}）`);
const healed = store.q("SELECT hash FROM blocks WHERE number = ?").get(victim.number);
const remote = await rpc("eth_getBlockByNumber", ["0x" + victim.number.toString(16), false]);
ok(healed.hash === remote.hash, `回滚重放后该块哈希已自愈（== 链上 ${remote.hash.slice(0, 18)}…）`);
const afterC = snapshotCounts(store);
ok(
  afterC.blocks >= beforeC.blocks && afterC.logs >= beforeC.logs,
  `重放不丢数据（blocks ${beforeC.blocks}→${afterC.blocks}，logs ${beforeC.logs}→${afterC.logs}）`
);
const holderSum = count(store, "SELECT COALESCE(SUM(tokens), 0) c FROM holders WHERE contract = ?", dep.credential.toLowerCase());
const assetsN = count(store, "SELECT COUNT(*) c FROM assets WHERE contract = ?", dep.credential.toLowerCase());
ok(assetsN > 0 && holderSum === assetsN, `派生状态自洽（721）：Σ持仓 == 资产数（${holderSum} == ${assetsN}）`);

// ============ D. 筛选延迟 ============
hr("D. filter latency < 1s (合同号/批次/持有人)");
const f1 = await api(`/api/logs?address=${dep.credential}&eventName=Transfer&limit=20`);
ok(f1.status === 200 && f1.ms < 1000 && f1.j.items.length > 0, `合同号+事件筛选 ${f1.ms}ms（${f1.j.items.length} 条）`);
const someBatch = store.q("SELECT batch FROM logs WHERE batch IS NOT NULL LIMIT 1").get();
const f2 = await api(`/api/logs?batch=${someBatch.batch}&limit=20`);
ok(f2.status === 200 && f2.ms < 1000 && f2.j.items.length > 0, `批次筛选（batchId=${someBatch.batch}）${f2.ms}ms（${f2.j.items.length} 条）`);
const holder = store.q("SELECT address FROM holders WHERE contract = ? ORDER BY tokens DESC LIMIT 1").get(dep.credential.toLowerCase());
const f3 = await api(`/api/logs?toAddr=${holder.address}&limit=20`);
ok(f3.status === 200 && f3.ms < 1000 && f3.j.items.length > 0, `持有人筛选 ${f3.ms}ms（${f3.j.items.length} 条）`);

// ============ E. 幂等 ============
hr("E. idempotent re-sync");
const beforeE = snapshotCounts(store);
await scan.syncOnce();
await scan.syncOnce();
const afterE = snapshotCounts(store);
ok(JSON.stringify(beforeE) === JSON.stringify(afterE), `重复 sync 不改行数（${JSON.stringify(afterE)}）`);

// ============ F. B 分支四条增量 ============
hr("F. consortium increments (多成员/零 gas/终结性/权限负例)");
// 1) 多成员：memberA / memberB 各自的交易都进了索引，nonce 不串
const a = memberA.address.toLowerCase();
const b = new ethers.Wallet(c.MEMBER_B_PRIVATE_KEY, provider).address.toLowerCase();
const txA = count(store, "SELECT COUNT(*) c FROM txs WHERE fromAddr = ?", a);
const txB = count(store, "SELECT COUNT(*) c FROM txs WHERE fromAddr = ?", b);
ok(txA >= 1 && txB >= 1, `两个成员账户的交易各自入索引（memberA ${txA} 笔 / memberB ${txB} 笔）`);
// 2) 零 gas
const gasPrice = await rpc("eth_gasPrice");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
ok(BigInt(gasPrice) === 0n && BigInt(latest.baseFeePerGas ?? "0x0") === 0n, `零 gas 成立（eth_gasPrice=${gasPrice} baseFee=${latest.baseFeePerGas}）`);
// 3) 终结性：同一块哈希 3 节点一致
const h = Number(latest.number) - 1;
const hashes = await blockHashes(h);
const uniq = new Set(hashes.map((x) => x.hash));
ok(uniq.size === 1 && !uniq.has(null), `终结性：块 #${h} 哈希在 ${hashes.length} 个节点上一致（${[...uniq][0]?.slice(0, 18)}…）`);
// 4) 权限负例：审计留痕已在 A 组确认可查，这里补 reason 细节
const reason = oneBlocked ? JSON.parse(oneBlocked.decoded).reason : null;
ok(!!reason, `权限负例带原因码可查（reason=${reason ? String(reason).slice(0, 18) + "…" : "无"}）`);

// ============ G. B08 × B09 联动：工程事件源入索引 ============
hr("G. B08 engineering events indexed (B08 × B09 联动)");
const readJsonFile = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")) : null);
const B08_DIR = path.resolve(ROOT, "..", "B08-合约工程化联盟网");
const b8dep = readJsonFile(path.join(B08_DIR, "deployments", "latest.json"));
const drill = readJsonFile(path.join(B08_DIR, "deployments", "upgrade-drill.json"));
const sources = watchSources();

ok(
  !!b8dep && sources.some((s) => s.address.toLowerCase() === String(b8dep.vaultProxy).toLowerCase()),
  `事件源清单含 B08 合约（${sources.length} 个源：${sources.map((s) => s.label).join(" / ")}）`
);

const upgradedRows = store
  .q("SELECT blockNumber, txHash, decoded FROM logs WHERE eventName = 'Upgraded' ORDER BY blockNumber")
  .all();
ok(
  upgradedRows.length >= 2,
  `ERC-1967 Upgraded 已入索引（${upgradedRows.length} 条：升级一次 + 回滚一次）`
);

// 与 B08 的升级演练记录对账。
//   注意方向：演练记录每次跑都会被覆盖（V2 实现地址每次新部署都会变），
//   所以对账口径是「演练记录里的每个实现地址都能在索引里找到」，
//   而不是「索引里的每个实现地址都在演练记录里」——后者对历史 V2 地址不成立。
const drillImpls = new Set((drill?.snapshots || []).map((s) => String(s.impl).toLowerCase()));
const idxImpls = upgradedRows.map((r) => String(JSON.parse(r.decoded).implementation).toLowerCase());
ok(
  drillImpls.size > 0 && [...drillImpls].every((x) => idxImpls.includes(x)),
  `B08 演练记录里的每个实现地址都能在索引里找到（${[...drillImpls].map((x) => x.slice(0, 10) + "…").join(" / ")}）`
);
const registeredImpl = String(b8dep.vaultImpl).toLowerCase();
ok(
  idxImpls.length > 0 && idxImpls[idxImpls.length - 1] === registeredImpl,
  `回滚收口：最后一条 Upgraded 指向部署登记的 V1 实现（${registeredImpl.slice(0, 10)}…）`
);
ok(
  idxImpls.some((x) => x !== registeredImpl),
  `确实发生过升级到 V2（索引里出现非登记实现地址 ${idxImpls.filter((x) => x !== registeredImpl).map((x) => x.slice(0, 10) + "…").join(" / ")}）`
);

// 链上独立复核：数量必须与 eth_getLogs 一致
const upgradedChain = await chainLogCount({
  address: b8dep.vaultProxy,
  topics: [ethers.id("Upgraded(address)")],
});
ok(upgradedRows.length === upgradedChain, `Upgraded 事件数与链上 eth_getLogs 一致（${upgradedRows.length} == ${upgradedChain}）`);

// 看板可查
const f4 = await api(`/api/logs?eventName=Upgraded&limit=20`);
ok(
  f4.status === 200 && f4.j.items.length >= 1,
  `看板按事件名可查升级证据（${f4.ms}ms，${f4.j.items.length} 条）`
);

// B08 的其它工程事件同样进索引（空投领取 / CREATE2 落址）
const claimN = count(store, "SELECT COUNT(*) c FROM logs WHERE eventName = 'Claimed'");
const deployedN = count(store, "SELECT COUNT(*) c FROM logs WHERE eventName = 'Deployed'");
ok(
  claimN + deployedN > 0,
  `B08 空投/CREATE2 事件也进索引（Claimed=${claimN} 条，Deployed=${deployedN} 条）`
);

server.close();
summary("02 acceptance (B09)");

