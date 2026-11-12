// scripts/11-grant-service-issuer.js —— 给「发证服务专用签发账户」授权
//
// 为什么需要独立账户：链上派生「当日服务发放份数」时，必须能把
//   · 用户领取路径（发证服务签发）与
//   · 运营方批量发行（05-batch-1000.js 一次发 1000 份）
// 分开统计 —— 否则批量发行会占满服务当日的发放配额，把用户路径锁死。
// 授权内容：MINTER_ROLE（发凭证）+ DEFAULT_ADMIN_ROLE（setMember 登记成员）。
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { cfg, deployment, abi, provider, ok, summary, hr } = require("./lib/b07");

const SERVICE_ISSUER = "0xA353D97233B85734f5462BbF76362e635Ad2281B";

(async () => {
  hr("11 grant service issuer roles (MINTER + DEFAULT_ADMIN)");
  const c = cfg();
  const pk = String(c.ISSUER_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("缺 ISSUER_PRIVATE_KEY");
  const p = provider();
  const admin = new ethers.Wallet(pk, p);
  const dep = deployment();
  const cred = new ethers.Contract(dep.credential, abi(), admin);

  const MINTER = await cred.MINTER_ROLE();
  const DEFAUL = await cred.DEFAULT_ADMIN_ROLE();
  console.log("  admin          :", admin.address);
  console.log("  service issuer :", SERVICE_ISSUER);

  const hasMinter = await cred.hasRole(MINTER, SERVICE_ISSUER);
  const hasAdmin = await cred.hasRole(DEFAUL, SERVICE_ISSUER);
  console.log("  已授权 minter:", hasMinter, " 已授权 admin:", hasAdmin);

  if (!hasMinter) {
    const tx = await cred.grantRole(MINTER, SERVICE_ISSUER, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
    await tx.wait();
    console.log("  granted MINTER_ROLE:", tx.hash);
  }
  if (!hasAdmin) {
    const tx = await cred.grantRole(DEFAUL, SERVICE_ISSUER, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
    await tx.wait();
    console.log("  granted DEFAULT_ADMIN_ROLE:", tx.hash);
  }

  ok((await cred.hasRole(MINTER, SERVICE_ISSUER)) === true, "服务账户持有 MINTER_ROLE");
  ok((await cred.hasRole(DEFAUL, SERVICE_ISSUER)) === true, "服务账户持有 DEFAULT_ADMIN_ROLE（可 setMember）");

  const latestPath = path.join(__dirname, "..", "deployments", "latest.json");
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8").replace(/^\uFEFF/, ""));
  latest.serviceIssuer = SERVICE_ISSUER;
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n", "utf8");
  console.log("  recorded deployments/latest.json serviceIssuer =", SERVICE_ISSUER);

  summary("11 grant service issuer");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
