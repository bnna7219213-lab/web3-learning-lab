// scripts/lib/b08.js —— B08 联盟网脚本公共层（沿用 B07 的三条硬规矩）
//   1. 零 gas：gasPrice = 0 + legacy(type 0)
//   2. 成员账户余额为 0 → eth_estimateGas 会以「余额不足」失败 → **必须显式给 gasLimit**
//   3. 合约编译必须 london（FOUNDRY_PROFILE=consortium，避开 PUSH0）
// 与 B07 共用同一批本地验证者密钥（env/.env.local），验收口径见
// shared/consortium-network/docs/04 差异矩阵 §三（四条分支共用增量）。
const fs = require("fs");
const path = require("path");
const { ethers, JsonRpcProvider, Wallet, Contract, Network } = require("ethers");

const PROJECT = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(PROJECT, "..", "..");

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    const m = v.match(/^(.*?)\s+#/);
    if (m) v = m[1].trim();
    out[k] = v;
  }
  return out;
}

function cfg() {
  return {
    ...readEnvFile(path.join(PROJECT, "env", "consortium.env")),
    ...readEnvFile(path.join(PROJECT, "env", ".env.local")),
  };
}

function rpcUrl(port) {
  if (port) return `http://127.0.0.1:${port}`;
  return cfg().RPC_URL || "http://127.0.0.1:8551";
}

function provider(port) {
  const chainId = Number(cfg().CHAIN_ID || 19880601);
  return new JsonRpcProvider(rpcUrl(port), Network.from(chainId), { staticNetwork: true });
}

function wallet(keyName, port) {
  const pk = cfg()[keyName];
  if (!pk) throw new Error(`缺少私钥 ${keyName}（应放在 env/.env.local）`);
  return new Wallet(pk, provider(port));
}

function readJson(file) {
  // PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM → 统一剥掉
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

function abi(name) {
  return readJson(path.join(PROJECT, "abi", `${name}.json`));
}

function deployment() {
  return readJson(path.join(PROJECT, "deployments", "latest.json"));
}

function contract(name, signerOrProvider, port) {
  const dep = deployment();
  const addr = dep[name];
  if (!addr) throw new Error(`deployments/latest.json 缺 ${name} 字段`);
  const p = signerOrProvider && signerOrProvider.provider ? signerOrProvider : provider(port);
  return new Contract(addr, abi(name), p);
}

/** 零 gas 交易参数：显式 gasLimit 绕过余额估算；legacy 交易 */
function txOpts(extra) {
  return {
    gasLimit: Number(cfg().PER_TX_GAS_LIMIT || 8000000),
    gasPrice: 0n,
    type: 0,
    ...(extra || {}),
  };
}

async function send(contractInstance, method, args, extra) {
  const tx = await contractInstance[method](...args, txOpts(extra));
  const rec = await tx.wait();
  return { tx, rec };
}

let failures = 0;
function ok(cond, msg) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${msg}`);
  return !!cond;
}
function summary(title) {
  console.log(`\n${title}: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
  return failures === 0;
}
function hr(t) {
  console.log(`\n=== ${t} ===`);
}

module.exports = {
  PROJECT,
  REPO,
  cfg,
  rpcUrl,
  provider,
  wallet,
  readJson,
  abi,
  deployment,
  contract,
  txOpts,
  send,
  ok,
  summary,
  hr,
  ethers,
};
