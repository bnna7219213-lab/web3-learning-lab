// 步骤②：向 B03 水龙头领 10 B03（替代公网 faucet——2026-11-11 用户授权的环境替换）。
// 顺带验证水龙头治理负例：同地址 60s 内再领 → 429 冷却。
import { ethers } from "ethers";
import { FAUCET_URL, learnerWallet, provider, loadEnv } from "./lib.mjs";

export async function main() {
  const learner = learnerWallet();
  const p = provider();
  const env = loadEnv();
  const before = await p.getBalance(learner.address);

  const claimOnce = () => fetch(FAUCET_URL + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: learner.address }),
  });
  let res = await claimOnce();
  let body = await res.json();
  if (res.status === 429 && /冷却中/.test(body.error || "")) {
    // 重跑场景：上一轮领币还在 60s 冷却里。等完再领一次（只重试一次）。
    const secs = Number((body.error.match(/(\d+)\s*秒/) || [])[1] || 60);
    console.log(`  冷却中，等 ${secs + 1}s 后重试…`);
    await new Promise((r) => setTimeout(r, (secs + 1) * 1000));
    res = await claimOnce();
    body = await res.json();
  }
  if (!res.ok || !body.ok) throw new Error(`领水失败 HTTP ${res.status}: ${JSON.stringify(body)}`);
  console.log(`领水成功：+${body.amount} B03  tx=${body.txHash}  block=#${body.block}`);
  console.log(`  出资方（运营账户）= ${body.from}`);
  console.log(`  每日预算 ${body.dailyBudget} B03，已发 ${body.dailySpent} B03`);

  const rec = await p.waitForTransaction(body.txHash);
  const after = await p.getBalance(learner.address);
  const delta = after - before;
  if (delta !== ethers.parseEther("10")) throw new Error(`余额增量 ${delta} ≠ 10 B03`);
  console.log(`  余额对账：${ethers.formatEther(before)} → ${ethers.formatEther(after)} B03（+10 ✓）status=${rec.status}`);

  // 治理负例：立刻再领一次，必须被冷却拒绝
  const res2 = await fetch(FAUCET_URL + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: learner.address }),
  });
  const body2 = await res2.json();
  if (res2.status !== 429) throw new Error(`冷却负例失败：期望 429，实际 ${res2.status}`);
  console.log(`  冷却负例 ✓：HTTP 429「${body2.error}」`);

  return {
    txHash: body.txHash,
    kind: "faucet-claim",
    faucet: body.from,
    amount: body.amount,
    balanceBefore: before.toString(),
    balanceAfter: after.toString(),
    rejection: { kind: "faucet-cooldown", http: res2.status, body: body2, address: env.LEARNER_ADDRESS },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}