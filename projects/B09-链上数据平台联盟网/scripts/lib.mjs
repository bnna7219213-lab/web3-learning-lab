// B09 验收公共层（联盟网版）：RPC + 多节点终结性核对 + 成员账户（读 B07 env/.env.local）+ 断言。
// 与 P09 的差异：没有 anvil 快照/回退（联盟链不做人为分叉）→ 回滚重放改用「注入式」测试；
// 成员私钥只从 env/.env.local 读（gitignore 覆盖），仓库零私钥。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RPC = process.env.RPC || "http://127.0.0.1:8551";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 19880601);
// QBFT 4 验证者：终结性断言要跨 3 个节点比同一块哈希
export const RPCS = (process.env.RPCS || "http://127.0.0.1:8551,http://127.0.0.1:8552,http://127.0.0.1:8553").split(",");

export async function rpc(method, params = [], url = RPC) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function head(url = RPC) {
  return Number(await rpc("eth_blockNumber", [], url));
}

/** 同一高度在多个节点上的块哈希（终结性断言用） */
export async function blockHashes(number, urls = RPCS) {
  const out = [];
  for (const u of urls) {
    const b = await rpc("eth_getBlockByNumber", ["0x" + number.toString(16), false], u);
    out.push({ url: u, hash: b ? b.hash : null });
  }
  return out;
}

export function loadDeployment() {
  const f = path.resolve(ROOT, "..", "B07-NFT市场联盟网", "deployments", "latest.json");
  if (!fs.existsSync(f)) throw new Error(`缺部署记录 ${f}：先在 B07 部署 LabCredential + LabFaucet`);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
}

export function loadAbi(name) {
  const f = path.resolve(ROOT, "..", "B07-NFT市场联盟网", "abi", `${name}.json`);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
}

export function cfg() {
  const f = path.resolve(ROOT, "..", "B07-NFT市场联盟网", "env", ".env.local");
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    // 注意行内注释：env/.env.local 的值后面常跟 "# 0x地址" —— 不剥掉会被当成私钥的一部分
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).split("#")[0].trim();
  }
  return out;
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

