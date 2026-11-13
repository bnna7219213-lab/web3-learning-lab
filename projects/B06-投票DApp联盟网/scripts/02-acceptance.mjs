// B06 链上验收（双人复核审批流 · 多成员账户体系）：
//   A. 两成员账户并发各 10 笔提案：全部入块、每账户 nonce 顺序正确（多账户 nonce 管理）
//   B. 双人复核全流程：提案 → 他人复核 → 生效延迟 → 执行；提案人复核自己的提案被拒（可读原因 + status=0 留痕）
//   C. 撤销窗口：通过后延迟结束前可撤，撤后不能执行
//   D. 权限负例：无角色成员发起提案 → 预检可读原因 + 链上留痕
//   E. 分支四条：零 gas / 3 节点终结性 / 多成员 nonce 不串 / 权限负例留痕
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, RPCS, rpc, blockHashes, cfg, ok, hr, summary, ROOT, CHAIN_ID } from "./lib.mjs";

const GAS = { gasLimit: 300000n, gasPrice: 0n, type: 0 };
const DELAY = 8; // 验收实例用 8s 生效延迟（等 ~9s 走完）

hr("0. build + deploy (consortium profile, delay=8s)");
const FORGE = ["C:\\Users\\bnna7\\.foundry\\bin\\forge.exe", "/usr/local/bin/forge", "forge"].find(
  (p) => p === "forge" || fs.existsSync(p)
);
execFileSync(FORGE, ["build"], { env: { ...process.env, FOUNDRY_PROFILE: "consortium" }, stdio: "pipe", cwd: ROOT });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, "out", "ApprovalFlow.sol", "ApprovalFlow.json")));
const c = cfg();
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const admin = new ethers.Wallet(c.ISSUER_PRIVATE_KEY, provider);
const memberA = new ethers.Wallet(c.MEMBER_A_PRIVATE_KEY, provider);
const memberB = new ethers.Wallet(c.MEMBER_B_PRIVATE_KEY, provider);
const outsider = new ethers.Wallet(c.OUTSIDER_PRIVATE_KEY, provider);
console.log(`  admin=${admin.address}\n  memberA=${memberA.address}\n  memberB=${memberB.address}\n  outsider=${outsider.address}`);

const flow = await new ethers.ContractFactory(art.abi, art.bytecode.object, admin).deploy(admin.address, DELAY, {
  gasLimit: 3_000_000n,
  gasPrice: 0n,
  type: 0,
});
await flow.waitForDeployment();
const addr = await flow.getAddress();
// 注意：deploymentTransaction().blockNumber 挖矿后仍可能为 null（响应对象不回填）→ 取回执
const deployBlock = (await flow.deploymentTransaction().wait()).blockNumber;
console.log(`  ApprovalFlow 部署于 ${addr}（block ${deployBlock}）`);
const PROPOSER = await flow.PROPOSER_ROLE();
const REVIEWER = await flow.REVIEWER_ROLE();
const EXECUTOR = await flow.EXECUTOR_ROLE();
for (const [role, who] of [
  [PROPOSER, memberA.address],
  [REVIEWER, memberA.address],
  [PROPOSER, memberB.address],
  [REVIEWER, memberB.address],
  [EXECUTOR, admin.address],
]) {
  await (await flow.grantRole(role, who, GAS)).wait();
}
const auditFile = path.join(ROOT, "data", "audit.jsonl");
fs.mkdirSync(path.dirname(auditFile), { recursive: true });
const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");

const probe = async (fn) => {
  try {
    await fn();
    return "";
  } catch (e) {
    try {
      const p = flow.interface.parseError(e.data ?? e.info?.error?.data ?? "0x");
      return p ? `${p.name}(${p.args.map(String).join(", ")})` : String(e.shortMessage || e.message);
    } catch {
      return String(e.shortMessage || e.message);
    }
  }
};
const sendReverting = async (fn) => {
  try {
    return await (await fn()).wait();
  } catch (e) {
    return e.receipt ?? null;
  }
};

// ============ A. 两成员并发各 10 笔提案 ============
hr("A. 2 members x 10 concurrent proposals (多账户 nonce 管理)");
const startA = await provider.getTransactionCount(memberA.address);
const startB = await provider.getTransactionCount(memberB.address);
const fire = (w, start) => {
  const out = [];
  for (let i = 0; i < 10; i++) {
    out.push(
      flow.connect(w).propose(admin.address, 0, "0x", `member-${w.address.slice(0, 6)}-#${i}`, {
        ...GAS,
        nonce: start + i,
      })
    );
  }
  return Promise.all(out);
};
const t0 = Date.now();
const sentA = await fire(memberA, startA);
const sentB = await fire(memberB, startB);
const recs = await Promise.all([...sentA, ...sentB].map((t) => t.wait()));
const ms = Date.now() - t0;
ok(recs.every((r) => r.status === 1), `20 笔提案全部入块且 status=1（${ms}ms）`);
const count = (await flow.proposalCount()).toString();
ok(count === "20", `提案计数 20（链上 proposalCount=${count}）`);
// 顺序正确：每账户按 nonce 排序后 (blockNumber, txIndex) 单调不减
const ordered = (wallet, res) => {
  const withNonce = res.map((r, i) => ({ nonce: startA + i, r })); // 仅用下标还原 nonce 顺序
  const sorted = [...withNonce].sort((a, b) => a.nonce - b.nonce);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].r;
    const cur = sorted[i].r;
    if (cur.blockNumber < prev.blockNumber) return false;
    if (cur.blockNumber === prev.blockNumber && cur.transactionIndex < prev.transactionIndex) return false;
  }
  return true;
};
ok(ordered(memberA, recs.slice(0, 10)) && ordered(memberB, recs.slice(10)), "每账户提案顺序与 nonce 一致（并发不乱序）");
const nonceA = await provider.getTransactionCount(memberA.address);
const nonceB = await provider.getTransactionCount(memberB.address);
ok(nonceA === startA + 10 && nonceB === startB + 10, `两账户 nonce 各自连续（A ${startA}→${nonceA}，B ${startB}→${nonceB}）`);

// ============ B. 双人复核全流程 ============
hr("B. dual-control flow: propose -> review by other -> delay -> execute");
// 并发下提案 id 按挖矿顺序分配，不能假定编号归属 → 按事件找「谁提的哪一单」
// Besu eth_getLogs 单次区间上限 5000 块 → 从部署块起查（0..latest 会被拒）
const evs = await flow.queryFilter(flow.filters.Proposed(), deployBlock, "latest");
const byA = evs.filter((e) => e.args.proposer.toLowerCase() === memberA.address.toLowerCase());
const byB = evs.filter((e) => e.args.proposer.toLowerCase() === memberB.address.toLowerCase());
ok(byA.length === 10 && byB.length === 10, `两账户各 10 个提案（事件口径 A=${byA.length} B=${byB.length}）`);
const idExec = byA[0].args.id; // memberA 提 → memberB 复核 → admin 执行
const idSelf = byA[1].args.id; // memberA 提 → memberA 自审（负例）
const idRevoke = byA[2].args.id; // 撤销窗口演示
const idWindow = byA[3].args.id; // 窗口关闭演示

const r1 = await (await flow.connect(memberB).approve(idExec, GAS)).wait();
ok(r1.status === 1, `memberB 复核通过 memberA 的提案 #${idExec}（双人复核：复核人 ≠ 提案人）`);
// 提案人复核自己的提案：预检可读原因 + status=0 留痕
const selfReason = await probe(() => flow.connect(memberA).approve.staticCall(idSelf));
ok(selfReason.includes("ProposerCannotReview"), `提案人复核自己的提案被拒，可读原因：${selfReason}`);
const r2 = await sendReverting(() => flow.connect(memberA).approve(idSelf, { ...GAS, gasLimit: 150000n }));
ok(r2 && r2.status === 0, `该操作交易入块但 status=0（链上留痕，block ${r2?.blockNumber}）`);
audit({ kind: "blocked", action: "self-approve", actor: memberA.address, reason: selfReason, tx: r2?.hash });

// 生效延迟：没到不能执行
const earlyReason = await probe(() => flow.connect(admin).execute.staticCall(idExec));
ok(earlyReason.includes("TooEarly"), `延迟未到执行被拒（${earlyReason.slice(0, 40)}…）`);
console.log(`  等待生效延迟 ${DELAY + 1}s…`);
await new Promise((r) => setTimeout(r, (DELAY + 1) * 1000));
const r3 = await (await flow.connect(admin).execute(idExec, GAS)).wait();
ok(r3.status === 1, `延迟结束后 admin 执行成功（block ${r3.blockNumber}）`);
ok((await flow.stateOf(idExec)).toString() === "5", "提案状态进入 Executed（终态）");

// ============ C. 撤销窗口 ============
hr("C. revocation window (生效延迟内可撤，撤后不能执行)");
const r4 = await (await flow.connect(memberB).approve(idRevoke, GAS)).wait();
ok(r4.status === 1, `memberA 的提案 #${idRevoke} 由 memberB 复核通过`);
const r5 = await (await flow.connect(memberA).revoke(idRevoke, GAS)).wait();
ok(r5.status === 1, `提案人在窗口内撤回（block ${r5.blockNumber}）`);
ok((await flow.stateOf(idRevoke)).toString() === "4", "提案状态 Revoked");
const afterRevoke = await probe(() => flow.connect(admin).execute.staticCall(idRevoke));
ok(afterRevoke.includes("WrongState"), `撤回后不能再执行（${afterRevoke.slice(0, 30)}…）`);
// 窗口关闭后也不能撤：以「已产生时间戳超过 executeAfter 的新块」为准，
// 不能只睡固定秒数——QBFT 是出块时间语义，墙上时钟到了不代表链上时间已经到了。
const windowApproved = await (await flow.connect(memberB).approve(idWindow, GAS)).wait();
const windowProposal = await flow.getProposal(idWindow);
let windowClosed = false;
for (let i = 0; i < 30 && !windowClosed; i++) {
  const tip = await provider.getBlock("latest");
  windowClosed = tip.timestamp >= Number(windowProposal.executeAfter);
  if (!windowClosed) await new Promise((r) => setTimeout(r, 2000));
}
ok(windowClosed, `链上时间已越过撤销窗口（executeAfter=${windowProposal.executeAfter}）`);
const closedReason = await probe(() => flow.connect(memberA).revoke.staticCall(idWindow));
ok(closedReason.includes("WindowClosed"), `延迟结束后撤销窗口关闭（${closedReason.slice(0, 30)}…）`);

// ============ D. 权限负例：无角色成员发起提案 ============
hr("D. unauthorized propose -> readable reason + chain trace");
const unauthReason = await probe(() => flow.connect(outsider).propose.staticCall(admin.address, 0, "0x", "越权"));
ok(unauthReason.includes("AccessControlUnauthorizedAccount"), `预检可读拒绝原因：${unauthReason}`);
const r6 = await sendReverting(() => flow.connect(outsider).propose(admin.address, 0, "0x", "越权", { ...GAS, gasLimit: 150000n }));
ok(r6 && r6.status === 0, `越权提案交易入块但 status=0（链上留痕，block ${r6?.blockNumber}）`);
audit({ kind: "blocked", action: "propose", actor: outsider.address, reason: unauthReason, tx: r6?.hash });

// ============ E. 分支四条增量 ============
hr("E. consortium increments (零 gas / 终结性)");
const gasPrice = await rpc("eth_gasPrice");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
ok(BigInt(gasPrice) === 0n && BigInt(latest.baseFeePerGas ?? "0x0") === 0n, `零 gas 成立（eth_gasPrice=${gasPrice} baseFee=${latest.baseFeePerGas}）`);
const hashes = await blockHashes(r3.blockNumber);
const uniq = new Set(hashes.map((x) => x.hash));
ok(uniq.size === 1 && !uniq.has(null), `终结性：块 #${r3.blockNumber} 哈希在 ${hashes.length} 节点一致`);

summary("02 acceptance (B06)");
