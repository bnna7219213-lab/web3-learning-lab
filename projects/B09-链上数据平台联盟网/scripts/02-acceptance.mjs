// B09 验收（联盟网版）：
//   A. 链上数据正确性：事件派生口径与链上独立复核一致（CredentialIssued.count 合计 == nextId）
//   B. 查询 + 游标分页稳定（翻页途中出新块不打乱）
//   C. 回滚重放（注入式）：篡改本地块哈希模拟被重组 → 检测 → 回滚 → 重放恢复
//   D. 筛选（合同号/批次/持有人）< 1s
//   E. 幂等 ｜ F. B 分支四条增量：多成员 / 零 gas / 终结性 / 权限负例留痕
//   G. B08 × B09 联动：工程事件源（代理升级 / 空投 / CREATE2 落址）也进同一个索引
//   H. B05/B06 业务源：历史重扫 + ERC20 余额对账 + 审批状态机 + 看板业务域可查
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, RPCS, rpc, head, blockHashes, loadDeployment, loadAbi, cfg, ok, hr, summary, ROOT, CHAIN_ID } from "./lib.mjs";
import { openDb } from "../indexer/db.js";
import { Scanner } from "../indexer/scanner.js";
import { createServer } from "../indexer/server.js";
import { watchContracts, watchSources } from "../indexer/config.js";

// 默认每次新建独立验收库：保留历史证据，也不受旧进程持有文件的干扰。
// DB_PATH 可显式指定路径；REUSE_DB=1 只用于显式指定库的增量调试。
const DB = process.env.DB_PATH || path.join(ROOT, "data", `acceptance-${Date.now()}.db`);

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
console.log(`  验收数据库：${DB}`);
const store = openDb(DB);
const sources = watchSources();
const scan = new Scanner({
  store,
  rpc: RPC,
  sources,
  contracts: watchContracts(),
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
const PORT = Number(process.env.ACCEPTANCE_PORT || 8812);
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

// ============ H. B05 / B06 业务事件源也进同一个索引（联盟链全景联动）============
hr("H. B05 / B06 business event sources indexed (全联盟链路联动)");
const B05_DIR = path.resolve(ROOT, "..", "B05-ERC20代币联盟网");
const B06_DIR = path.resolve(ROOT, "..", "B06-投票DApp联盟网");
// B05 的 latest.json 指的是 anvil(31337) 那份，联盟链必须读链号目录
const b5dep = readJsonFile(path.join(B05_DIR, "deployments", String(CHAIN_ID), "LabToken.json"));
const b6dep = readJsonFile(path.join(B06_DIR, "deployments", "latest.json"));
ok(
  !!b5dep && sources.some((s) => s.address.toLowerCase() === String(b5dep.address).toLowerCase()),
  `事件源清单含 B05 LabToken（${b5dep?.address || "缺失"}）`
);
ok(
  !!b6dep && sources.some((s) => s.address.toLowerCase() === String(b6dep.approvalFlow).toLowerCase()),
  `事件源清单含 B06 ApprovalFlow（${b6dep?.approvalFlow || "缺失"}）`
);

// —— 先在 B06 的持久实例上造出完整状态机的事件（提案 → 复核 → 撤销 / 提案 → 复核 → 执行）——
//    索引器必须能吃到这些事件，才说明「B06 的业务流真的进了平台」。
const b6Abi = readJsonFile(path.join(B06_DIR, "abi", "ApprovalFlow.json"));
const cfgEnv = cfg();
const b6provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const wA = new ethers.Wallet(cfgEnv.MEMBER_A_PRIVATE_KEY, b6provider);
const wB = new ethers.Wallet(cfgEnv.MEMBER_B_PRIVATE_KEY, b6provider);
const wAdmin = new ethers.Wallet(cfgEnv.ISSUER_PRIVATE_KEY, b6provider);
const flow = new ethers.Contract(b6dep.approvalFlow, b6Abi, wA);
const GAS0 = { gasLimit: 300000n, gasPrice: 0n, type: 0 };
const title = "B09 联动：提案";
const p1 = await (await flow.propose(wA.address, 0n, "0x", title, GAS0)).wait();
const id1 = Number(await flow.proposalCount()) - 1;
// 另一成员复核（双人复核：复核人 ≠ 提案人）
await (await flow.connect(wB).approve(id1, GAS0)).wait();
// 第二个提案：复核后在生效延迟内撤销 → 留下 Revoked 痕迹
const p2 = await (await flow.propose(wA.address, 0n, "0x", title + "（撤销）", GAS0)).wait();
const id2 = Number(await flow.proposalCount()) - 1;
await (await flow.connect(wB).approve(id2, GAS0)).wait();
await (await flow.connect(wA).revoke(id2, GAS0)).wait();
// 第三个提案：等生效延迟结束 → 执行 → 留下 Executed 痕迹
const p3 = await (await flow.propose(wA.address, 0n, "0x", title + "（执行）", GAS0)).wait();
const id3 = Number(await flow.proposalCount()) - 1;
await (await flow.connect(wB).approve(id3, GAS0)).wait();
const delay = Number(b6dep.delaySeconds || 60);
console.log(`  B06 状态机已造：提案 #${id1}(复核) / #${id2}(撤销) / #${id3}(复核)，等待生效延迟 ${delay}s…`);
await new Promise((r) => setTimeout(r, (delay + 2) * 1000));
await (await flow.connect(wAdmin).execute(id3, GAS0)).wait();
// 索引器追上链头（这批新事件是刚才才产生的）
const rH = await scan.syncOnce();
console.log(`  索引追上链头 #${rH.head}`);

// B05：ERC20 记账单位。Transfer/Approval 与凭证同名同参（topic0 只看签名）→ 无需新增片段即可解码
const b5Addr = String(b5dep?.address || "").toLowerCase();
const b5Transfer = count(store, `SELECT COUNT(*) c FROM logs WHERE eventName='Transfer' AND address='${b5Addr}'`);
ok(b5Transfer > 0, `B05 记账单位的 ERC20 Transfer 进索引（${b5Transfer} 条）`);
const b5Chain = await chainLogCount({
  address: b5dep.address,
  topics: [ethers.id("Transfer(address,address,uint256)")],
});
ok(b5Transfer === b5Chain, `B05 Transfer 事件数与链上 eth_getLogs 一致（${b5Transfer} == ${b5Chain}）`);
const b5Token = new ethers.Contract(b5dep.address, ["function balanceOf(address) view returns (uint256)"], provider);
const b5Balances = store.q("SELECT address, balance FROM fungibleBalances WHERE contract = ?").all(b5Addr);
const b5BalanceChecks = [];
for (const row of b5Balances) {
  b5BalanceChecks.push(BigInt(row.balance) === BigInt(await b5Token.balanceOf(row.address)));
}
ok(b5Balances.length > 0 && b5BalanceChecks.every(Boolean), `B05 全部派生余额与链上 balanceOf 一致（${b5Balances.length} 个账户）`);
ok(count(store, "SELECT COUNT(*) c FROM assets WHERE contract = ?", b5Addr) === 0, "B05 ERC20 没有被误计为 NFT 资产");

// B06：审批流四事件（提案 / 复核 / 撤销 / 执行）
const b6Addr = String(b6dep?.approvalFlow || "").toLowerCase();
const b6Counts = {};
for (const ev of ["Proposed", "Reviewed", "Revoked", "Executed"]) {
  b6Counts[ev] = count(store, `SELECT COUNT(*) c FROM logs WHERE eventName='${ev}' AND address='${b6Addr}'`);
}
ok(b6Counts.Proposed >= 3, `B06 审批流的 Proposed 进索引（${b6Counts.Proposed} 条）`);
ok(b6Counts.Reviewed >= 3, `B06 复核事件 Reviewed 进索引（${b6Counts.Reviewed} 条，含通过与驳回）`);
ok(b6Counts.Revoked >= 1, `B06 撤销事件 Revoked 进索引（${b6Counts.Revoked} 条：撤销窗口是可查的痕迹）`);
ok(b6Counts.Executed >= 1, `B06 执行事件 Executed 进索引（${b6Counts.Executed} 条）`);
const b6Chain = await chainLogCount({
  address: b6dep.approvalFlow,
  topics: [ethers.id("Proposed(uint256,address,string)")],
});
ok(b6Counts.Proposed === b6Chain, `B06 Proposed 事件数与链上 eth_getLogs 一致（${b6Counts.Proposed} == ${b6Chain}）`);

// 跨项目对账：索引里 Proposed 事件的地址必须就是 B06 部署记录里的那个合约
const proposedAddr = store
  .q(`SELECT address FROM logs WHERE eventName='Proposed' AND address='${b6Addr}' LIMIT 1`)
  .get();
ok(
  !!proposedAddr && proposedAddr.address.toLowerCase() === b6Addr,
  `跨项目对账：B06 部署记录的合约地址与索引事件地址一致（${b6Addr.slice(0, 10)}…）`
);

// 看板可查（同一个筛选维度里同时看得到 B05/B06/B07/B08 四类事件）
const f5 = await api(`/api/logs?eventName=Proposed&limit=20`);
ok(f5.status === 200 && f5.j.items.length >= 1, `看板按事件名可查审批提案（${f5.ms}ms，${f5.j.items.length} 条）`);
const f6 = await api(`/api/logs?eventName=Transfer&address=${b5dep.address}&limit=50`);
const b5OnBoard = (f6.j.items || []).filter((x) => String(x.address).toLowerCase() === b5Addr);
ok(b5OnBoard.length >= 1, `看板按合约地址能筛出 B05 记账单位的转账（${b5OnBoard.length} 条）`);
const sourceApi = await api("/api/sources");
const sourceDomains = new Set((sourceApi.j.data || []).map((s) => s.domain));
ok(["B05", "B06", "B07", "B08"].every((d) => sourceDomains.has(d)), `看板业务域 API 返回 B05–B08（${[...sourceDomains].join("/")}）`);

// ============ I. 事件源变更：从现有游标回扫，历史事实与派生状态都不丢 ============
hr("I. source fingerprint -> full historical rescan");
const beforeI = snapshotCounts(store);
const scanI = new Scanner({ store, rpc: RPC, sources: sources.filter((s) => s.domain !== "B05"), confirmations: 0, logChunk: 500, startBlock: 0, chainKey: `chain:${CHAIN_ID}` });
const rI1 = await scanI.syncOnce();
ok(!!rI1.sourcesChanged, "移除 B05 后识别事件源指纹变化");
ok(count(store, "SELECT COUNT(*) c FROM logs WHERE address = ?", b5Addr) === 0, "移除事件源后清理其旧日志，不留下口径不一致的派生数据");
const rI2 = await scan.syncOnce();
ok(!!rI2.sourcesChanged && rI2.cursor.lastBlock >= rI2.head, "重新接入 B05 后自动回扫并追上链头");
ok(count(store, "SELECT COUNT(*) c FROM logs WHERE address = ? AND eventName = 'Transfer'", b5Addr) === b5Chain, "重接入后 B05 的历史 Transfer 被补回（不是只收新事件）");
const afterI = snapshotCounts(store);
ok(afterI.blocks >= beforeI.blocks && afterI.logs >= beforeI.logs, `全量重扫保留其它事件源（logs ${beforeI.logs} → ${afterI.logs}）`);

server.close();
summary("02 acceptance (B09)");

