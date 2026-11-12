// scripts/merge-faucet-deployment.js —— 把 LabFaucet 的部署记录并进 deployments/latest.json
//
// latest.json 是两侧服务的「链上部署事实」入口（B07 脚本、凭证管理台都读它）。
// 单独部署 LabFaucet 时用它补一个 faucet 字段，不动既有的 credential 字段。
const fs = require("fs");
const path = require("path");

const PROJECT = path.resolve(__dirname, "..");
const fac = JSON.parse(fs.readFileSync(path.join(PROJECT, "deployments", "faucet-latest.json"), "utf8").replace(/^\uFEFF/, ""));
const latestPath = path.join(PROJECT, "deployments", "latest.json");
const latest = JSON.parse(fs.readFileSync(latestPath, "utf8").replace(/^\uFEFF/, ""));

latest.faucet = fac.faucet;
latest.faucetDailyCap = fac.dailyCap;
latest.faucetAmountPerClaim = fac.amountPerClaim;
latest.faucetCooldownSeconds = fac.cooldownSeconds;
latest.faucetBytecodeHash = fac.bytecodeHash;

fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n", "utf8");
console.log("merged into deployments/latest.json:");
console.log("  faucet      ", fac.faucet);
console.log("  dailyCap    ", fac.dailyCap);
console.log("  perClaim    ", fac.amountPerClaim);
console.log("  cooldown    ", fac.cooldownSeconds);
