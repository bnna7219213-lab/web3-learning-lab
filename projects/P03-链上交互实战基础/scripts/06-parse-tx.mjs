// 步骤⑥：逐字段解析任意一笔交易 → Markdown（手册的生成器）。
// 用法：node scripts/06-parse-tx.mjs <txHash> [标题]
import { parseTx, renderTxMarkdown } from "./lib.mjs";

const hash = process.argv[2];
if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
  console.error("用法: node scripts/06-parse-tx.mjs <0x…64位交易哈希> [标题]");
  process.exit(1);
}
const title = process.argv[3] || `交易解析 ${hash.slice(0, 10)}…`;
const record = await parseTx(hash);
console.log(renderTxMarkdown(record, title));