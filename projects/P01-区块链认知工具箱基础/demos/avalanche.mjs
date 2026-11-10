// node demos/avalanche.mjs —— 哈希雪崩效应报告（与前端 Demo 1 同一套库）
import { sha256Hex, hexHamming } from "../frontend/lib/crypto.js";

const base = "device-01|2026-10-13T09:05:00Z|seq=42|temp=18.4C|batch=B121";
const rows = [];
for (let i = 0; i < base.length; i++) {
  const mutated = base.slice(0, i) + (base[i] === "X" ? "Y" : "X") + base.slice(i + 1);
  rows.push({ i, flipped: hexHamming(await sha256Hex(base), await sha256Hex(mutated)) });
}

const avg = rows.reduce((s, r) => s + r.flipped, 0) / rows.length;
const min = Math.min(...rows.map((r) => r.flipped));
const max = Math.max(...rows.map((r) => r.flipped));

console.log(`原文长度：${base.length} 字符，逐位翻转 ${rows.length} 次`);
console.log(`翻转比特：均值 ${avg.toFixed(1)} / 256（理想 ≈128），最小 ${min}，最大 ${max}`);
console.log(`\n诚实指纹：${await sha256Hex(base)}`);
console.log(`单字指纹：${await sha256Hex(base.slice(0, -1) + "D")}`);

if (avg < 100 || min < 60) {
  console.error("\n异常：存在翻转过少的改动位，不符合雪崩预期");
  process.exit(1);
}
console.log("\n结论：任何一处改写都会让指纹面目全非 → 存证只需保存指纹（M4）。");
