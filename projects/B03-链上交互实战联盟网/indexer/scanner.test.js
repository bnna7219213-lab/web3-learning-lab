// 回归：混合 ERC20/ERC721 日志、空 value 字段都不能阻断扫块与游标推进。
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const scanner = require("./scanner");
const cfg = require("./config");
const { extractTransfers } = require("./erc20");

const { ethers } = require("ethers");
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const topic = (a) => ethers.zeroPadValue(a, 32);

test("ERC721 的同名 Transfer 不进入 ERC20 流水", () => {
  const receipt = {
    transactionHash: "0x" + "ab".repeat(32), blockNumber: "0x1",
    logs: [
      { address: ADDRESS, topics: [TRANSFER, topic(ADDRESS), topic(OTHER), "0x2a"], data: "0x" },
      { address: ADDRESS, topics: [TRANSFER, topic(ADDRESS), topic(OTHER)], data: ethers.toBeHex(42, 32) },
    ],
  };
  const out = extractTransfers(receipt);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, "42");
});

test("scanBatch 在混合日志与空 value 下仍推进游标", async () => {
  const original = scanner._rpcCall;
  const originalBatch = cfg.BATCH;
  cfg.BATCH = 1;
  const originalTokenMeta = require("./erc20").fetchTokenMeta;
  require("./erc20").fetchTokenMeta = async () => { throw new Error("skip metadata in scanner regression"); };
  const d = db.open(":memory:");
  const tx = {
    hash: "0x" + "cd".repeat(32), from: ADDRESS, to: OTHER,
    gas: "0x5208", gasPrice: "0x0", input: "0x", nonce: "0x0", type: "0x0",
  };
  const block = {
    number: "0x0", hash: "0x" + "12".repeat(32), parentHash: "0x" + "00".repeat(32),
    timestamp: "0x1", gasUsed: "0x5208", transactions: [tx],
  };
  const receipt = {
    transactionHash: tx.hash, status: "0x1", gasUsed: "0x5208",
    logs: [{ address: ADDRESS, topics: [TRANSFER, topic(ADDRESS), topic(OTHER), "0x2a"], data: "0x" }],
  };
  scanner._rpcCall = async (method) => {
    if (method === "eth_blockNumber") return "0x0";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBlockReceipts") return [receipt];
    if (method === "eth_getCode") return "0x";
    if (method === "eth_call") return "0x"; // 元数据读取失败走既有容错，不影响游标
    throw new Error("unexpected RPC " + method);
  };
  try {
    const result = await scanner.scanBatch(d, {}, 0);
    assert.equal(result.done, 1);
    assert.equal(db.getMeta(d, "last_scanned"), "0");
    assert.equal(d.prepare("SELECT COUNT(*) c FROM txs").get().c, 1);
    assert.equal(d.prepare("SELECT COUNT(*) c FROM token_transfers").get().c, 0);
  } finally {
    scanner._rpcCall = original;
    cfg.BATCH = originalBatch;
    require("./erc20").fetchTokenMeta = originalTokenMeta;
    d.close();
  }
});
