import test from "node:test";
import assert from "node:assert/strict";
import { mineBlock, meetsTarget, expectedAttempts, preimage } from "../frontend/lib/pow.js";
import { sha256Hex } from "../frontend/lib/crypto.js";

test("挖出满足难度的区块，且任何人可一次哈希复验", async () => {
  const mined = await mineBlock({ index: 0, difficulty: 2, data: "device-01 冷链批次 B12" });
  assert.ok(mined.nonce >= 0);
  assert.equal(meetsTarget(mined.hash, 2), true);
  assert.equal(await sha256Hex(preimage(0, 2, "0".repeat(64), "device-01 冷链批次 B12", mined.nonce)), mined.hash);
  assert.ok(mined.attempts >= 1);
});

test("难度每 +1，期望尝试次数 ×16（不断言实际耗时，避免随机波动造成假失败）", async () => {
  assert.equal(expectedAttempts(1) * 16, expectedAttempts(2));
  assert.equal(expectedAttempts(2) * 16, expectedAttempts(3));

  const easy = await mineBlock({ index: 1, difficulty: 1, data: "x" });
  const hard = await mineBlock({ index: 1, difficulty: 3, data: "x" });
  assert.equal(meetsTarget(easy.hash, 1), true);
  assert.equal(meetsTarget(hard.hash, 3), true);
});

test("maxAttempts 限制：给 1 次机会几乎不可能达到难度 5", async () => {
  const failed = await mineBlock({ index: 2, difficulty: 5, data: "x", maxAttempts: 1 });
  assert.equal(failed.nonce, -1);
  assert.equal(failed.attempts, 1);
});
