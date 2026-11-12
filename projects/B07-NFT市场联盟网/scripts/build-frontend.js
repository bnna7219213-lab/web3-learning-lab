// scripts/build-frontend.js: 把部署地址 + ABI 下发到前端（禁手抄，与 P07 同一口径）
const fs = require("fs");
const path = require("path");
const { PROJECT, cfg, deployment } = require("./lib/b07");

const front = path.join(PROJECT, "frontend");
fs.mkdirSync(front, { recursive: true });

const dep = deployment();
const c = cfg();
const conf = {
  // 用**同源代理**而不是直连：联盟网 Besu 的 corsAllowedDomains=[] → 浏览器直连会被 CORS 拒
  rpcUrl: "/rpc",
  rpcUrlDirect: c.RPC_URL || "http://127.0.0.1:8551",
  chainId: Number(c.CHAIN_ID || 19880601),
  contract: dep.credential,
  ossBase: c.INTERNAL_OSS_BASE || "http://127.0.0.1:8088/ipfs/",
  networkProfile: "consortium",
};
fs.writeFileSync(path.join(front, "config.js"), `window.B07_CONFIG = ${JSON.stringify(conf, null, 2)};\n`);

const abi = JSON.parse(fs.readFileSync(path.join(PROJECT, "abi", "LabCredential.json"), "utf8").replace(/^\uFEFF/, ""));
fs.writeFileSync(path.join(front, "abi.json"), JSON.stringify(abi));

console.log("frontend config written:", JSON.stringify(conf));
console.log("abi entries:", abi.length);
