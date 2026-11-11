// 步骤③：原生转账 2.5 B03（付款方 → 收款方），双向对账。
// 零 gas 链必须显式 legacy + gasPrice=0：ethers 默认按 EIP-1559 估算费用，
// 而本链 baseFee=0，type-2 交易的费用字段语义与公链不同（B04 实测教训）。
import { ethers } from "ethers";
import { learnerWallet, provider, loadEnv } from "./lib.mjs";

export const AMOUNT = ethers.parseEther("2.5");

export async function main() {
  const learner = learnerWallet();
  const env = loadEnv();
  const p = provider();
  const payee = env.PAYEE_ADDRESS;

  const beforePayer = await p.getBalance(learner.address);
  const beforePayee = await p.getBalance(payee);

  const tx = await learner.sendTransaction({
    to: payee,
    value: AMOUNT,
    type: 0,
    gasLimit: 21000n,
    gasPrice: 0n,
  });
  console.log(`已广播 tx=${tx.hash}（nonce=${tx.nonce}）`);
  const rec = await p.waitForTransaction(tx.hash);
  if (rec.status !== 1) throw new Error(`转账失败 status=${rec.status}`);

  const afterPayer = await p.getBalance(learner.address);
  const afterPayee = await p.getBalance(payee);
  const dPayer = beforePayer - afterPayer;
  const dPayee = afterPayee - beforePayee;
  if (dPayer !== AMOUNT || dPayee !== AMOUNT) {
    throw new Error(`双向对账失败：付款方 -${dPayer}，收款方 +${dPayee}，期望各 ${AMOUNT}`);
  }
  console.log(`双向对账 ✓：付款方 -${ethers.formatEther(dPayer)}，收款方 +${ethers.formatEther(dPayee)} B03`);
  console.log(`  gasUsed=${rec.gasUsed} effectiveGasPrice=${rec.gasPrice} → 手续费 0 wei（免的是手续费，不是本金）`);

  return { txHash: tx.hash, kind: "native-transfer", amount: ethers.formatEther(AMOUNT), payerDelta: dPayer.toString(), payeeDelta: dPayee.toString() };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}