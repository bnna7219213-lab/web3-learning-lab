import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../frontend/lib/crypto.js";

test("SHA-256 标准测试向量（与 FIPS 180-4 一致）", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("输出定长 64 个十六进制位", async () => {
  assert.equal((await sha256Hex("一行很长的中文与任意长度的内容".repeat(50))).length, 64);
});

test("雪崩效应：改一个字符，半数以上比特翻转", async () => {
  const a = await sha256Hex("cold-chain|device-01|2026-10-13|18.6");
  const b = await sha256Hex("cold-chain|device-01|2026-10-13|18.7");
  let flipped = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    for (let bit = 0; bit < 4; bit++) if ((x >> bit) & 1) flipped++;
  }
  assert.ok(flipped > 100, `仅翻转 ${flipped}/256 比特，远低于雪崩预期`);
});
