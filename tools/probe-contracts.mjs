// tools/probe-contracts.mjs —— 探测 B07/B08 部署记录里的合约是否还在链上（eth_getCode）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8551";

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const bn = await rpc("eth_blockNumber");
const id = await rpc("eth_chainId");
console.log(`chain head=${parseInt(bn, 16)} chainId=${parseInt(id, 16)}`);
for (const [name, file] of [
  ["B07", "B07-NFT市场联盟网/deployments/latest.json"],
  ["B08", "B08-合约工程化联盟网/deployments/latest.json"],
]) {
  const f = path.join(ROOT, "projects", file);
  if (!fs.existsSync(f)) {
    console.log(`${name}: 缺 ${file}`);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
  console.log(`--- ${name} ---`);
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    const code = await rpc("eth_getCode", [v, "latest"]);
    console.log(`  ${k.padEnd(14)} ${v} code=${code === "0x" ? "EMPTY" : (code.length - 2) / 2 + "B"}`);
  }
}
