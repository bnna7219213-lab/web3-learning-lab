// scripts/09-budget-governance.js —— B03 × B07 预算治理衔接验收
//
// 链路：B03 faucet(8560) → 链上额度合约 LabFaucet（每日额度链上强制）→ 回调 B07 发证服务(8580)
//       → 当日发证数按链上事件派生 → 凭证配额与水龙头当日额度联动。
//
// 核心命题：**额度与用量都只认链上事实**。
//   正例：领币 → 链上 spent +10 → 同时发证 → 链上 CredentialIssued +1
//   负例 A：伪造水龙头本地记账（写成「今日已发满 500」）→ 服务照旧按链上额度放行
//   负例 B：绕过 HTTP 直接调合约领币 → 服务侧随即被链上冷却拦下（冷却在链上）
//   负例 C：链上额度调小到用尽 → HTTP /claim 与「发证」双双被拒
//   负例 D：伪造发证服务本地记账（issued 改 0）→ 配额判定仍按链上
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const {
  credential,
  provider,
  deployment,
  ok,
  summary,
  hr,
  REPO,
  faucetContract,
  chainIssuedToday,
  chainIssuedIntegrity,
  chainFaucetBudget,
} = require("./lib/b07");

const FAUCET = process.env.FAUCET_URL || "http://127.0.0.1:8560";
const CRED = process.env.CREDENTIAL_URL || "http://127.0.0.1:8580";
const CAP_DEFAULT = 500n * 10n ** 18n;
const AMOUNT = 10n * 10n ** 18n;

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const rootEnv = readEnvFile(path.join(REPO, ".env"));

function b03FaucetDir() {
  const projects = path.join(REPO, "projects");
  const hit = fs
    .readdirSync(projects)
    .find((d) => d.startsWith("B03-") && fs.existsSync(path.join(projects, d, "faucet", "server.js")));
  if (!hit) throw new Error("找不到 B03 项目目录");
  return path.join(projects, hit, "faucet");
}
const FAUCET_DATA = path.join(b03FaucetDir(), "data", "claims.json");
const CRED_DATA = path.join(__dirname, "data", "credential-claims.json");

async function get(url) {
  const r = await fetch(url);
  let j = null;
  try {
    j = await r.json();
  } catch (e) {}
  return { status: r.status, body: j };
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try {
    j = await r.json();
  } catch (e) {}
  return { status: r.status, body: j };
}

// 拉起一个「带着伪造记账文件」的独立服务实例 —— 这才是真实攻击路径：
// 篡改本地记账后重启服务，看它会不会被本地文件骗到。
async function startInstance({ cwd, script, env, healthUrl, logName }) {
  const logFile = path.join(os.tmpdir(), logName);
  const proc = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(logFile);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(healthUrl);
      if (r.ok) return { proc, logFile, stop: () => proc.kill() };
    } catch (e) {}
  }
  proc.kill();
  throw new Error(`实例启动失败：${healthUrl}（日志 ${logFile}）`);
}

(async () => {
  hr("09 B03 x B07 budget governance (on-chain allowance + on-chain usage)");
  const p = provider();
  const cred = credential(p);
  const dep = deployment();
  const faucet = faucetContract(p);
  const admin = new ethers.Wallet(rootEnv.FAUCET_PK.trim(), p); // 链上额度策略的 admin
  const FAUCET_ADDR = dep.faucet;
  const SERVICE_ISSUER = dep.serviceIssuer; // 发证服务专用签发账户
  console.log("  额度合约:", FAUCET_ADDR, " admin:", admin.address);
  console.log("  凭证合约:", dep.credential, " 服务签发账户:", SERVICE_ISSUER);

  // ============ 正例：链上额度 → 领币 → 链上发证 ============
  const before = await chainFaucetBudget(p);
  console.log(
    `  链上额度: spent=${ethers.formatEther(before.spent)} remaining=${ethers.formatEther(before.remaining)} cap=${ethers.formatEther(before.cap)}`
  );
  ok(before.source === "chain", "额度口径来自链上（dailyInfo）");
  ok(before.cap === CAP_DEFAULT, `链上每日额度 = 500 B03（实测 ${ethers.formatEther(before.cap)}）`);

  const status0 = await get(`${FAUCET}/status`);
  ok(status0.body && status0.body.budget && status0.body.budget.source === "chain", "水龙头 /status 的额度来自链上");

  const alice = ethers.Wallet.createRandom();
  const issuedBefore = await chainIssuedToday(p, dep.credential, SERVICE_ISSUER);
  const claim = await post(`${FAUCET}/claim`, { address: alice.address });
  console.log(`  faucet HTTP ${claim.status}`);
  ok(claim.status === 200 && claim.body && claim.body.ok, "领币成功（HTTP 200）");
  ok(claim.body && claim.body.budget && claim.body.budget.source === "chain", "领币响应里的额度口径是链上");
  ok(claim.body && claim.body.credential && claim.body.credential.ok, "同一次领取带回凭证（衔接生效）");

  const after = await chainFaucetBudget(p);
  ok(after.spent === before.spent + AMOUNT, `链上已发放 +10 B03（${ethers.formatEther(after.spent)}）`);
  ok(after.remaining === before.remaining - AMOUNT, "链上剩余额度相应减少");

  const bal = await p.getBalance(alice.address);
  ok(bal === AMOUNT, `链上余额 10 B03（实测 ${ethers.formatEther(bal)}）`);

  const issuedNow = await chainIssuedToday(p, dep.credential, SERVICE_ISSUER);
  ok(issuedNow.issued >= 1n, `当日服务发放份数（链上按签发者派生）= ${issuedNow.issued}`);
  ok(
    issuedNow.issued === issuedBefore.issued + 1n,
    `本次领取对应的凭证在链上可数（服务签发口径 ${issuedBefore.issued} → ${issuedNow.issued}）`
  );
  const integrity = await chainIssuedIntegrity(p, dep.credential, cred);
  ok(
    integrity.ok,
    `事件日志完整性自检通过（日志 count 合计 ${integrity.logCount} == nextId ${integrity.nextId}）`
  );

  const credStatus = await get(`${CRED}/status`);
  ok(
    credStatus.body && credStatus.body.dayIssued === issuedNow.issued.toString(),
    "发证服务 /status 的当日已发数与链上一致"
  );
  ok(
    credStatus.body && credStatus.body.integrity && credStatus.body.integrity.ok,
    "发证服务自检：链上用量可独立复核"
  );

  // ============ 负例 A：伪造水龙头本地记账（伪造文件 + 重启实例） ============
  const today = new Date().toISOString().slice(0, 10);
  const forgedFaucetFile = path.join(os.tmpdir(), "b03-forged-claims.json");
  fs.writeFileSync(
    forgedFaucetFile,
    JSON.stringify({
      claims: Array.from({ length: 50 }, (_, i) => ({
        day: today,
        at: new Date().toISOString(),
        address: "0x" + String(i).padStart(40, "0"),
        amount: "10.0",
        txHash: "0x" + "f".repeat(64),
        block: 1,
      })),
    })
  );
  const fakeFaucet = await startInstance({
    cwd: b03FaucetDir(),
    script: "server.js",
    env: {
      FAUCET_PK: rootEnv.FAUCET_PK.trim(),
      FAUCET_PORT: "8590",
      FAUCET_DATA: forgedFaucetFile,
      CREDENTIAL_URL: "", // 隔离：这个实例只测额度判定，不回调发证
    },
    healthUrl: "http://127.0.0.1:8590/health",
    logName: "b09-forged-faucet.log",
  });
  try {
    const st1 = await get("http://127.0.0.1:8590/status");
    ok(
      st1.body && st1.body.audit && st1.body.audit.amount === 500,
      "伪造实例启动后，本地流水显示「今日已发 500 B03」（等于额度上限）"
    );
    const bob = ethers.Wallet.createRandom();
    const claim2 = await post("http://127.0.0.1:8590/claim", { address: bob.address });
    ok(
      claim2.status === 200 && claim2.body && claim2.body.ok,
      "带着「已发满」的本地文件，照样按链上额度放行（本地记账不参与判定）"
    );
    const after2 = await chainFaucetBudget(p);
    ok(after2.spent === after.spent + AMOUNT, "链上已发放只按真实领取累加");
    ok(
      claim2.body && claim2.body.budget && claim2.body.budget.source === "chain",
      "响应里的额度口径仍是链上"
    );
  } finally {
    fakeFaucet.stop();
  }
  fs.unlinkSync(forgedFaucetFile);

  // ============ 负例 B：绕过 HTTP 直接调合约（冷却在链上） ============
  const carol = ethers.Wallet.createRandom();
  const direct = await faucet.connect(admin).claim(carol.address, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
  await direct.wait();
  ok(true, "绕过 HTTP 直接调合约领币成功（链上允许公开领取）");
  const claim3 = await post(`${FAUCET}/claim`, { address: carol.address });
  ok(claim3.status === 429, `同一地址经服务再领被拒（HTTP ${claim3.status}）`);
  console.log("  拒绝原因:", ((claim3.body && claim3.body.error) || "").slice(0, 80));

  // ============ 负例 C：链上额度用尽 → 领币与发证双双被拒 ============
  const spentNow = (await chainFaucetBudget(p)).spent;
  await (await faucet.connect(admin).setPolicy(spentNow, AMOUNT, 60n, { gasLimit: 200000n, gasPrice: 0n, type: 0 })).wait();
  console.log(`  已把链上 dailyCap 调到 ${ethers.formatEther(spentNow)}（= 已发放额，剩余为 0）`);
  const dave = ethers.Wallet.createRandom();
  const claim4 = await post(`${FAUCET}/claim`, { address: dave.address });
  ok(claim4.status === 429, `链上额度用尽 → 领币被拒（HTTP ${claim4.status}）`);
  console.log("  拒绝原因:", ((claim4.body && claim4.body.error) || "").slice(0, 80));
  const claim5 = await post(`${CRED}/claim`, { address: alice.address, purpose: "budget-test" });
  ok(claim5.status === 429, `水龙头额度用尽 → 发证也被拒（HTTP ${claim5.status}）`);
  console.log("  拒绝原因:", ((claim5.body && claim5.body.error) || "").slice(0, 100));
  // 恢复策略
  await (await faucet.connect(admin).setPolicy(CAP_DEFAULT, AMOUNT, 60n, { gasLimit: 200000n, gasPrice: 0n, type: 0 })).wait();
  const restored = await chainFaucetBudget(p);
  ok(restored.cap === CAP_DEFAULT && restored.remaining > 0n, "链上额度策略已恢复（500 B03）");

  // ============ 负例 D：伪造发证服务本地记账（伪造「配额已满」+ 重启实例） ============
  const forgedCredFile = path.join(os.tmpdir(), "b07-forged-claims.json");
  fs.writeFileSync(
    forgedCredFile,
    JSON.stringify({ lastClaim: {}, day: today, issued: "999999" }) // 伪造：本地写着「今日配额已满」
  );
  const fakeCred = await startInstance({
    cwd: path.resolve(__dirname, ".."),
    script: path.join("scripts", "credential-service.js"),
    env: { CREDENTIAL_PORT: "8581", CREDENTIAL_DATA: forgedCredFile },
    healthUrl: "http://127.0.0.1:8581/health",
    logName: "b09-forged-cred.log",
  });
  try {
    const st2 = await get("http://127.0.0.1:8581/status");
    const issuedChainNow = (await chainIssuedToday(p, dep.credential, SERVICE_ISSUER)).issued.toString();
    ok(
      st2.body && st2.body.audit && st2.body.audit.dayIssued === "999999",
      "伪造实例启动后，本地 issued 显示 999999（远超每日配额 100）"
    );
    ok(
      st2.body && st2.body.dayIssued === issuedChainNow,
      `但链上派生的当日已发数仍是 ${issuedChainNow}（本地伪造不影响判定口径）`
    );
    // 若判定读本地，这里会因「配额已满」被拒；实际应按链上口径放行
    const claim7 = await post("http://127.0.0.1:8581/claim", { address: alice.address, purpose: "budget-test" });
    ok(claim7.status === 200 && claim7.body && claim7.body.ok, "带着「配额已满」的本地文件，领证照样成功");
    ok(
      claim7.body && claim7.body.dayIssuedLocal === "1000000",
      "本地审计计数被继续累加（说明它确实只是流水）"
    );
    ok(
      claim7.body && BigInt(claim7.body.dayIssued) === BigInt(issuedChainNow) + 1n,
      "响应里的当日已发数是链上口径（+1）"
    );
  } finally {
    fakeCred.stop();
  }
  fs.unlinkSync(forgedCredFile);

  summary("09 budget-governance");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
