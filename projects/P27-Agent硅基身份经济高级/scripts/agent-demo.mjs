// Agent 运行时演示：条件触发 → 身份自检 → 读授权边界 → 决策 → 执行 → 对账，全程留痕。
// 留痕模式对照 nexalink 借鉴的智慧医院 agent_run/agent_step：每个决策步骤落链下日志，
// 链上 pay() 的 reasonRef 指回日志 ID——推理过程可审计，且不可事后改口。
//
// 硬边界演示：账单金额超出 min(mandate, tier) 时 outcome=escalate-to-user，
// Agent 不执行、回到用户签名——「省去用户操作」只在边界内成立。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ROOT, U, provider, loadContext, bootstrap, raiseToTier, assert } from "./lib.mjs";

const LOG_DIR = path.join(ROOT, "data", "agent-runs");

function parseEvents(contract, receipt) {
  return receipt.logs
    .map((l) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function runAgentDemo(ctx, { invoiceAmount, invoiceId }) {
  const { signers: s, id, agent, usd } = ctx;
  const silicon = await s.silicon.getAddress();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reasonRef = `agent_run:${runId}`;
  const conditionHash = ethers.id(`invoice-due:${invoiceId}`);
  const log = {
    runId,
    agent: silicon,
    reasonRef,
    trigger: { kind: "invoice-due", invoiceId, amount: invoiceAmount.toString(), conditionHash },
    steps: [],
    outcome: null,
  };
  const step = (action, detail) =>
    log.steps.push({ step: log.steps.length + 1, action, at: new Date().toISOString(), ...detail });
  const writeLog = () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify(log, null, 2));
    log.file = file;
    return file;
  };

  // 1. 身份自检：硅基主体持 LabID，tier 决定能力上限
  const tokenId = await id.idOf(silicon);
  const tier = await id.tierOf(silicon);
  step("identity-check", { tokenId: Number(tokenId), isAgent: true, tier: Number(tier) });

  // 2. 授权登记：用户预先签署的 mandate（此处由硅基主体自己的地址登记）
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  const rec = await (
    await agent.connect(s.silicon).createMandate(silicon, ctx.payee, U(10_000), U(30_000), now + 30n * 86400n, conditionHash)
  ).wait();
  const mandateId = parseEvents(agent, rec).find((e) => e.name === "MandateCreated").args.mandateId;
  step("mandate-created", { mandateId: Number(mandateId), conditionHash });

  // 3. 读边界：链上视图是唯一事实来源
  const m = await agent.mandateOf(mandateId);
  const remaining = await agent.remainingAllowance(mandateId);
  step("read-boundary", {
    perTxLimit: m.perTxLimit.toString(),
    totalLimit: m.totalLimit.toString(),
    remaining: remaining.toString(),
  });

  // 4. 决策：金额必须落在硬边界内，否则升级回用户
  const amount = BigInt(invoiceAmount);
  const ok = amount > 0n && amount <= m.perTxLimit && amount <= remaining;
  step("boundary-check", { invoiceAmount: amount.toString(), withinBoundary: ok });
  if (!ok) {
    log.outcome = "escalate-to-user";
    step("escalate", { reason: "超出 min(mandate, tier) 硬边界，回到用户签名，Agent 不执行" });
    writeLog();
    return { log, mandateId, paid: false };
  }

  // 5. 执行：运行时免用户操作代付
  const payeeBefore = await usd.balanceOf(ctx.payee);
  const tx = await (await agent.connect(s.runtime).pay(mandateId, amount, reasonRef)).wait();
  step("execute", { txHash: tx.hash, amount: amount.toString() });

  // 6. 对账：余额移动 + 链上事件与决策日志一致
  const delta = (await usd.balanceOf(ctx.payee)) - payeeBefore;
  const ev = parseEvents(agent, tx).find((e) => e.name === "AgentPaymentExecuted");
  const eventMatch =
    !!ev && ev.args.reasonRef === reasonRef && ev.args.amount === amount && ev.args.conditionHash === conditionHash;
  const spent = (await agent.mandateOf(mandateId)).spent;
  step("reconcile", { payeeDelta: delta.toString(), spent: spent.toString(), eventMatch });
  assert(delta === amount && eventMatch && spent === amount, "Agent 对账失败");
  log.outcome = "paid";
  writeLog();
  return { log, mandateId, paid: true, txHash: tx.hash };
}

// 独立运行：自建上下文 → 刷到 T3 → 一笔边界内（自主支付）+ 一笔超界（升级回用户）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ctx = await loadContext();
  await bootstrap(ctx);
  const silicon = await ctx.signers.silicon.getAddress();
  await raiseToTier(ctx, silicon, 3);
  console.log(`硅基主体 ${silicon} 已积累至 T3，开始自主决策演示\n`);

  const paid = await runAgentDemo(ctx, { invoiceAmount: U(1200), invoiceId: `INV-${Date.now()}-a` });
  console.log(`[边界内] outcome=${paid.log.outcome}  tx=${paid.txHash}`);
  console.log(`  决策日志：${paid.log.file}`);

  const esc = await runAgentDemo(ctx, { invoiceAmount: U(50_000), invoiceId: `INV-${Date.now()}-b` });
  console.log(`[超界]   outcome=${esc.log.outcome}（无交易，回到用户签名）`);
  console.log(`  决策日志：${esc.log.file}`);
}