// faucet/start.js: 从仓库根 .env 读 FAUCET_PK 启动水龙头（私钥不进命令行）
// 可选：CREDENTIAL_URL=http://127.0.0.1:8580 → 领币成功后回调 B07 发证服务，
//       一次领取同时得到「联盟链余额」与「权益凭证」。
// 2026-11-13：每日额度改由链上合约 LabFaucet 强制，合约地址默认读 faucet/deployment.json，
//       也可用 FAUCET_CONTRACT 覆盖（测试实例用）。FAUCET_PORT 可改监听端口。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch (e) {
  /* 没有 .env 就走环境变量 */
}
if (env.FAUCET_PK) process.env.FAUCET_PK = env.FAUCET_PK.trim();
if (env.FAUCET_CONTRACT && !process.env.FAUCET_CONTRACT) process.env.FAUCET_CONTRACT = env.FAUCET_CONTRACT.trim();
if (process.env.CREDENTIAL_URL) process.env.CREDENTIAL_URL = process.env.CREDENTIAL_URL.trim();
if (!process.env.FAUCET_PK) {
  console.error("缺 FAUCET_PK（仓库根 .env，或用环境变量传入）");
  process.exit(1);
}
console.log("发证服务衔接：", process.env.CREDENTIAL_URL || "（未配置：只发币，不发凭证）");
console.log("额度合约：", process.env.FAUCET_CONTRACT || "（默认读 faucet/deployment.json）");
require("./server.js");
