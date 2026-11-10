import test from "node:test";
import assert from "node:assert/strict";
import { generateWallet } from "../src/crypto.js";
import { createTx } from "../src/tx.js";
import { createGenesis, sealBlock } from "../src/block.js";
import { replayChain, findForkPoint, planAdoption, chainWeight, confirmations, blockWeight } from "../src/chain.js";

async function build({ difficulty = 1, proposer, genesis, batches }) {
  const chain = [genesis];
  for (const txs of batches) {
    const prev = chain.at(-1);
    const block = await sealBlock({
      index: chain.length,
      prevHash: prev.hash,
      txs,
      proposer,
      consensus: "pow",
      difficulty,
    });
    assert.ok(block, "出块失败");
    chain.push(block);
  }
  return chain;
}

test("重放三条区块：账本与逐笔转账一致", async () => {
  const [alice, bob, carol] = [await generateWallet(), await generateWallet(), await generateWallet()];
  const genesis = await createGenesis(alice.address, "pow", 1, [{ address: alice.address, balance: 1000 }]);
  const chain = await build({
    proposer: bob.address,
    genesis,
    batches: [
      [await createTx({ wallet: alice, to: bob.address, value: 200, fee: 10, nonce: 0 })],
      [await createTx({ wallet: bob, to: carol.address, value: 50, fee: 1, nonce: 0 })],
      [],
    ],
  });

  const replay = await replayChain(chain);
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.state.accounts[alice.address].balance, 790); // 1000 - 200 - 10
  // bob：收 200 + 两块的手续费 10 与 1（他自己就是出块人）- 转出 50 - 自己那笔的费 1
  assert.equal(replay.state.accounts[bob.address].balance, 160);
  assert.equal(replay.state.accounts[carol.address].balance, 50);
});

test("断链：改掉中间某块的 prevHash 会被拒", async () => {
  const [a, b] = [await generateWallet(), await generateWallet()];
  const genesis = await createGenesis(a.address, "pow", 1, [{ address: a.address, balance: 10 }]);
  const chain = await build({ proposer: b.address, genesis, batches: [[], []] });
  chain[2] = { ...chain[2], prevHash: "f".repeat(64) };
  const replay = await replayChain(chain);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /prevHash/);
});

test("区块内塞入无效交易（余额不够）整块作废", async () => {
  const [a, b, c] = [await generateWallet(), await generateWallet(), await generateWallet()];
  const genesis = await createGenesis(a.address, "pow", 1, [{ address: a.address, balance: 100 }]);
  const greedy = await createTx({ wallet: a, to: c.address, value: 1000, fee: 1, nonce: 0 });
  const chain = await build({ proposer: b.address, genesis, batches: [[greedy]] });
  const replay = await replayChain(chain);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /余额不足/);
});

test("分叉点定位与权重比较：更重的才切，等重不切", async () => {
  const [a, b, c] = [await generateWallet(), await generateWallet(), await generateWallet()];
  const genesis = await createGenesis(a.address, "pow", 1, [{ address: a.address, balance: 500 }]);
  const shared = await build({ proposer: b.address, genesis, batches: [[], []] });
  const local = structuredClone(shared);
  const remote = structuredClone(shared);

  // 两条分支必须内容不同，否则挖出来是同一个块，谈不上分叉
  local.push(
    await sealBlock({
      index: local.length,
      prevHash: local.at(-1).hash,
      txs: [await createTx({ wallet: a, to: b.address, value: 10, fee: 1, nonce: 0 })],
      proposer: b.address,
      consensus: "pow",
      difficulty: 1,
    })
  );
  remote.push(
    await sealBlock({
      index: remote.length,
      prevHash: remote.at(-1).hash,
      txs: [await createTx({ wallet: a, to: c.address, value: 10, fee: 1, nonce: 0 })],
      proposer: c.address,
      consensus: "pow",
      difficulty: 1,
    })
  );

  assert.notEqual(local.at(-1).hash, remote.at(-1).hash, "两个分支块应不同");
  assert.equal(findForkPoint(local, remote), 2, "共同祖先应是第 2 块（共享链的最后一块）");
  assert.equal(planAdoption(local, remote).adopt, false, "等重链不应切换（避免来回抖动）");

  // 对方在分叉后多挖一块，并且难度更高 → 更重
  const heavy = structuredClone(remote);
  heavy.push(await sealBlock({ index: heavy.length, prevHash: heavy.at(-1).hash, txs: [], proposer: c.address, consensus: "pow", difficulty: 3 }));
  assert.ok(chainWeight(heavy) > chainWeight(local));
  const plan = planAdoption(local, heavy);
  assert.equal(plan.adopt, true);
  assert.equal(plan.forkAt, 2);
  assert.equal(blockWeight(heavy.at(-1)), 8);
});

test("重组：被丢弃区块里的交易回到待打包区（回滚的确切含义）", async () => {
  const [funder, minerA, minerB, receiver] = [
    await generateWallet(),
    await generateWallet(),
    await generateWallet(),
    await generateWallet(),
  ];
  const genesis = await createGenesis(funder.address, "pow", 1, [{ address: funder.address, balance: 1000 }]);
  const base = await build({ proposer: minerA.address, genesis, batches: [[]] });

  const txA = await createTx({ wallet: funder, to: receiver.address, value: 100, fee: 1, nonce: 0 });
  const local = [...base, await sealBlock({ index: 2, prevHash: base.at(-1).hash, txs: [txA], proposer: minerA.address, consensus: "pow", difficulty: 1 })];

  const txB = await createTx({ wallet: funder, to: minerB.address, value: 700, fee: 1, nonce: 0 });
  let remote = [...base, await sealBlock({ index: 2, prevHash: base.at(-1).hash, txs: [txB], proposer: minerB.address, consensus: "pow", difficulty: 1 })];
  remote = [...remote, await sealBlock({ index: 3, prevHash: remote.at(-1).hash, txs: [], proposer: minerA.address, consensus: "pow", difficulty: 1 })];

  const plan = planAdoption(local, remote);
  assert.equal(plan.adopt, true);
  assert.deepEqual(plan.orphanedTxs.map((t) => t.to), [receiver.address], "A 链那笔 100 应回炉");

  const replay = await replayChain(remote);
  assert.equal(replay.ok, true);
  assert.equal(replay.state.accounts[receiver.address]?.balance ?? 0, 0, "回滚后收款人不应拿到钱");
  assert.equal(confirmations(remote, base[1].hash), 2);
});

test("PoS 链重放：轮值错乱的块被拒", async () => {
  const [v1, v2] = [await generateWallet(), await generateWallet()];
  const validators = [v1.address, v2.address];
  const genesis = await createGenesis(v1.address, "pos", 0, [{ address: v1.address, balance: 5 }]);
  const ok2 = await sealBlock({ index: 1, prevHash: genesis.hash, txs: [], proposer: v2.address, consensus: "pos" }, { validatorSet: validators });
  const chain = [genesis, ok2];
  assert.equal((await replayChain(chain, { validators })).ok, true);

  const wrongTurn = await sealBlock({ index: 2, prevHash: ok2.hash, txs: [], proposer: v2.address, consensus: "pos" }, { validatorSet: validators });
  assert.equal(wrongTurn, null, "第 2 块应轮到 v1");
});
