// 验收脚本公共层：RPC（原生 fetch，无依赖）+ anvil 控制（快照/回退）+ 断言。
// 「零私钥」口径与 P07 演示钱包一致：交易走 anvil 解锁账户 eth_sendTransaction，仓库不放任何私钥。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RPC = process.env.RPC || "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);

export async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function accounts() {
  return rpc("eth_accounts");
}

/** 用解锁账户发交易（不碰私钥） */
export async function sendTx(from, to, data) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data }]);
  for (let i = 0; i < 60; i++) {
    const rec = await rpc("eth_getTransactionReceipt", [hash]);
    if (rec) return { hash, rec, ok: rec.status === "0x1" };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`交易 ${hash} 超时未入块`);
}

export async function head() {
  return Number(await rpc("eth_blockNumber"));
}

export async function snapshot() {
  return rpc("evm_snapshot", []);
}
export async function revert(id) {
  return rpc("evm_revert", [id]);
}

export function loadDeployment() {
  const f = path.resolve(ROOT, "..", "P07-NFT市场进阶", "deployments", String(CHAIN_ID), "P07.json");
  if (!fs.existsSync(f)) throw new Error(`缺部署记录 ${f}：先在 P07 跑 bash script/deploy.sh anvil`);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
}

export function loadAbi(name) {
  const f = path.resolve(ROOT, "..", "P07-NFT市场进阶", "abi", `${name}.json`);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
}

let passed = 0;
let failed = 0;
export function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${msg}`);
  }
  return !!cond;
}
export function hr(t) {
  console.log(`\n=== ${t} ===\n`);
}
export function summary(name) {
  console.log(`\n${name}: ${failed === 0 ? "ALL PASS" : `FAILED (${failed})`}  (pass=${passed} fail=${failed})`);
  if (failed) process.exit(1);
}

