import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { decodeLog } from "../indexer/abi.js";
import { openDb } from "../indexer/db.js";

const TOKEN = ethers.id("Transfer(address,address,uint256)");
const FROM = "0x" + "11".repeat(20);
const TO = "0x" + "22".repeat(20);
const topic = (a) => ethers.zeroPadValue(a, 32);
const base = {
  blockNumber: 1, blockHash: "0x" + "ab".repeat(32),
  txHash: "0x" + "cd".repeat(32), logIndex: 0,
  address: FROM, topic0: TOKEN, topics: [], data: "0x",
};
const erc20 = (hash = base.blockHash, index = 0) => ({
  ...base, blockHash: hash, logIndex: index,
  topics: [TOKEN, topic(FROM), topic(TO)], data: ethers.toBeHex(42, 32),
});
const erc721 = () => ({
  ...base, blockHash: "0x" + "ef".repeat(32), blockNumber: 2, logIndex: 1,
  topics: [TOKEN, topic(FROM), topic(TO), ethers.toBeHex(42, 32)], data: "0x",
});

test("同 topic0 的 ERC20 / ERC721 按索引布局解码", () => {
  const a = decodeLog(erc20());
  assert.equal(a.transferKind, "erc20");
  assert.equal(JSON.parse(a.decoded).value, "42");
  assert.equal(a.tokenId, null);
  const b = decodeLog(erc721());
  assert.equal(b.transferKind, "erc721");
  assert.equal(b.tokenId, "42");
  assert.equal(JSON.parse(b.decoded).tokenId, "42");
});

test("ERC20 余额独立重放，不污染 NFT 资产，回滚后重算", () => {
  const store = openDb(":memory:");
  store.insertBlock({ number: 1, hash: base.blockHash, parentHash: "0x" + "00".repeat(32), timestamp: 1 });
  const mint = { ...erc20(), logIndex: 0, topics: [TOKEN, topic(ethers.ZeroAddress), topic(FROM)], data: ethers.toBeHex(42, 32) };
  store.insertLog(decodeLog(mint));
  const b721 = decodeLog({ ...erc721(), topics: [TOKEN, topic(ethers.ZeroAddress), topic(TO), ethers.toBeHex(42, 32)] });
  const b20 = decodeLog({ ...erc20(b721.blockHash, 1), blockNumber: 2 });
  b721.logIndex = 2;
  store.insertBlock({ number: 2, hash: b721.blockHash, parentHash: base.blockHash, timestamp: 2 });
  store.insertLog(b20);
  store.insertLog(b721);
  store.rebuildAssets();
  assert.equal(store.q("SELECT balance FROM fungibleBalances WHERE address = ?").get(TO).balance, "42");
  assert.equal(store.q("SELECT COUNT(*) c FROM assets").get().c, 1);
  assert.equal(store.q("SELECT tokenId FROM assets").get().tokenId, "42");
  assert.equal(store.q("SELECT tokens FROM holders WHERE address = ?").get(TO).tokens, 1);
  store.rollbackTo(0);
  assert.equal(store.q("SELECT COUNT(*) c FROM fungibleBalances").get().c, 0);
  assert.equal(store.q("SELECT COUNT(*) c FROM transferKinds").get().c, 0);
});

test("回扫历史后 ERC20 余额不出现负数，并支持大额精确值", () => {
  const store = openDb(":memory:");
  const value = (1n << 200n) + 17n;
  const mint = { ...erc20(), topics: [TOKEN, topic(ethers.ZeroAddress), topic(FROM)], data: ethers.toBeHex(value, 32) };
  const transfer = { ...erc20("0x" + "ef".repeat(32), 1), data: ethers.toBeHex(value, 32) };
  store.insertLog(decodeLog(mint));
  store.insertLog(decodeLog(transfer));
  store.rebuildAssets();
  assert.equal(store.q("SELECT balance FROM fungibleBalances WHERE address = ?").get(TO).balance, value.toString());
  assert.equal(store.q("SELECT COUNT(*) c FROM fungibleBalances WHERE address = ?").get(FROM).c, 0);
});
