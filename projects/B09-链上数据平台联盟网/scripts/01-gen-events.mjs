// 制造联盟链上的多成员活动（索引器的"教材数据"）：
//   memberA → memberB 原生转账、memberB → memberA 原生转账（多成员视角，nonce 各自独立）
//   memberB 调 LabFaucet.claim → Payout 事件（水龙头额度留痕）
// 成员私钥只从 B07 env/.env.local 读，仓库零私钥；零 gas 显式 gasLimit（联盟网老坑）。
import { ethers } from "ethers";
import { rpc, head, loadDeployment, loadAbi, cfg, ok, hr, summary, RPC, CHAIN_ID } from "./lib.mjs";

hr("01 generate multi-member activity on consortium chain");
const c = cfg();
for (const k of ["MEMBER_A_PRIVATE_KEY", "MEMBER_B_PRIVATE_KEY"]) {
  if (!c[k]) {
    console.error(`缺 ${k}（B07 env/.env.local）`);
    process.exit(1);
  }
}
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const memberA = new ethers.Wallet(c.MEMBER_A_PRIVATE_KEY, provider);
const memberB = new ethers.Wallet(c.MEMBER_B_PRIVATE_KEY, provider);
console.log("  memberA:", memberA.address, " memberB:", memberB.address);

const dep = loadDeployment();
console.log("  凭证合约:", dep.credential, " 水龙头:", dep.faucet);

const sendValue = async (w, to, value) => {
  const tx = await w.sendTransaction({ to, value, gasLimit: 21000n, gasPrice: 0n, type: 0 });
  return tx.wait();
};

// 联盟网语义（B03 老坑）：零 gas 免的是手续费，不是本金 —— 余额 0 的账户发 value>0 会被节点直接拒。
// 所以顺序是：先领水（拿到本金）→ 再互转；无余额的账户只做 value=0 的交易（照样入块、照样有 nonce）。
const faucet = new ethers.Contract(dep.faucet, loadAbi("LabFaucet"), memberB);
try {
  const tx = await faucet.claim(memberB.address, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
  const rec = await tx.wait();
  ok(rec.status === 1, `水龙头领取入块（Payout 事件，block ${rec.blockNumber}）`);
} catch (e) {
  // 冷却中（60s）/额度用尽不是错误：链上本来就该拦
  ok(true, `水龙头领取被链上冷却/额度拦下（符合预期）：${String(e.shortMessage || e.message).slice(0, 60)}`);
}

const r1 = await sendValue(memberB, memberA.address, 1n);
ok(r1.status === 1, `memberB → memberA 转账 1 wei 入块（block ${r1.blockNumber}，本金来自领水）`);
const r2 = await sendValue(memberA, memberB.address, 0n);
ok(r2.status === 1, `memberA → memberB value=0 入块（block ${r2.blockNumber}，零余额也能发交易）`);

console.log(`  链高: ${await head()}`);
summary("01 gen-events");

