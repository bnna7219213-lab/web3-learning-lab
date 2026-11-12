// faucet/start.js: 从仓库根 .env 读 FAUCET_PK 启动水龙头（私钥不进命令行）
// 可选：CREDENTIAL_URL=http://127.0.0.1:8580 → 领币成功后回调 B07 发证服务，
//       一次领取同时得到「联盟链余额」与「权益凭证」。
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
if (process.env.CREDENTIAL_URL) process.env.CREDENTIAL_URL = process.env.CREDENTIAL_URL.trim();
if (!process.env.FAUCET_PK) {
  console.error("缺 FAUCET_PK（仓库根 .env，或用环境变量传入）");
  process.exit(1);
}
console.log("发证服务衔接：", process.env.CREDENTIAL_URL || "（未配置：只发币，不发凭证）");
require("./server.js");
