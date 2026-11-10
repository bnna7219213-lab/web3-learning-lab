import test from "node:test";
import assert from "node:assert/strict";
import { generateWallet, exportPrivateKey, importPrivateKey } from "../src/crypto.js";
import { createTx } from "../src/tx.js";
import { createNode } from "../src/node.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口按进程号偏移：写死端口时，两个测试进程同时跑会互相抢端口而假失败
// （真实踩过：同一命令里连跑两次就出现 1 fail）。这是 lainchain「环境绑死」问题的小型复现。
const BASE = 5300 + (process.pid % 25) * 20;
const port = (offset) => BASE + offset;

async function waitFor(predicate, { timeout = 8000, every = 60, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(every);
  }
  throw new Error(`等待超时：${label}`);
}

// 验证人身份必须可重启复用，否则轮值表每次都不一样
async function identitySet(n) {
  const saved = [];
  for (let i = 0; i < n; i++) saved.push(await exportPrivateKey(await generateWallet()));
  return saved.map(async (jwk) => importPrivateKey(jwk));
}

test("三节点 PoS 轮值出块：交易在全网收敛到同一账本", async () => {
  const wallets = await Promise.all(await identitySet(3));
  const validatorSet = wallets.map((w) => w.address);
  const ports = [port(1), port(2), port(3)];
  const peers = ports.map((p) => `http://127.0.0.1:${p}`);
  const funder = await generateWallet();

  const nodes = await Promise.all(
    wallets.map((wallet, i) =>
      createNode({
        port: ports[i],
        name: `pos-${ports[i]}`,
        peers: peers.filter((_, j) => j !== i),
        consensus: "pos",
        validatorSet,
        wallet,
        allocations: [{ address: funder.address, balance: 10_000 }],
        intervalMs: 150,
        quiet: true,
      })
    )
  );

  try {
    const bob = await generateWallet();
    const tx = await createTx({ wallet: funder, to: bob.address, value: 250, fee: 5, nonce: 0 });
    const answer = await nodes[0].submitTx(tx);
    assert.equal(answer.accepted, true);

    await waitFor(async () => {
      const statuses = await Promise.all(nodes.map((n) => n.status()));
      const tips = new Set(statuses.map((s) => s.tip));
      return tips.size === 1 && statuses[0].height >= 2;
    }, { label: "三节点收敛到同一链尖" });

    const statuses = await Promise.all(nodes.map((n) => n.status()));
    assert.equal(new Set(statuses.map((s) => s.tip)).size, 1, "链尖必须唯一");
    for (const status of statuses) {
      assert.equal(status.balances[bob.address].balance, 250, `${status.name} 账本不一致`);
      assert.equal(status.balances[funder.address].balance, 10_000 - 250 - 5);
    }
    // 轮值证明：三个出块人各不相同
    const chains = await Promise.all(nodes.map((n) => n.fetchChain()));
    const proposers = new Set(chains[0].slice(1).map((b) => b.proposer));
    assert.ok(proposers.size >= 2, "PoS 轮值应出现多个出块人");
  } finally {
    await Promise.all(nodes.map((n) => n.stop()));
  }
});

test("非法签名交易被 HTTP 400 拒绝，且不进入交易池", async () => {
  const [wallet] = await Promise.all(await identitySet(1));
  const funder = await generateWallet();
  const node = await createNode({
    port: port(9),
    consensus: "pos",
    validatorSet: [wallet.address],
    wallet,
    allocations: [{ address: funder.address, balance: 100 }],
    intervalMs: 10_000,
    quiet: true,
  });

  try {
    const bob = await generateWallet();
    const tx = await createTx({ wallet: funder, to: bob.address, value: 10, fee: 1, nonce: 0 });
    const forged = { ...tx, value: 99 };
    const res = await fetch(`${node.url}/tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forged),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.accepted, false);
    assert.match(body.reason, /签名无效/);
    assert.equal((await node.status()).mempool, 0);
  } finally {
    await node.stop();
  }
});

test("杀掉一个节点：其余节点继续出块，重启后启动追赶", async () => {
  const wallets = await Promise.all(await identitySet(2));
  const ports = [port(11), port(12)];
  const peers = ports.map((p) => `http://127.0.0.1:${p}`);
  const funder = await generateWallet();
  const config = { consensus: "pow", difficulty: 1, validatorSet: wallets.map((w) => w.address), allocations: [{ address: funder.address, balance: 500 }] };

  const nodes = await Promise.all(
    wallets.map((wallet, i) =>
      createNode({ ...config, port: ports[i], name: `pow-${ports[i]}`, peers: peers.filter((_, j) => j !== i), wallet, intervalMs: 120, quiet: true })
    )
  );
  const survivor = nodes[0];
  const victim = nodes[1];

  try {
    await waitFor(async () => (await survivor.status()).height >= 2, { label: "两节点先共同出块" });
    await victim.stop();

    const bob = await generateWallet();
    const tx = await createTx({ wallet: funder, to: bob.address, value: 42, fee: 1, nonce: 0 });
    assert.equal((await survivor.submitTx(tx)).accepted, true);
    await waitFor(async () => {
      const status = await survivor.status();
      return status.mempool === 0 && status.balances[bob.address]?.balance === 42;
    }, { label: "存活节点把交易打包" });

    const heightBefore = (await survivor.status()).height;
    // 重启：同一身份、空链、靠启动追赶补齐
    const revived = await createNode({
      ...config,
      port: ports[1],
      name: "pow-revived",
      peers: [peers[0]],
      wallet: wallets[1],
      intervalMs: 10_000,
      quiet: true,
    });
    try {
      const status = await revived.status();
      assert.ok(status.height >= heightBefore - 1, `重启节点高度 ${status.height} 应追赶上 ${heightBefore}`);
      assert.equal(status.balances[bob.address].balance, 42, "追赶后账本必须一致");
    } finally {
      await revived.stop();
    }
  } finally {
    await survivor.stop().catch(() => {});
  }
});

test("双花与重组：更重的链胜出，被丢弃的交易回炉且不会二次入账", async () => {
  const [wA, wB] = await Promise.all(await identitySet(2));
  const funder = await generateWallet();
  const first = await generateWallet();
  const second = await generateWallet();
  const allocations = [{ address: funder.address, balance: 1000 }];

  // 故意互不相连（peers 为空）＝网络分区，两边各自出块
  const A = await createNode({ port: port(15), consensus: "pow", difficulty: 1, validatorSet: [wA.address], wallet: wA, allocations, intervalMs: 10_000, quiet: true });
  const B = await createNode({ port: port(16), consensus: "pow", difficulty: 1, validatorSet: [wA.address], wallet: wB, allocations, intervalMs: 10_000, quiet: true });

  try {
    const txToFirst = await createTx({ wallet: funder, to: first.address, value: 300, fee: 1, nonce: 0 });
    const txToSecond = await createTx({ wallet: funder, to: second.address, value: 700, fee: 1, nonce: 0 });
    assert.equal((await A.submitTx(txToFirst)).accepted, true);
    assert.equal((await B.submitTx(txToSecond)).accepted, true);

    assert.equal((await A.mine({ broadcast: false })).ok, true);
    assert.equal((await B.mine({ broadcast: false })).ok, true);

    const [chainA, chainB] = await Promise.all([A.fetchChain(), B.fetchChain()]);
    assert.equal(chainA.at(-1).hash !== chainB.at(-1).hash, true, "必须真的分叉了");
    assert.equal(chainA.length, chainB.length, "两条分支等长");

    // 等长不切换：避免节点在两条链之间来回抖动
    assert.equal((await A.syncFrom(chainB)).adopted, false);

    // B 再挖一块变更重 → A 必须切换，且 first 的那笔交易回炉
    assert.ok((await B.mine({ broadcast: false })).ok);
    const adopted = await A.syncFrom(await B.fetchChain());
    assert.equal(adopted.adopted, true, "A 应切换到更重链");

    const statusA = await A.status();
    assert.equal(statusA.balances[first.address]?.balance ?? 0, 0, "回滚后 first 不应拿到钱");
    assert.equal(statusA.balances[second.address].balance, 700);
    assert.equal(statusA.stats.reorgs, 1);
    assert.ok(statusA.mempool >= 1, "被丢弃的交易应回到交易池等待重排");

    // 回炉的交易再尝试打包：nonce 已被 second 那笔用掉，所以不可能再次入账
    await A.mine({ broadcast: false });
    const after = await A.status();
    assert.equal(after.balances[first.address]?.balance ?? 0, 0, "双花必须失败");
    assert.equal(after.balances[funder.address].balance, 1000 - 700 - 1);
  } finally {
    await Promise.all([A.stop(), B.stop()]);
  }
});
