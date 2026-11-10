// P02 验收实验：一条命令跑完 README「验收」里的四条，并打印可抄进文档的实测数字。
// 用法：node bin/experiments.mjs
import { generateWallet, exportPrivateKey, importPrivateKey } from "../src/crypto.js";
import { createTx } from "../src/tx.js";
import { createNode } from "../src/node.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 5500;
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` ｜ ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function waitFor(label, predicate, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(80);
  }
  check(label, false, `等待超时 ${timeout}ms`);
  return null;
}

async function identities(n) {
  const saved = [];
  for (let i = 0; i < n; i++) saved.push(await exportPrivateKey(await generateWallet()));
  return Promise.all(saved.map(importPrivateKey));
}

async function network({ count, consensus, difficulty = 1, intervalMs = 200, allocations, basePort, validatorSet }) {
  const wallets = await identities(count);
  const ports = Array.from({ length: count }, (_, i) => basePort + i);
  const peers = ports.map((p) => `http://127.0.0.1:${p}`);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      await createNode({
        port: ports[i],
        name: `${consensus}-${ports[i]}`,
        peers: peers.filter((_, j) => j !== i),
        consensus,
        difficulty,
        validatorSet: validatorSet ?? wallets.map((w) => w.address),
        wallet: wallets[i],
        allocations,
        intervalMs,
        quiet: true,
      })
    );
  }
  return { nodes, wallets, ports };
}

// ─────────────────────────────────────────────────────────
console.log("\n实验 1 · 三节点 PoS 轮值出块并收敛到同一账本");
{
  const funder = await generateWallet();
  const bob = await generateWallet();
  const { nodes, wallets } = await network({
    count: 3,
    consensus: "pos",
    basePort: BASE,
    allocations: [{ address: funder.address, balance: 10_000 }],
  });
  try {
    const tx = await createTx({ wallet: funder, to: bob.address, value: 250, fee: 5, nonce: 0 });
    check("交易提交被接受", (await nodes[0].submitTx(tx)).accepted === true);

    const heights = await waitFor("三节点高度 ≥ 3 且链尖唯一", async () => {
      const statuses = await Promise.all(nodes.map((n) => n.status()));
      return statuses.every((s) => s.height >= 3) && new Set(statuses.map((s) => s.tip)).size === 1
        ? statuses.map((s) => s.height)
        : null;
    });
    if (heights) check("收敛", true, `高度 ${heights.join("/")}，全网同一链尖`);

    const statuses = await Promise.all(nodes.map((n) => n.status()));
    check("三节点账本一致", statuses.every((s) => s.balances[bob.address]?.balance === 250), `bob=250 于 ${statuses.length} 个节点`);
    const chain = await nodes[0].fetchChain();
    const proposers = [...new Set(chain.slice(1).map((b) => b.proposer))];
    check("轮值出现多个出块人", proposers.length >= 2, `${proposers.length} 个出块人轮转`);
    check("手续费进入出块人账户", statuses.some((s) => s.balances[wallets[1].address]?.balance > 0));
  } finally {
    await Promise.all(nodes.map((n) => n.stop()));
  }
}

// ─────────────────────────────────────────────────────────
console.log("\n实验 2 · 杀掉一个节点，其余继续出块；重启后启动追赶");
{
  const funder = await generateWallet();
  const bob = await generateWallet();
  const config = { consensus: "pow", difficulty: 1, basePort: BASE + 10, allocations: [{ address: funder.address, balance: 5000 }] };
  const { nodes, wallets } = await network({ count: 2, ...config });
  const [survivor, victim] = nodes;
  try {
    await waitFor("两节点先共同出块到高度 ≥ 2", async () => (await survivor.status()).height >= 2);
    await victim.stop();
    console.log("    （已关闭 victim 节点）");

    const tx = await createTx({ wallet: funder, to: bob.address, value: 42, fee: 1, nonce: 0 });
    check("存活节点接受交易", (await survivor.submitTx(tx)).accepted === true);
    const height = await waitFor("存活节点把交易打包上链", async () => {
      const s = await survivor.status();
      return s.balances[bob.address]?.balance === 42 ? s.height : null;
    });
    if (height) check("离线期间链继续增长", true, `高度 ${height}`);

    const revived = await createNode({
      port: config.basePort + 1,
      name: "pow-revived",
      peers: [`http://127.0.0.1:${config.basePort}`],
      consensus: "pow",
      difficulty: 1,
      validatorSet: wallets.map((w) => w.address),
      wallet: wallets[1],
      allocations: config.allocations,
      intervalMs: 100_000,
      quiet: true,
    });
    try {
      const status = await revived.status();
      check("重启节点追赶上链尖", Math.abs(status.height - height) <= 2, `重启高度 ${status.height} vs 存活 ${height}`);
      check("追赶后账本一致", status.balances[bob.address]?.balance === 42, "bob=42");
    } finally {
      await revived.stop();
    }
  } finally {
    await survivor.stop().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────
console.log("\n实验 3 · 人为分叉：更重的链胜出，已确认交易被回滚（双花防护）");
{
  const [wA, wB] = await identities(2);
  const funder = await generateWallet();
  const first = await generateWallet();
  const second = await generateWallet();
  const allocations = [{ address: funder.address, balance: 1000 }];
  // peers 互不相连 = 网络分区
  const A = await createNode({ port: BASE + 20, consensus: "pow", difficulty: 1, validatorSet: [wA.address], wallet: wA, allocations, intervalMs: 100_000, quiet: true });
  const B = await createNode({ port: BASE + 21, consensus: "pow", difficulty: 1, validatorSet: [wA.address], wallet: wB, allocations, intervalMs: 100_000, quiet: true });

  try {
    const txFirst = await createTx({ wallet: funder, to: first.address, value: 300, fee: 1, nonce: 0 });
    const txSecond = await createTx({ wallet: funder, to: second.address, value: 700, fee: 1, nonce: 0 });
    await A.submitTx(txFirst);
    await B.submitTx(txSecond);
    await A.mine({ broadcast: false });
    await B.mine({ broadcast: false });

    const [chainA, chainB] = await Promise.all([A.fetchChain(), B.fetchChain()]);
    check("真的分叉了（同一高度不同块）", chainA.at(-1).hash !== chainB.at(-1).hash && chainA.length === chainB.length);
    check("等重时不切换（防抖动）", (await A.syncFrom(chainB)).adopted === false);

    await B.mine({ broadcast: false });
    const adopted = await A.syncFrom(await B.fetchChain());
    check("A 切换到更重链", adopted.adopted === true, adopted.reason);

    const statusA = await A.status();
    check("被回滚的交易未入账", (statusA.balances[first.address]?.balance ?? 0) === 0, "first=0");
    check("胜出分支的交易已入账", statusA.balances[second.address]?.balance === 700, "second=700");
    check("重组计数", statusA.stats.reorgs === 1, `reorgs=${statusA.stats.reorgs}`);
    check("失败交易回到交易池等待重排", statusA.mempool >= 1, `mempool=${statusA.mempool}`);

    await A.mine({ broadcast: false });
    const after = await A.status();
    check("重排后双花仍然失败（nonce 已用）", (after.balances[first.address]?.balance ?? 0) === 0);
  } finally {
    await Promise.all([A.stop(), B.stop()]);
  }
}

// ─────────────────────────────────────────────────────────
console.log("\n实验 4 · 非法交易一律被拒");
{
  const [wallet] = await identities(1);
  const funder = await generateWallet();
  const bob = await generateWallet();
  const node = await createNode({
    port: BASE + 30,
    consensus: "pos",
    validatorSet: [wallet.address],
    wallet,
    allocations: [{ address: funder.address, balance: 100 }],
    intervalMs: 100_000,
    quiet: true,
  });
  const reject = async (label, tx) => {
    const res = await fetch(`${node.url}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
    check(label, res.status === 400, `HTTP ${res.status} ${(await res.json()).reason ?? ""}`);
  };
  try {
    const good = await createTx({ wallet: funder, to: bob.address, value: 10, fee: 1, nonce: 0 });
    await reject("篡改金额", { ...good, value: 99 });
    await reject("篡改收款人", { ...good, to: wallet.address });
    await reject("冒名 from", { ...good, from: bob.address });
    await reject("非整数 nonce", { ...good, nonce: 1.5 });
    await reject("负数金额", { ...good, value: -5 });
    check("合法交易被接受", (await node.submitTx(good)).accepted === true);
    await reject("重放同一 nonce", { ...good });
  } finally {
    await node.stop();
  }
}

console.log(`\n实验结束：${failures === 0 ? "全部通过" : `${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
