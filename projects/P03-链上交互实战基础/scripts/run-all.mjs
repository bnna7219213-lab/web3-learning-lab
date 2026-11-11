// 全流程编排：①建钱包 → ②领水 → ③转账 → ④ERC20 成功/失败 → ⑤零 gas 语义
// 产出：evidence/transactions.json（全部字段）+ docs/实测附录-逐字段解析.md（手册附录，可再生成）。
// 重跑注意：水龙头同地址 60s 冷却，两次 run-all 之间需间隔 60s 以上。
import fs from "node:fs";
import path from "node:path";
import { ROOT, RPC, CHAIN_ID, parseTx, renderTxMarkdown, saveEvidence, loadEnv } from "./lib.mjs";
import { main as newWallet } from "./01-new-wallet.mjs";
import { main as claim } from "./02-claim.mjs";
import { main as transfer } from "./03-transfer.mjs";
import { main as tokenLab } from "./04-token-lab.mjs";
import { main as zeroValue } from "./05-zero-value.mjs";

console.log("== P03 全流程（联盟网接管版）==\n");
console.log("[1/5] 建钱包"); const wallets = await newWallet();
console.log("\n[2/5] 领水（B03 水龙头）"); const claimed = await claim();
console.log("\n[3/5] 原生转账 + 双向对账"); const sent = await transfer();
console.log("\n[4/5] ERC20 部署/mint/成功/失败"); const token = await tokenLab();
console.log("\n[5/5] 零 gas 语义正负例"); const zero = await zeroValue();

const titles = [
  [claimed.txHash, "T1 · 水龙头领币（运营方 → 学习钱包，10 B03）"],
  [sent.txHash, "T2 · 原生转账（学习钱包 → 收款方，2.5 B03）"],
  [token.deployTx, "T3 · 合约部署（DemoToken，to=null）"],
  [token.mintTx, "T4 · ERC20 mint（from=0x0 的 Transfer 事件）"],
  [token.okTx, "T5 · ERC20 转账成功（250 DEMO，带 Transfer 日志）"],
  [token.failTx, "T6 · ERC20 转账失败（余额不足，status=0，gas 照烧）"],
  [zero.zeroValueTx, "T7 · 零余额账户的 value=0 交易（零 gas 语义正例）"],
];

console.log("\n== 逐字段解析 ==");
const cases = [];
for (const [hash, title] of titles) {
  const r = await parseTx(hash);
  cases.push({ title, ...r });
  console.log(`  ${title.split(" · ")[0]} ${hash} status=${r.receipt.status} block=#${r.block.number}`);
}

const env = loadEnv();
const evidence = {
  generatedAt: new Date().toISOString(),
  environment: "consortium-qbft-local",
  environmentNote: "2026-11-11 用户授权：公网测试网 faucet 不可用，领币环节由 B03 联盟网水龙头接管；公网测试网为可选附录。",
  chainId: CHAIN_ID,
  rpc: RPC,
  tokenAddress: token.tokenAddress,
  wallets: { learner: env.LEARNER_ADDRESS, payee: env.PAYEE_ADDRESS, empty: env.EMPTY_ADDRESS },
  cases,
  rejections: [claimed.rejection, zero.rejection],
};
const evFile = saveEvidence(evidence);

const appendix = [
  "# P03 实测附录 · 逐字段解析（自动生成）",
  "",
  `> 生成时间：${evidence.generatedAt} · chainId ${CHAIN_ID} · RPC ${RPC}`,
  "> 再生成：`node scripts/run-all.mjs`（需联盟网 + B03 水龙头在线，见 README）。",
  "> 本附录只放实测数据；字段含义与生命周期讲解见 [交易生命周期手册](./交易生命周期手册.md)。",
  "",
  ...cases.map((c) => renderTxMarkdown(c, c.title)),
  "## 被拒绝的请求（未入块，无 tx hash）",
  "",
  ...evidence.rejections.map((r) => `- **${r.kind}**：${JSON.stringify(r)}`),
  "",
];
const appendixFile = path.join(ROOT, "docs", "实测附录-逐字段解析.md");
fs.mkdirSync(path.dirname(appendixFile), { recursive: true });
fs.writeFileSync(appendixFile, appendix.join("\n"));

console.log(`\n✓ 证据：${evFile}`);
console.log(`✓ 附录：${appendixFile}`);
console.log(`✓ 共 ${cases.length} 笔入块交易（含 1 笔 status=0 失败）+ ${evidence.rejections.length} 条池层/治理拒绝`);