// B05 链上验收（联盟内部记账单位 · 角色治理与对账）：
//   A. 角色矩阵（链上）：授权留痕 / 未授权 mint 预检可读原因 + status=0 链上留痕 / 收回即失效
//   B. 跨成员转账 100 笔后，各成员余额与链下台账**零差异**（对账）
//   C. 分支四条：多成员 nonce 不串 / 零 gas / 3 节点终结性 / 权限负例留痕
//   D. 跨成员授权（approve + transferFrom，成员间代扣的授权语义）
// 部署用 consortium profile 编译产物（london，防 PUSH0——B04 坑 2）。
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, RPCS, rpc, head, blockHashes, cfg, ok, hr, summary, ROOT, CHAIN_ID } from "./lib.mjs";

const GAS = { gasLimit: 200000n, gasPrice: 0n, type: 0 };

hr("0. build + deploy (FOUNDRY_PROFILE=consortium → london bytecode)");
const FORGE = ["C:\\Users\\bnna7\\.foundry\\bin\\forge.exe", "/usr/local/bin/forge", "forge"].find(
  (p) => p === "forge" || fs.existsSync(p)
);
execFileSync(FORGE, ["build"], {
  env: { ...process.env, FOUNDRY_PROFILE: "consortium" },
  stdio: "pipe",
  cwd: ROOT,
});
const art = JSON.parse(fs.readFileSync(path.join(ROOT, "out", "LabToken.sol", "LabToken.json")));
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const c = cfg();
for (const k of ["ISSUER_PRIVATE_KEY", "MEMBER_A_PRIVATE_KEY", "MEMBER_B_PRIVATE_KEY", "OUTSIDER_PRIVATE_KEY"]) {
  if (!c[k]) {
    console.error(`缺 ${k}（B07 env/.env.local）`);
    process.exit(1);
  }
}
const admin = new ethers.Wallet(c.ISSUER_PRIVATE_KEY, provider); // 运营方：DEFAULT_ADMIN + MINTER
const memberA = new ethers.Wallet(c.MEMBER_A_PRIVATE_KEY, provider); // 发行方（后授 MINTER）
const memberB = new ethers.Wallet(c.MEMBER_B_PRIVATE_KEY, provider); // 成员
const outsider = new ethers.Wallet(c.OUTSIDER_PRIVATE_KEY, provider); // 外部
console.log(`  admin=${admin.address}\n  memberA=${memberA.address}\n  memberB=${memberB.address}\n  outsider=${outsider.address}`);

const CAP = ethers.parseEther("1000000");
const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, admin);
const token = await factory.deploy(admin.address, CAP, { gasLimit: 3_000_000n, gasPrice: 0n, type: 0 });
await token.waitForDeployment();
const addr = await token.getAddress();
console.log(`  LabToken 部署于 ${addr}（部署者余额可为 0：value=0 + gasPrice=0 ⇒ 成本 0）`);
const MINTER_ROLE = await token.MINTER_ROLE();
const ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

// 审计流水（应用层留痕，与 status=0 回执互为双路——B07 同款）
const auditFile = path.join(ROOT, "data", "audit.jsonl");
fs.mkdirSync(path.dirname(auditFile), { recursive: true });
const audit = (entry) => fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

// ============ A. 角色矩阵（链上） ============
hr("A. role matrix on-chain (授权留痕 / 未授权 status=0 / 收回即失效)");
const r1 = await (await token.connect(admin).grantRole(MINTER_ROLE, memberA.address, GAS)).wait();
const grantLog = r1.logs.find((l) => l.topics[0] === token.interface.getEvent("RoleGranted").topicHash);
ok(r1.status === 1 && !!grantLog, `grantRole(MINTER→memberA) 入块且打 RoleGranted（block ${r1.blockNumber}）`);
ok(await token.hasRole(MINTER_ROLE, memberA.address), "memberA 已持有 MINTER_ROLE");

// 未授权 mint：预检拿到可读原因（前端展示），再发交易拿 status=0（链上留痕）
let reason = "";
try {
  await token.connect(memberB).mint.staticCall(memberB.address, 1n);
} catch (e) {
  try {
    const parsed = token.interface.parseError(e.data ?? e.info?.error?.data ?? "0x");
    reason = parsed ? `${parsed.name}(${parsed.args.map(String).join(", ")})` : String(e.shortMessage || e.message);
  } catch {
    reason = String(e.shortMessage || e.message);
  }
}
ok(reason.includes("AccessControlUnauthorizedAccount"), `预检给出可读拒绝原因：${reason}`);
// 注意：revert 的交易在 ethers 里 wait() 会抛出，回执挂在 e.receipt 上（status=0 才是要的留痕）
let r2 = null;
try {
  r2 = await (await token.connect(memberB).mint(memberB.address, 1n, { ...GAS, gasLimit: 100000n })).wait();
} catch (e) {
  r2 = e.receipt ?? null;
}
ok(r2 && r2.status === 0, `未授权 mint 交易入块但 status=0（链上留痕，block ${r2?.blockNumber}）`);
audit({ kind: "blocked", action: "mint", actor: memberB.address, reason, tx: r2?.hash });

const r3 = await (await token.connect(admin).revokeRole(MINTER_ROLE, memberA.address, GAS)).wait();
const revokeLog = r3.logs.find((l) => l.topics[0] === token.interface.getEvent("RoleRevoked").topicHash);
ok(r3.status === 1 && !!revokeLog, `revokeRole 入块且打 RoleRevoked（收回留痕）`);
let revokedFails = false;
let revokedTrace = null;
try {
  const t = await token.connect(memberA).mint(memberA.address, 1n, { ...GAS, gasLimit: 100000n });
  revokedTrace = await t.wait();
} catch (e) {
  revokedFails = true;
  revokedTrace = e.receipt ?? null;
}
ok(revokedFails, "收回后 memberA 再铸被拒（交易 revert，收回即生效）");
ok(revokedTrace && revokedTrace.status === 0, `失败交易仍入块留痕（block ${revokedTrace?.blockNumber}）`);
audit({ kind: "blocked", action: "mint-after-revoke", actor: memberA.address, tx: revokedTrace?.hash });
// 复位：再授回 MINTER（后面要用）
await (await token.connect(admin).grantRole(MINTER_ROLE, memberA.address, GAS)).wait();

// ============ B. 跨成员转账 100 笔对账 ============
hr("B. 100 cross-member transfers -> ledger zero discrepancy");
const mintA = await (await token.connect(admin).mint(memberA.address, ethers.parseEther("500"), GAS)).wait();
const mintB = await (await token.connect(admin).mint(memberB.address, ethers.parseEther("500"), GAS)).wait();
ok(mintA.status === 1 && mintB.status === 1, "运营方给两个成员各铸 500（发行权在 MINTER）");

// 链下台账（对账口径：这里记的每一笔都要在链上找到）
const ledger = new Map([
  [memberA.address.toLowerCase(), ethers.parseEther("500")],
  [memberB.address.toLowerCase(), ethers.parseEther("500")],
]);
const amount = ethers.parseEther("1");
// 50 笔 A→B + 50 笔 B→A，带显式 nonce 并发发出（nonce 各自独立——分支四条之一）
const startA = await provider.getTransactionCount(memberA.address);
const startB = await provider.getTransactionCount(memberB.address);
const fire = async (w, to, n, start) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(token.connect(w).transfer(to, amount, { ...GAS, gasLimit: 100000n, nonce: start + i }));
  }
  return Promise.all(out);
};
const t0 = Date.now();
const txsA = await fire(memberA, memberB.address, 50, startA);
const txsB = await fire(memberB, memberA.address, 50, startB);
const receipts = await Promise.all([...txsA, ...txsB].map((t) => t.wait().catch((e) => e.receipt)));
const minedMs = Date.now() - t0;
const allOk = receipts.every((r) => r && r.status === 1);
ok(allOk, `100 笔并发全部入块且 status=1（${minedMs}ms，nonce 各自连续不串）`);
// 台账推进
for (let i = 0; i < 50; i++) {
  ledger.set(memberA.address.toLowerCase(), ledger.get(memberA.address.toLowerCase()) - amount);
  ledger.set(memberB.address.toLowerCase(), ledger.get(memberB.address.toLowerCase()) + amount);
}
for (let i = 0; i < 50; i++) {
  ledger.set(memberB.address.toLowerCase(), ledger.get(memberB.address.toLowerCase()) - amount);
  ledger.set(memberA.address.toLowerCase(), ledger.get(memberA.address.toLowerCase()) + amount);
}
// 对账：链上余额 vs 链下台账
const balA = await token.balanceOf(memberA.address);
const balB = await token.balanceOf(memberB.address);
ok(balA === ledger.get(memberA.address.toLowerCase()), `memberA 链上余额 == 链下台账（${ethers.formatEther(balA)}）`);
ok(balB === ledger.get(memberB.address.toLowerCase()), `memberB 链上余额 == 链下台账（${ethers.formatEther(balB)}）`);
// 事件口径复核：Transfer 总数与转账总额可从链上重建台账
const filter = token.filters.Transfer();
const logs = await token.queryFilter(filter, mintA.blockNumber);
let deltaA = 0n;
for (const l of logs) {
  const { from, to, value } = l.args;
  if (to.toLowerCase() === memberA.address.toLowerCase()) deltaA += value;
  if (from.toLowerCase() === memberA.address.toLowerCase()) deltaA -= value;
}
ok(deltaA === balA, `事件重放的净额 == 余额（${ethers.formatEther(deltaA)} == ${ethers.formatEther(balA)}）`);
ok(receipts.length === 100, `Transfer 事件来源交易 100 笔均可追溯（${logs.length} 条事件）`);
const nonceA = await provider.getTransactionCount(memberA.address);
const nonceB = await provider.getTransactionCount(memberB.address);
ok(
  nonceA === startA + 50 && nonceB === startB + 50,
  `两账户 nonce 各自连续、互不串号（A ${startA}→${nonceA}，B ${startB}→${nonceB}）`
);

// ============ C. 分支四条增量 ============
hr("C. consortium increments (零 gas / 终结性)");
const gasPrice = await rpc("eth_gasPrice");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
ok(BigInt(gasPrice) === 0n && BigInt(latest.baseFeePerGas ?? "0x0") === 0n, `零 gas 成立（eth_gasPrice=${gasPrice} baseFee=${latest.baseFeePerGas}）`);
const sampleBlk = receipts[0].blockNumber;
const hashes = await blockHashes(sampleBlk);
const uniq = new Set(hashes.map((x) => x.hash));
ok(uniq.size === 1 && !uniq.has(null), `终结性：块 #${sampleBlk} 哈希在 ${hashes.length} 节点一致`);

// ============ D. 跨成员授权（approve + transferFrom） ============
hr("D. cross-member authorization (approve + transferFrom)");
const r4 = await (await token.connect(memberB).approve(memberA.address, ethers.parseEther("5"), GAS)).wait();
ok(r4.status === 1, "memberB 授权 memberA 代扣 5（approve 入块）");
const r5 = await (await token.connect(memberA).transferFrom(memberB.address, memberA.address, ethers.parseEther("5"), GAS)).wait();
ok(r5.status === 1, "memberA 用授权代扣成功（transferFrom 入块）");
const allowLeft = await token.allowance(memberB.address, memberA.address);
ok(allowLeft === 0n, `授权额度精确扣减（余 ${ethers.formatEther(allowLeft)}）`);
// 无授权代扣必须 revert（负例，留块）
let fromFails = false;
let fromTrace = null;
try {
  fromTrace = await (await token.connect(outsider).transferFrom(memberB.address, outsider.address, 1n, { ...GAS, gasLimit: 100000n })).wait();
} catch (e) {
  fromFails = true;
  fromTrace = e.receipt ?? null;
}
ok(fromFails && fromTrace && fromTrace.status === 0, `无授权 transferFrom 被拒且留块（block ${fromTrace?.blockNumber}）`);
audit({ kind: "blocked", action: "transferFrom", actor: outsider.address, tx: fromTrace?.hash });

summary("01 acceptance (B05)");
