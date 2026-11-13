// scripts/01-deploy.mjs —— 部署 ApprovalFlow（双人复核审批流）+ 授角色 + 写部署记录
// 角色映射（deployments/latest.json 同步记录）：
//   memberA → PROPOSER + REVIEWER   memberB → PROPOSER + REVIEWER   admin → EXECUTOR
//   双人复核的约束是「提案人 ≠ 复核人」（按提案粒度），不是按角色互斥。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, cfg, ok, hr, summary, ROOT, CHAIN_ID } from "./lib.mjs";

const GAS = { gasLimit: 300000n, gasPrice: 0n, type: 0 };
const DELAY = Number(process.env.APPROVAL_DELAY || 60); // 演示用 60s；验收脚本自建实例用 8s

hr("01 deploy ApprovalFlow");
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
console.log(`  admin=${admin.address}\n  memberA=${memberA.address}\n  memberB=${memberB.address}  delay=${DELAY}s`);

const flow = await new ethers.ContractFactory(art.abi, art.bytecode.object, admin).deploy(admin.address, DELAY, {
  gasLimit: 3_000_000n,
  gasPrice: 0n,
  type: 0,
});
await flow.waitForDeployment();
const addr = await flow.getAddress();
ok(true, `ApprovalFlow 部署于 ${addr}`);

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
ok(
  (await flow.hasRole(PROPOSER, memberA.address)) && (await flow.hasRole(REVIEWER, memberB.address)),
  "角色已授：memberA/memberB 提案+复核，admin 执行"
);

fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "abi"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "deployments", "latest.json"),
  JSON.stringify(
    {
      project: "B06",
      chainId: CHAIN_ID,
      approvalFlow: addr,
      delaySeconds: DELAY,
      admin: admin.address,
      proposers: [memberA.address, memberB.address],
      reviewers: [memberA.address, memberB.address],
      executors: [admin.address],
      deployedAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n"
);
fs.writeFileSync(path.join(ROOT, "abi", "ApprovalFlow.json"), JSON.stringify(art.abi, null, 2) + "\n");
console.log("  已写 deployments/latest.json 与 abi/ApprovalFlow.json");
summary("01 deploy");
