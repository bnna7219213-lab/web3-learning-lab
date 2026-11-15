// P27 全量验收（26 项）：身份 / 信号 / tier 同构 / 支付双闸门 / Agent 运行时审计。
// 前置：anvil 已启动 + bash script/deploy.sh anvil + npm install。
// 零私钥：全部走 anvil 解锁账户；验收结束回退快照，可重复跑。
import fs from "node:fs";
import { ethers } from "ethers";
import {
  U, provider, loadContext, bootstrap, pushSignal, raiseToTier,
  mustRevert, check, summary, assert, snapshot, revert,
} from "./lib.mjs";
import { runAgentDemo } from "./agent-demo.mjs";

const ctx = await loadContext();
const { signers: s, usd, id, reg, agent } = ctx;
const addrs = await bootstrap(ctx);
const snap = await snapshot();
const runStamp = Date.now(); // 条件哈希按运行唯一：任意链状态下可重复跑
const cond = (name) => ethers.id(`${name}:${runStamp}`);

const events = (contract, receipt) =>
  receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter(Boolean);

console.log("P27 Agent 硅基身份经济 · 全量验收（anvil 解锁账户，零私钥）\n");

// ============ A 身份层 ============
console.log("A 身份层（soulbound / 一地址一 ID / PII 只存承诺）");
// 出生检查用本期新铸造的主体：不依赖链上既有账户的声誉状态
const freshCarbon = ethers.Wallet.createRandom().address;
const freshSilicon = ethers.Wallet.createRandom().address;
await check("A", "碳基身份铸造：idOf/tier0/kycCommit 上链", async () => {
  const commit = ethers.id("human-kyc-material+salt");
  await (await id.mint(freshCarbon, false, commit)).wait();
  const tokenId = await id.idOf(freshCarbon);
  assert(tokenId !== 0n, "碳基主体无身份");
  const ident = await id.identityOf(tokenId);
  assert(ident.tier === 0n && !ident.isAgent, "出生应为 T0 碳基");
  assert(ident.kycCommit === commit, "kycCommit 不符");
});
await check("A", "硅基身份铸造：isAgent=true，出生同样 T0", async () => {
  await (await id.mint(freshSilicon, true, ethers.id("agent-kyc-material+salt"))).wait();
  const ident = await id.identityOf(await id.idOf(freshSilicon));
  assert(ident.isAgent && ident.tier === 0n, "硅基身份字段不符");
});
await check("A", "重复铸造硬拒绝 AlreadyHasIdentity", async () => {
  await mustRevert(id.mint.staticCall(freshCarbon, false, ethers.id("x")), id.interface, "AlreadyHasIdentity");
});
await check("A", "soulbound：硅基身份转让被拒 Soulbound", async () => {
  const tokenId = await id.idOf(addrs.silicon);
  await mustRevert(
    id.connect(s.silicon).transferFrom.staticCall(addrs.silicon, addrs.human, tokenId),
    id.interface, "Soulbound"
  );
});

// ============ B 信号层 ============
console.log("\nB 信号层（承诺 → 3/5 阈值确认 → 声誉入账）");
let bCid, bSigHash, bTs, bRepBefore;
await check("B", "provider 提交 AgentFingerprint 承诺：只上链哈希", async () => {
  bSigHash = ethers.id(`acc-signal-${Date.now()}`);
  bTs = BigInt((await provider.getBlock("latest")).timestamp);
  const rec = await (await reg.connect(s.provider).commit(addrs.silicon, "agent:runtime", bSigHash, 3, bTs)).wait();
  const ev = events(reg, rec).find((e) => e.name === "Committed");
  assert(ev && ev.args.sigHash === bSigHash, "Committed 事件不符");
  bCid = ev.args.commitmentId;
  const c = await reg.commitmentOf(bCid);
  assert(!c.confirmed && c.weight === 20n, "承诺初始状态不符");
});
await check("B", "2/5 签名不入账：confirmed=false，声誉不动", async () => {
  bRepBefore = await id.reputationOf(addrs.silicon);
  const inner = ethers.solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "uint8", "uint64"],
    ["LabSignal-Confirm", bCid, addrs.silicon, bSigHash, 3, bTs]
  );
  for (const v of [s.v1, s.v2]) {
    await (await reg.confirm(bCid, await v.signMessage(ethers.getBytes(inner)))).wait();
  }
  const c = await reg.commitmentOf(bCid);
  assert(!c.confirmed && c.verifierCount === 2n, "2/5 不应确认");
  assert((await id.reputationOf(addrs.silicon)) === bRepBefore, "2/5 不应入账");
});
await check("B", "第 3 签达标：confirmed + 声誉 +20 + SignalConfirmed", async () => {
  const inner = ethers.solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "uint8", "uint64"],
    ["LabSignal-Confirm", bCid, addrs.silicon, bSigHash, 3, bTs]
  );
  const rec = await (await reg.confirm(bCid, await s.v3.signMessage(ethers.getBytes(inner)))).wait();
  assert(events(reg, rec).some((e) => e.name === "SignalConfirmed"), "缺 SignalConfirmed");
  const c = await reg.commitmentOf(bCid);
  assert(c.confirmed && c.verifierCount === 3n, "3/5 应确认");
  assert((await id.reputationOf(addrs.silicon)) === bRepBefore + 20n, "声誉应 +20");
});
await check("B", "同一信号重放被拒 DuplicateCommit", async () => {
  await mustRevert(
    reg.connect(s.provider).commit.staticCall(addrs.silicon, "agent:runtime", bSigHash, 3, bTs),
    reg.interface, "DuplicateCommit"
  );
});
await check("B", "非验证者签名被拒 NotVerifier", async () => {
  // 用一条新承诺（未确认）：已确认的承诺会先命中 AlreadyConfirmed，测不到验签层
  const sigHash = ethers.id(`acc-nonverifier-${Date.now()}`);
  const ts = BigInt((await provider.getBlock("latest")).timestamp);
  const rec = await (await reg.connect(s.provider).commit(addrs.silicon, "agent:runtime", sigHash, 3, ts)).wait();
  const cid = events(reg, rec).find((e) => e.name === "Committed").args.commitmentId;
  const inner = ethers.solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "uint8", "uint64"],
    ["LabSignal-Confirm", cid, addrs.silicon, sigHash, 3, ts]
  );
  const sig = await s.human.signMessage(ethers.getBytes(inner));
  await mustRevert(reg.confirm.staticCall(cid, sig), reg.interface, "NotVerifier");
});
await check("B", "过期信号（25h 前）被拒 StaleSignal", async () => {
  const stale = BigInt((await provider.getBlock("latest")).timestamp) - 25n * 3600n;
  await mustRevert(
    reg.connect(s.provider).commit.staticCall(addrs.silicon, "agent:runtime", ethers.id("stale"), 3, stale),
    reg.interface, "StaleSignal"
  );
});

// ============ C tier 同构 ============
console.log("\nC 碳基 × 硅基同构（同一协议 / 同一阈值）");
await check("C", "Agent 指纹×5 与行为×10 同到 T1（rep=100）", async () => {
  // 本期新主体：双方都从 T0 起步，同构对比不受既有声誉影响
  const isoSilicon = ethers.Wallet.createRandom().address;
  const isoCarbon = ethers.Wallet.createRandom().address;
  await (await id.mint(isoSilicon, true, ethers.id("iso-a"))).wait();
  await (await id.mint(isoCarbon, false, ethers.id("iso-h"))).wait();
  await raiseToTier(ctx, isoSilicon, 1, 3);
  await raiseToTier(ctx, isoCarbon, 1, 0);
  assert((await id.tierOf(isoSilicon)) === 1n, "硅基应 T1");
  assert((await id.tierOf(isoCarbon)) === 1n, "碳基应 T1");
  assert((await id.reputationOf(isoSilicon)) === 100n, "硅基 rep 应 100");
  assert((await id.reputationOf(isoCarbon)) === 100n, "碳基 rep 应 100");
});
await check("C", "无身份地址开授权被拒 NoLabID", async () => {
  const stranger = ethers.Wallet.createRandom().address;
  const future = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
  await mustRevert(
    agent.createMandate.staticCall(stranger, ctx.payee, U(100), U(300), future, ethers.id("c")),
    agent.interface, "NoLabID"
  );
});
await check("C", "T0 有身份也开不出授权 TierTooLow", async () => {
  const t0 = ethers.Wallet.createRandom().address;
  await (await id.mint(t0, true, ethers.id("t0-kyc"))).wait();
  const future = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
  await mustRevert(
    agent.createMandate.staticCall(t0, ctx.payee, U(100), U(300), future, ethers.id("c")),
    agent.interface, "TierTooLow"
  );
});

// ============ D 支付层 ============
console.log("\nD 支付层（双闸门 / 四道锁 / 留痕）");
let dMid;
await check("D", "T1 授权被钳制：申请 10000/30000 → 存 100/300", async () => {
  const t1Payer = ethers.Wallet.createRandom().address;
  await (await id.mint(t1Payer, false, ethers.id("t1-kyc"))).wait();
  await raiseToTier(ctx, t1Payer, 1, 0);
  const future = BigInt((await provider.getBlock("latest")).timestamp) + 30n * 86400n;
  const rec = await (
    await agent.createMandate(t1Payer, ctx.payee, U(10_000), U(30_000), future, cond("human-bill"))
  ).wait();
  const mid = events(agent, rec).find((e) => e.name === "MandateCreated").args.mandateId;
  const m = await agent.mandateOf(mid);
  assert(m.perTxLimit === U(100) && m.totalLimit === U(300), "钳制不符");
});
await check("D", "硅基主体经真实信号管线积累至 T3（rep≥2000）", async () => {
  await raiseToTier(ctx, addrs.silicon, 3, 3);
  assert((await id.tierOf(addrs.silicon)) === 3n, "应 T3");
  assert((await id.reputationOf(addrs.silicon)) >= 2000n, "rep 应 ≥2000");
});
await check("D", "T3 授权 10000/30000 创建成功", async () => {
  const future = BigInt((await provider.getBlock("latest")).timestamp) + 30n * 86400n;
  const rec = await (
    await agent.connect(s.silicon).createMandate(addrs.silicon, ctx.payee, U(10_000), U(30_000), future, cond("inventory-below-threshold"))
  ).wait();
  dMid = events(agent, rec).find((e) => e.name === "MandateCreated").args.mandateId;
  const m = await agent.mandateOf(dMid);
  assert(m.perTxLimit === U(10_000) && m.totalLimit === U(30_000) && m.active, "T3 授权字段不符");
});
await check("D", "运行时免用户操作代付 1500：双向余额对账 + reasonRef 留痕", async () => {
  const payeeBefore = await usd.balanceOf(ctx.payee);
  const payerBefore = await usd.balanceOf(addrs.silicon);
  const rec = await (await agent.connect(s.runtime).pay(dMid, U(1500), "agent_run:acceptance-D04")).wait();
  const ev = events(agent, rec).find((e) => e.name === "AgentPaymentExecuted");
  assert(ev && ev.args.reasonRef === "agent_run:acceptance-D04", "缺留痕事件");
  assert(ev.args.conditionHash === cond("inventory-below-threshold"), "条件哈希不符");
  assert((await usd.balanceOf(ctx.payee)) - payeeBefore === U(1500), "收款方余额不符");
  assert(payerBefore - (await usd.balanceOf(addrs.silicon)) === U(1500), "付款方余额不符");
  assert((await agent.mandateOf(dMid)).spent === U(1500), "spent 不符");
});
await check("D", "单笔闸门：10001 > 10000 → ExceedsPerTxLimit", async () => {
  await mustRevert(agent.connect(s.runtime).pay.staticCall(dMid, U(10_001), "x"), agent.interface, "ExceedsPerTxLimit");
});
await check("D", "累计闸门：付满 30000 后再 +1 → ExceedsTotalLimit", async () => {
  for (const amt of [U(10_000), U(10_000), U(8500)]) {
    await (await agent.connect(s.runtime).pay(dMid, amt, "agent_run:fill")).wait();
  }
  assert((await agent.mandateOf(dMid)).spent === U(30_000), "应恰好付满");
  await mustRevert(agent.connect(s.runtime).pay.staticCall(dMid, 1n, "x"), agent.interface, "ExceedsTotalLimit");
});
await check("D", "未授权调用者被拒 UnauthorizedPayer", async () => {
  await mustRevert(agent.connect(s.human).pay.staticCall(dMid, U(1), "x"), agent.interface, "UnauthorizedPayer");
});
await check("D", "撤销即时生效：MandateInactive", async () => {
  const future = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
  const rec = await (
    await agent.connect(s.silicon).createMandate(addrs.silicon, ctx.payee, U(1000), U(3000), future, cond("revokable"))
  ).wait();
  const mid = events(agent, rec).find((e) => e.name === "MandateCreated").args.mandateId;
  await (await agent.connect(s.silicon).revokeMandate(mid)).wait();
  await mustRevert(agent.connect(s.runtime).pay.staticCall(mid, U(1), "x"), agent.interface, "MandateInactive");
});
await check("D", "过期即时生效：MandateExpired", async () => {
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  const rec = await (
    await agent.connect(s.silicon).createMandate(addrs.silicon, ctx.payee, U(1000), U(3000), now + 5n, cond("expiring"))
  ).wait();
  const mid = events(agent, rec).find((e) => e.name === "MandateCreated").args.mandateId;
  await provider.send("evm_increaseTime", [10]);
  await provider.send("evm_mine", []);
  await mustRevert(agent.connect(s.runtime).pay.staticCall(mid, U(1), "x"), agent.interface, "MandateExpired");
});

// ============ E Agent 运行时与审计 ============
console.log("\nE Agent 运行时（决策日志 ↔ 链上事件对账）");
let demoPaid, demoEsc;
await check("E", "边界内账单：Agent 自主支付，日志与链上事件一致", async () => {
  demoPaid = await runAgentDemo(ctx, { invoiceAmount: U(1200), invoiceId: `ACC-${Date.now()}-a` });
  assert(demoPaid.paid && demoPaid.log.outcome === "paid", "应自主支付");
  assert(fs.existsSync(demoPaid.log.file), "决策日志未落盘");
  const filter = agent.filters.AgentPaymentExecuted(demoPaid.mandateId);
  const evs = await agent.queryFilter(filter);
  assert(evs.length === 1, "应恰有 1 笔执行事件");
  const a = evs[0].args;
  assert(a.reasonRef === demoPaid.log.reasonRef, "reasonRef 与日志不符");
  assert(a.amount === U(1200), "金额与日志不符");
  assert(a.conditionHash === demoPaid.log.trigger.conditionHash, "条件哈希与日志不符");
});
await check("E", "超界账单：escalate-to-user，零交易（硬边界不可省）", async () => {
  demoEsc = await runAgentDemo(ctx, { invoiceAmount: U(50_000), invoiceId: `ACC-${Date.now()}-b` });
  assert(!demoEsc.paid && demoEsc.log.outcome === "escalate-to-user", "应升级回用户");
  assert(!demoEsc.log.steps.some((x) => x.action === "execute"), "超界不应有执行步骤");
  const evs = await agent.queryFilter(agent.filters.AgentPaymentExecuted(demoEsc.mandateId));
  assert(evs.length === 0, "超界 mandate 不应有链上执行");
});
await check("E", "remainingAllowance = min(mandate 剩余, tier 剩余)", async () => {
  const r = await agent.remainingAllowance(demoPaid.mandateId);
  assert(r === U(30_000 - 1200), `剩余额度应 28800，实际 ${r}`);
});
await check("E", "tier 上限表视图 + 全部执行事件均带 reasonRef", async () => {
  const perTx = [0n, U(100), U(1000), U(10_000)];
  const total = [0n, U(300), U(3000), U(30_000)];
  for (let t = 0; t < 4; t++) {
    assert((await agent.tierPerTxLimit(t)) === perTx[t], `tier${t} 单笔上限不符`);
    assert((await agent.tierTotalLimit(t)) === total[t], `tier${t} 累计上限不符`);
  }
  const evs = await agent.queryFilter(agent.filters.AgentPaymentExecuted());
  assert(evs.length >= 5, "执行事件数量不足");
  assert(evs.every((e) => e.args.reasonRef.length > 0), "存在无留痕的执行");
});

await revert(snap);
summary();