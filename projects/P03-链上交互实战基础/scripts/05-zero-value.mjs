// 步骤⑤：零 gas 语义实验（B03 实测结论的复证）。
// 正例：余额 0 的全新账户发 value=0 → 入块成功（免的是手续费，不是本金）。
// 负例：同一账户发 value=1 wei → 节点在交易池层直接拒（-32004），根本拿不到 tx hash。
// 这两条合起来才是「零 gas」的完整语义，缺一条都会形成错误认知。
import { ethers } from "ethers";
import { provider, loadEnv } from "./lib.mjs";

export async function main() {
  const env = loadEnv();
  const p = provider();
  const empty = new ethers.Wallet(env.EMPTY_PK, p);
  const bal = await p.getBalance(empty.address);
  if (bal !== 0n) console.log(`注意：空账户已有余额 ${bal}（跑过多次），负例仍按 value>balance 构造`);

  // 正例：value=0
  const tx0 = await empty.sendTransaction({ to: env.PAYEE_ADDRESS, value: 0n, type: 0, gasLimit: 21000n, gasPrice: 0n });
  const rec0 = await p.waitForTransaction(tx0.hash);
  if (rec0.status !== 1) throw new Error("value=0 交易应成功");
  console.log(`value=0 ✓ tx=${tx0.hash} status=1 gasUsed=${rec0.gasUsed}（余额 0 也能发）`);

  // 负例：value = balance + 1 wei → 池层拒绝
  const cur = await p.getBalance(empty.address);
  let rejection = null;
  try {
    const txbad = await empty.sendTransaction({ to: env.PAYEE_ADDRESS, value: cur + 1n, type: 0, gasLimit: 21000n, gasPrice: 0n });
    await p.waitForTransaction(txbad.hash);
    throw new Error("期望被节点拒绝，却入块了——检查 --tx-pool-enable-balance-check 配置");
  } catch (e) {
    const code = e.code ?? e.error?.code;
    rejection = { kind: "insufficient-funds-pool-reject", code, message: e.shortMessage || e.message };
    console.log(`value>balance ✓ 被拒：code=${code}「${rejection.message}」（无 tx hash，未入块）`);
  }

  return { zeroValueTx: tx0.hash, rejection };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}