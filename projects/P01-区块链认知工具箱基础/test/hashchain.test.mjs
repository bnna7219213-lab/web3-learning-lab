import test from "node:test";
import assert from "node:assert/strict";
import { buildChain, auditChain, rewriteChain, anchor, verifyAnchor } from "../frontend/lib/hashchain.js";

const items = [
  { timestamp: "2026-10-13 09:00:00", data: "device-01 冷链 18.6℃" },
  { timestamp: "2026-10-13 09:05:00", data: "device-01 冷链 18.4℃" },
  { timestamp: "2026-10-13 09:10:00", data: "结算：供应商 A 计费 1200 元" },
];

test("诚实链审计通过，且每块 prevHash 指向上一块", async () => {
  const chain = await buildChain(items);
  const audit = await auditChain(chain);
  assert.equal(audit.valid, true);
  assert.equal(audit.brokenAt, -1);
  assert.equal(chain[1].prevHash, chain[0].hash);
  assert.equal(chain[0].prevHash, "0".repeat(64));
});

test("只改数据不重算：立刻在第 1 块被检出", async () => {
  const chain = await buildChain(items);
  chain[1].data = "device-01 冷链 8.4℃"; // 篡改者想让温度看起来合格
  const audit = await auditChain(chain);
  assert.equal(audit.valid, false);
  assert.equal(audit.brokenAt, 1);
});

test("篡改并整段重算：本地审计被骗过，但外部锚点对不上", async () => {
  const chain = await buildChain(items);
  const honestAnchor = await anchor(chain);
  const rewritten = await rewriteChain(chain, 1, "device-01 冷链 8.4℃");

  assert.equal((await auditChain(rewritten)).valid, true, "重算后本地应自洽");
  assert.notEqual(rewritten.at(-1).hash, chain.at(-1).hash, "链尖必须改变");
  assert.equal(await verifyAnchor(rewritten, honestAnchor), false, "锚点必须能识别");
});
