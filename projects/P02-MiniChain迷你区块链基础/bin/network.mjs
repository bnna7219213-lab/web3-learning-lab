// 起一张 3 节点的本地链，供面板与手工实验使用。
// 用法：node bin/network.mjs [出块间隔ms]
// 身份持久化在 bin/.network.json（已 gitignore）：重启后验证人地址不变，轮值表才不会乱。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWallet, exportPrivateKey, importPrivateKey } from "../src/crypto.js";
import { createNode } from "../src/node.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, ".network.json");
const intervalMs = Number(process.argv[2] || 1500);
const ports = [5301, 5302, 5303];

async function loadOrCreateIdentities() {
  if (existsSync(STATE)) {
    const saved = JSON.parse(readFileSync(STATE, "utf8"));
    return { wallets: await Promise.all(saved.identities.map(importPrivateKey)), funder: await importPrivateKey(saved.funder) };
  }
  const funderWallet = await generateWallet();
  const identities = [];
  for (let i = 0; i < ports.length; i++) identities.push(await exportPrivateKey(await generateWallet()));
  writeFileSync(STATE, JSON.stringify({ identities, funder: await exportPrivateKey(funderWallet) }, null, 2), { mode: 0o600 });
  return { wallets: await Promise.all(identities.map(importPrivateKey)), funder: await importPrivateKey(await exportPrivateKey(funderWallet)) };
}

const { wallets, funder } = await loadOrCreateIdentities();
const validatorSet = wallets.map((w) => w.address);
const peers = ports.map((p) => `http://127.0.0.1:${p}`);

const nodes = [];
for (let i = 0; i < ports.length; i++) {
  nodes.push(
    await createNode({
      port: ports[i],
      name: `validator-${i + 1}`,
      peers: peers.filter((_, j) => j !== i),
      consensus: "pos",
      validatorSet,
      wallet: wallets[i],
      allocations: [{ address: funder.address, balance: 1_000_000 }],
      intervalMs,
    })
  );
}

console.log(`\n本地链已启动（PoS 轮值，出块间隔 ${intervalMs}ms）`);
console.log(`  验证人：\n${validatorSet.map((a, i) => `    #${i + 1} ${a}`).join("\n")}`);
console.log(`  初始账户：${funder.address}（1,000,000）`);
console.log(`  API：`);
for (const node of nodes) console.log(`    ${node.url}/status · /chain · /mempool · /balance?addr= · POST /tx · /mine · /sync`);
console.log(`  面板：node tools/serve.mjs → http://127.0.0.1:8787/projects/P02-MiniChain迷你区块链基础/frontend/\n`);
console.log("Ctrl+C 停止。");

process.on("SIGINT", async () => {
  console.log("\n正在关闭节点…");
  await Promise.all(nodes.map((n) => n.stop()));
  process.exit(0);
});
