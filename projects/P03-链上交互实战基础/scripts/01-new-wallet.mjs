// 步骤①：生成三个一次性学习钱包（付款方 / 收款方 / 空账户）。
// 私钥只写进本项目 .env（.gitignore 已排除），不打印、不落日志。
// 等价 cast 命令：cast wallet new --json（ethers 与 cast 都是 secp256k1 纯本地计算，不需要节点）。
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadEnv } from "./lib.mjs";

export async function main() {
  const envFile = path.join(ROOT, ".env");
  const existing = loadEnv();
  if (existing.LEARNER_PK && existing.PAYEE_PK && existing.EMPTY_PK) {
    console.log("复用已有钱包（.env 已存在，不覆盖密钥）：");
    console.log("  LEARNER（付款方） =", existing.LEARNER_ADDRESS);
    console.log("  PAYEE  （收款方） =", existing.PAYEE_ADDRESS);
    console.log("  EMPTY  （空账户） =", existing.EMPTY_ADDRESS);
    return { reused: true, learner: existing.LEARNER_ADDRESS, payee: existing.PAYEE_ADDRESS, empty: existing.EMPTY_ADDRESS };
  }

  const roles = [["LEARNER", "付款方"], ["PAYEE", "收款方"], ["EMPTY", "空账户（零 gas 语义实验）"]];
  const lines = [
    "# P03 一次性学习钱包（联盟链 chainId 19880601，零价值）。",
    "# 由 scripts/01-new-wallet.mjs 生成；真实私钥永不入库。",
    "# 派生路径：ethers.Wallet.createRandom() 默认 m/44'/60'/0'/0/0（BIP-44）。",
  ];
  const out = { reused: false };
  for (const [key, label] of roles) {
    const w = ethers.Wallet.createRandom();
    lines.push(`${key}_PK=${w.privateKey}`);
    lines.push(`${key}_ADDRESS=${w.address}`);
    out[key.toLowerCase()] = w.address;
    console.log(`${label} ${key} = ${w.address}`);
  }
  fs.writeFileSync(envFile, lines.join("\n") + "\n");
  console.log(`已写入 ${envFile}（gitignored）。助记词与私钥不打印。`);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}