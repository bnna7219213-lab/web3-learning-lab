// Transfer 事件表导出：eth_getLogs → data/transfers.json + transfers.csv（零依赖）。
// 用法：RPC=http://127.0.0.1:8545 TOKEN=0x… node scripts/export-transfers.mjs
// 缺省 TOKEN 读 deployments/latest.json。data/ 已被 .gitignore 排除（运行时产物）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let token = process.env.TOKEN;
if (!token) token = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/latest.json"), "utf8")).address;

const head = Number(await rpc("eth_blockNumber"));
const logs = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: "0x0", toBlock: "latest" }]);

const rows = logs.map((l) => {
  const from = "0x" + l.topics[1].slice(26);
  const to = "0x" + l.topics[2].slice(26);
  const value = BigInt(l.data).toString();
  const kind = from === "0x" + "0".repeat(40) ? "mint" : to === "0x" + "0".repeat(40) ? "burn" : "transfer";
  return { block: Number(l.blockNumber), txHash: l.transactionHash, logIndex: Number(l.logIndex), from, to, value, kind };
});

const dir = path.join(ROOT, "data");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "transfers.json"), JSON.stringify({ token, rpc: RPC, chainHead: head, count: rows.length, rows }, null, 2));
const csv = ["block,txHash,logIndex,from,to,value,kind", ...rows.map((r) => [r.block, r.txHash, r.logIndex, r.from, r.to, r.value, r.kind].join(","))].join("\n");
fs.writeFileSync(path.join(dir, "transfers.csv"), csv + "\n");
console.log(`✓ ${rows.length} 条 Transfer → data/transfers.json / transfers.csv（链头 #${head}）`);