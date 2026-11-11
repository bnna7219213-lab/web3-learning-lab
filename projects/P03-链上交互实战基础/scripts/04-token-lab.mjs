// 步骤④：ERC-20 实验（复用 B03 的 DemoToken paris 编译产物——本链 London 级 EVM 不认 PUSH0）。
// 产出三笔交易：部署（to=null）/ mint（from=0x0 的 Transfer）/ 成功 transfer（带日志），
// 以及一笔**入块但 revert 的失败交易**（status=0，gas 照烧）——验收门禁要求的失败案例。
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { REPO, learnerWallet, provider, loadEnv } from "./lib.mjs";

const ARTIFACT = path.join(REPO, "projects/B03-链上交互实战联盟网/token/DemoToken.artifact.json");

export async function main() {
  const rootEnv = loadEnv(path.join(REPO, ".env"));
  if (!rootEnv.FAUCET_PK) throw new Error("缺 FAUCET_PK（仓库根 .env）：运营账户负责部署与 mint");
  const p = provider();
  const operator = new ethers.Wallet(rootEnv.FAUCET_PK, p);
  const learner = learnerWallet();
  const env = loadEnv();
  const payee = env.PAYEE_ADDRESS;

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  console.log(`使用产物：${artifact.contractName}（${artifact.compiler}）`);

  // 1) 部署：to=null 的交易，合约地址 = keccak(RLP(deployer, nonce))[12:]
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, operator);
  const token = await factory.deploy({ gasLimit: 3_000_000n, gasPrice: 0n, type: 0 });
  const deployRec = await token.deploymentTransaction().wait();
  const tokenAddr = await token.getAddress();
  console.log(`部署 ✓ ${tokenAddr}  tx=${deployRec.hash} block=#${deployRec.blockNumber} gasUsed=${deployRec.gasUsed}`);

  // 2) mint 1000 DEMO → 付款方（只有 owner 能 mint；Transfer.from=0x0）
  const mintTx = await token.mint(learner.address, ethers.parseUnits("1000", 18), { gasLimit: 120_000n, gasPrice: 0n, type: 0 });
  const mintRec = await mintTx.wait();
  console.log(`mint ✓ 1000 DEMO → LEARNER  tx=${mintTx.hash} status=${mintRec.status}`);

  // 3) 成功 transfer：250 DEMO → 收款方（产生 Transfer 日志，供索引器/浏览器解码）
  const okTx = await token.connect(learner).transfer(payee, ethers.parseUnits("250", 18), { gasLimit: 120_000n, gasPrice: 0n, type: 0 });
  const okRec = await okTx.wait();
  console.log(`transfer ✓ 250 DEMO → PAYEE  tx=${okTx.hash} status=${okRec.status} logs=${okRec.logs.length}`);

  // 4) 失败 transfer：余额 750，偏转 751 → require(balanceOf[from] >= value, "balance") revert
  const bal = await token.balanceOf(learner.address);
  const tooMuch = bal + 1n;
  const failTx = await token.connect(learner).transfer(payee, tooMuch, { gasLimit: 120_000n, gasPrice: 0n, type: 0 });
  // ethers v6 把 status=0 当 CALL_EXCEPTION 抛出，回执挂在异常上——
  // 「交易入块但执行失败」与「请求失败」是两回事，这里要的是前者。
  let failRec;
  try {
    failRec = await failTx.wait();
  } catch (e) {
    if (e.code !== "CALL_EXCEPTION" || !e.receipt) throw e;
    failRec = e.receipt;
  }
  if (failRec.status !== 0) throw new Error(`期望 status=0 的失败交易，实际 ${failRec.status}`);
  console.log(`transfer ✗（预期失败）tx=${failTx.hash} status=0 gasUsed=${failRec.gasUsed}（gas 照烧，价值不动）`);
  const balAfter = await token.balanceOf(learner.address);
  if (balAfter !== bal) throw new Error("失败交易竟改动了余额！");
  console.log(`  余额不变 ✓：${ethers.formatUnits(bal, 18)} DEMO`);

  return {
    tokenAddress: tokenAddr,
    deployTx: deployRec.hash,
    mintTx: mintTx.hash,
    okTx: okTx.hash,
    failTx: failTx.hash,
    failBalanceWei: bal.toString(),
    failAttemptWei: tooMuch.toString(),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}