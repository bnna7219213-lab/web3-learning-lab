// node demos/hash-chain.mjs —— 哈希链三种攻击路径的检出结果（对应前端 Demo 2）
import { buildChain, auditChain, rewriteChain, anchor, verifyAnchor } from "../frontend/lib/hashchain.js";

const honest = [
  { timestamp: "2026-10-13 09:00:00", data: "出库装车：冷机设定 -18℃" },
  { timestamp: "2026-10-13 09:05:00", data: "device-01 冷链 温度 22.9℃（批次 B121）" },
  { timestamp: "2026-10-13 09:10:00", data: "device-01 冷链 温度 25.3℃（批次 B121）" },
  { timestamp: "2026-10-13 09:15:00", data: "到仓验收：按台账判定" },
];

const chain = await buildChain(honest);
const honestAnchor = await anchor(chain);
const forged = "device-01 冷链 温度 18.0℃（批次 B121）";

console.log("① 诚实台账");
console.log(`   审计：${JSON.stringify(await auditChain(chain).then((a) => ({ valid: a.valid, brokenAt: a.brokenAt })))}`);

const tampered = chain.map((b, i) => (i === 1 ? { ...b, data: forged } : b));
const audit2 = await auditChain(tampered);
console.log("② 只改数据不重算");
console.log(`   审计：valid=${audit2.valid} brokenAt=${audit2.brokenAt} → 本地即可检出`);

const rewritten = await rewriteChain(chain, 1, forged);
const audit3 = await auditChain(rewritten);
const anchored = await verifyAnchor(rewritten, honestAnchor);
console.log("③ 改完整段重算");
console.log(`   本地审计：valid=${audit3.valid}（被骗过）｜ 外部锚点一致：${anchored}（识破）`);

if (audit2.valid || !audit3.valid || anchored) {
  console.error("\n异常：检出结果与预期不符");
  process.exit(1);
}
console.log("\n结论：证据必须锚定到自己控制不了的地方（公链 root / 公证 / 监管台账）。");
