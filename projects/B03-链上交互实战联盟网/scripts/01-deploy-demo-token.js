#!/usr/bin/env node
// B03 演示代币 DemoToken（DEMO）部署 + 初始分发
// 跑法（服务器）：
//   cd /opt/b03-deploy && NODE_PATH=/opt/b03-faucet/node_modules node 01-deploy-demo-token.js
// 签名者 = 水龙头 admin（从 /opt/b03-faucet/.env 读 FAUCET_PK，私钥不进命令行）
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC || "http://127.0.0.1:8551";
const CHAIN_ID = 19880601;
const ENV_PATH = process.env.FAUCET_ENV || "/opt/b03-faucet/.env";
const ARTIFACT = process.env.ARTIFACT || path.join(__dirname, "DemoToken.artifact.json");

// 读 .env（KEY=VALUE，忽略注释/空行）
function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const DECIMALS = 18;
const TOTAL = 1_000_000n; // 1,000,000 DEMO
const toWei = (n) => ethers.parseUnits(String(n), DECIMALS);

// 初始分发：admin 70%（含 10% 预留待分发）+ 3 个演示地址各 10%
// 注意：地址一律写小写，ethers 对混合大小写会做 EIP-55 校验，手写地址容易 checksum 不符
const DEMO_RECIPIENTS = [
  // 3 个演示地址：用于「代币页」持仓分布展示
  "0xea4ade230c1f0ff171755f6d66a8a927f27e10db",
  "0x433ba1f878a6f13b17cbcbca465508bba04a016a",
  "0x90d090d6a3f7b72b2b0d65a1d17b2b8c3e4d0ef0",
];
const DEMO_SHARE = 100_000n; // 每个演示地址 10%

async function main() {
  const env = loadEnv(ENV_PATH);
  const PK = env.FAUCET_PK;
  if (!PK) throw new Error(`缺 FAUCET_PK（${ENV_PATH}）`);

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const signer = new ethers.Wallet(PK, provider);
  console.log(`部署者(admin)=${signer.address}`);
  console.log(`余额=${ethers.formatEther(await provider.getBalance(signer.address))} B03`);

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

  console.log("部署 DemoToken 合约…");
  // 零 gas 链：estimateGas 常返回异常（缺 revert data），显式 gasLimit + gasPrice 0 跳过估算
  // 构造函数零参数（name/symbol 为合约内 constant，见 DemoToken.sol）
  const token = await factory.deploy({ gasLimit: 3_000_000n, gasPrice: 0n });
  await token.waitForDeployment();
  const addr = await token.getAddress();
  console.log(`✅ 合约地址=${addr}`);

  // 初始分发
  const adminShare = TOTAL - DEMO_SHARE * BigInt(DEMO_RECIPIENTS.length);
  const mints = [[signer.address, adminShare], ...DEMO_RECIPIENTS.map((a) => [a, DEMO_SHARE])];
  for (const [to, amt] of mints) {
    const tx = await token.mint(to, toWei(amt), { gasLimit: 120_000n, gasPrice: 0n });
    const rec = await tx.wait();
    console.log(`mint ${amt} DEMO → ${to}  tx=${tx.hash} block=#${rec.blockNumber}`);
  }

  const [name, symbol, dec, supply] = await Promise.all([
    token.name(), token.symbol(), token.decimals(), token.totalSupply(),
  ]);
  console.log(`元数据：${name}(${symbol}) decimals=${dec} totalSupply=${ethers.formatUnits(supply, DECIMALS)}`);
  console.log(`\n写入 README 的合约地址：${addr}`);
  fs.writeFileSync(path.join(__dirname, "DEMO_TOKEN_ADDRESS.txt"), addr + "\n");
}

main().catch((e) => { console.error("部署失败：", e.message); process.exit(1); });
