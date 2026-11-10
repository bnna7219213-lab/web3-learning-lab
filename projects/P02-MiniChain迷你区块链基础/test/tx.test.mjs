import test from "node:test";
import assert from "node:assert/strict";
import { generateWallet, sign, verify } from "../src/crypto.js";
import { createTx, checkTx, applyTx, emptyState, txId, txPreimage } from "../src/tx.js";

const fund = async (state, address, balance) => {
  state.accounts[address] = { balance, nonce: 0 };
};

test("合法交易通过检查，且 txId 稳定", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  assert.equal((await checkTx(tx)).ok, true);
  assert.equal(await txId(tx), await txId({ ...tx }));
});

test("改金额即签名失效（中间人加价被拒）", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  assert.equal((await checkTx({ ...tx, value: 9999 })).ok, false);
  assert.match((await checkTx({ ...tx, value: 9999 })).reason, /签名无效/);
});

test("改收款人同样失效", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const carol = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  assert.equal((await checkTx({ ...tx, to: carol.address })).ok, false);
});

test("冒名：from 填别人的地址会被拒", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  const result = await checkTx({ ...tx, from: bob.address });
  assert.equal(result.ok, false);
  assert.match(result.reason, /from 与公钥不匹配/);
});

test("字段校验：负数、非整数、缺字段全部拒绝", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  assert.equal((await checkTx({ ...tx, value: -1 })).ok, false);
  assert.equal((await checkTx({ ...tx, nonce: 1.5 })).ok, false);
  assert.equal((await checkTx({ ...tx, sig: "" })).ok, false);
  assert.equal((await checkTx(null)).ok, false);
});

test("状态迁移：余额扣减、收款入账、手续费归出块人", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const proposer = await generateWallet();
  const state = emptyState();
  await fund(state, alice.address, 1000);

  const tx = await createTx({ wallet: alice, to: bob.address, value: 300, fee: 7, nonce: 0 });
  const result = applyTx(state, tx, proposer.address);
  assert.equal(result.ok, true);
  assert.equal(state.accounts[alice.address].balance, 1000 - 307);
  assert.equal(state.accounts[alice.address].nonce, 1);
  assert.equal(state.accounts[bob.address].balance, 300);
  assert.equal(state.accounts[proposer.address].balance, 7);
});

test("余额不足与超额转账被拒", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const state = emptyState();
  await fund(state, alice.address, 10);
  const tx = await createTx({ wallet: alice, to: bob.address, value: 999, fee: 1, nonce: 0 });
  const result = applyTx(state, tx, bob.address);
  assert.equal(result.ok, false);
  assert.match(result.reason, /余额不足/);
});

test("重放防御：同一 nonce 用第二次即失败", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const state = emptyState();
  await fund(state, alice.address, 1000);
  const tx = await createTx({ wallet: alice, to: bob.address, value: 100, fee: 1, nonce: 0 });
  assert.equal(applyTx(state, tx, bob.address).ok, true);
  const second = applyTx(state, tx, bob.address);
  assert.equal(second.ok, false);
  assert.match(second.reason, /nonce 期望 1，实际 0/);
});

test("签名域含协议版本：为 mini-v2 签的报文不能被当成 mini-v1 交易复用", async () => {
  const alice = await generateWallet();
  const bob = await generateWallet();
  const tx = await createTx({ wallet: alice, to: bob.address, value: 1, fee: 1, nonce: 0 });
  assert.ok(txPreimage(tx).startsWith("mini-v1|"));

  const v2 = txPreimage(tx).replace("mini-v1", "mini-v2");
  const sigForV2 = await sign(alice.privateKey, v2);
  assert.equal(await verify(alice.publicKeyHex, sigForV2, txPreimage(tx)), false);
  assert.equal(await verify(alice.publicKeyHex, sigForV2, v2), true);
});
