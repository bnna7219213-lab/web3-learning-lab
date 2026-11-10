import test from "node:test";
import assert from "node:assert/strict";
import { generateWallet } from "../src/crypto.js";
import { createTx } from "../src/tx.js";
import { merkleRoot, createBlock, createGenesis, sealBlock, validateBlock, computeBlockHash, meetsTarget, proposerFor } from "../src/block.js";

const two = async () => [await generateWallet(), await generateWallet()];

test("Merkle root：空批次为 null，同输入同根，改一笔即变根", async () => {
  assert.equal(await merkleRoot([]), null);
  const a = await merkleRoot(["t1", "t2", "t3"]);
  assert.equal(a, await merkleRoot(["t1", "t2", "t3"]));
  assert.notEqual(a, await merkleRoot(["t1", "t2", "tX"]));
  assert.equal(a.length, 64);
});

test("区块自洽：hash 由内容决定，改交易列表后 hash 必须不同", async () => {
  const [alice, bob] = await two();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 5, fee: 1, nonce: 0 });
  const block = await createBlock({ index: 1, prevHash: "0".repeat(64), txs: [tx], proposer: bob.address });
  block.hash = await computeBlockHash(block);
  assert.equal((await validateBlock(block)).ok, true);

  const tampered = { ...block, txs: [{ ...tx, value: 500 }] };
  assert.equal((await validateBlock(tampered)).ok, false);
});

test("偷偷换掉一笔交易（沿用旧 txIds）也会被重算抓住", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const carol = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 5, fee: 1, nonce: 0 });
  const block = await createBlock({ index: 1, prevHash: "0".repeat(64), txs: [tx], proposer: bob.address });
  block.hash = await computeBlockHash(block);

  const swapped = { ...block, txs: [await createTx({ wallet: alice, to: carol.address, value: 5, fee: 1, nonce: 0 })] };
  const result = await validateBlock(swapped);
  assert.equal(result.ok, false);
  assert.match(result.reason, /txIds|merkleRoot|hash/);
});

test("PoW：难度 2 的区块前导零达标，且能验证不达标块", async () => {
  const [miner] = await two();
  const sealed = await sealBlock({
    index: 1,
    prevHash: "0".repeat(64),
    txs: [],
    proposer: miner.address,
    consensus: "pow",
    difficulty: 2,
  });
  assert.ok(sealed && sealed.attempts >= 1);
  assert.equal(meetsTarget(sealed.hash, 2), true);
  assert.equal((await validateBlock(sealed)).ok, true);

  const lazy = { ...sealed, difficulty: 9 };
  assert.equal((await validateBlock(lazy)).ok, false);
});

test("PoS：不是轮值人出块直接被拒，轮值人自己出块通过", async () => {
  const [a, b] = await two();
  const validators = [a.address, b.address];
  const wrongTurn = await sealBlock(
    { index: 0, prevHash: "0".repeat(64), txs: [], proposer: b.address, consensus: "pos" },
    { validatorSet: validators }
  );
  assert.equal(wrongTurn, null, "第 0 块应轮到 a，b 出块必须返回 null");

  const rightTurn = await sealBlock(
    { index: 0, prevHash: "0".repeat(64), txs: [], proposer: a.address, consensus: "pos" },
    { validatorSet: validators }
  );
  assert.equal((await validateBlock(rightTurn, { validatorSet: validators })).ok, true);
  assert.equal(proposerFor(validators, 1), b.address);
});

test("创世块余额表进哈希：改初始有钱人会被发现", async () => {
  const [rich, poor] = await two();
  const genesis = await createGenesis(rich.address, "pow", 1, [{ address: rich.address, balance: 1000 }]);
  assert.equal((await validateBlock(genesis)).ok, true);

  const forged = await createGenesis(rich.address, "pow", 1, [{ address: poor.address, balance: 1000 }]);
  assert.notEqual(forged.hash, genesis.hash);

  const inflated = { ...genesis, allocations: [{ address: rich.address, balance: 999999 }] };
  assert.equal((await validateBlock(inflated)).ok, false);
});
