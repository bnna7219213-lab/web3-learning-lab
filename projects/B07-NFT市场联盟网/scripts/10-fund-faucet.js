// scripts/10-fund-faucet.js —— 给 LabFaucet 合约充值（合约自己持币，发放才是链上转账）
//
// 私钥只从仓库根 .env 读，不进命令行（PowerShell → cmd 的 set VAR=... 会带尾随空格，
// ethers 会直接报 invalid BytesLike value）。
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PROJECT = path.resolve(__dirname, "..");
const REPO = path.resolve(PROJECT, "..", "..");

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

const env = { ...readEnvFile(path.join(PROJECT, "env", "consortium.env")), ...readEnvFile(path.join(REPO, ".env")) };
const RPC = env.RPC_URL || "http://127.0.0.1:8551";
const CHAIN_ID = Number(env.CHAIN_ID || 19880601);
const PK = (env.FAUCET_PK || "").trim();
if (!PK) throw new Error("根 .env 缺 FAUCET_PK");

const amount = ethers.parseEther(process.env.FUND_AMOUNT || "10000"); // 默认充值 10000 B03
const fac = JSON.parse(fs.readFileSync(path.join(PROJECT, "deployments", "faucet-latest.json"), "utf8").replace(/^\uFEFF/, ""));
const to = process.env.FAUCET_CONTRACT || fac.faucet;

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const signer = new ethers.Wallet(PK, provider);
  const before = await provider.getBalance(to);
  console.log("充值前合约余额:", ethers.formatEther(before), "B03");

  const tx = await signer.sendTransaction({
    to,
    value: amount,
    gasLimit: 100000n,
    gasPrice: 0n,
    type: 0, // 联盟网零 gas + legacy
  });
  const rec = await tx.wait();
  const after = await provider.getBalance(to);
  console.log("tx:", tx.hash, "block:", rec.blockNumber, "status:", rec.status);
  console.log("充值后合约余额:", ethers.formatEther(after), "B03");
  if (after <= before) {
    console.error("充值未生效");
    process.exit(1);
  }
})().catch((e) => {
  console.error("充值失败:", e.shortMessage || e.message);
  process.exit(1);
});
