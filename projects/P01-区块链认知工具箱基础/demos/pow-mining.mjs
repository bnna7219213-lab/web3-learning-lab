// node demos/pow-mining.mjs —— 难度与成本曲线（对应前端 Demo 5）
import { mineBlock, meetsTarget, expectedAttempts, preimage } from "../frontend/lib/pow.js";
import { sha256Hex } from "../frontend/lib/crypto.js";

const data = "device-01 冷链批次 B121 结算 12,800 元";
console.log(`区块内容：${data}\n`);
console.log("难度  期望尝试      实际尝试      耗时(ms)   hash/ms   nonce");

const results = [];
for (const difficulty of [1, 2, 3, 4]) {
  const mined = await mineBlock({ index: 0, difficulty, data });
  results.push(mined);
  console.log(
    String(difficulty).padEnd(6) +
      expectedAttempts(difficulty).toLocaleString().padEnd(14) +
      String(mined.attempts).padEnd(14) +
      String(mined.ms).padEnd(11) +
      (mined.attempts / Math.max(mined.ms, 1)).toFixed(1).padEnd(10) +
      mined.nonce
  );
}

const last = results.at(-1);
const recomputed = await sha256Hex(preimage(0, last.difficulty, "0".repeat(64), data, last.nonce));
console.log(`\n复验（第三方只需一次哈希）：${recomputed === last.hash && meetsTarget(recomputed, last.difficulty) ? "通过" : "失败"}`);
console.log(`改一个字再复验：${(await sha256Hex(preimage(0, last.difficulty, "0".repeat(64), data + "9", last.nonce))) === last.hash ? "被骗（不可能）" : "立刻不一致"}`);

if (results.some((r) => r.nonce < 0)) process.exit(1);
console.log("\n结论：挖矿是「一次昂贵搜索 + 一次廉价复验」，这就是共识让写账本变贵的机制。");
