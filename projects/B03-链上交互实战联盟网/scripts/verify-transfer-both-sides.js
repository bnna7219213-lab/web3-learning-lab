#!/usr/bin/env node
// 转账双向对账断言：证明"付款方减少了 X 且收款方增加了 X"，而不是只证明"我发出了交易"。
//
// 存在的理由：钱包页发完交易只回读**自己**的余额（wallet.js 的 renderBal），
// 于是"对方收到了吗"在界面里从来没有答案。这个脚本把那个缺失的判定补成一条可复跑的断言。
//
// 密钥只在内存里，不打印、不落盘。打印的全是公开信息（地址、余额、哈希）。
const { ethers } = require("ethers");

const RPC = process.env.RPC || "http://127.0.0.1:8551";
const FAUCET = process.env.FAUCET || "http://127.0.0.1:8560/claim";
const CHAIN_ID = Number(process.env.CHAIN_ID || 19880601);
const AMOUNT = process.env.AMOUNT || "1"; // B03

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const fmt = (w) => ethers.formatEther(w);

const fail = (msg) => { console.error(`\n判定：FAIL —— ${msg}`); process.exit(1); };

async function claim(addr) {
  const r = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`水龙头 HTTP ${r.status}：${j.error || "无错误体"}`);
  return j;
}

const bal = (addr) => provider.getBalance(addr);

(async () => {
  console.log(`RPC=${RPC}  chainId=${CHAIN_ID}  金额=${AMOUNT} B03`);

  // 两个一次性账户。用 createRandom 而不是复用现有钱包，避免历史余额把断言污染。
  const A = ethers.Wallet.createRandom().connect(provider);
  const B = ethers.Wallet.createRandom().connect(provider);
  console.log(`\n账户 A（付款方） ${A.address}`);
  console.log(`账户 B（收款方） ${B.address}`);

  const c = await claim(A.address);
  console.log(`\n领币 → A：${c.amount} B03，tx ${c.txHash}，块 #${c.block}`);

  const a0 = await bal(A.address);
  const b0 = await bal(B.address);
  console.log(`\n转账前  A=${fmt(a0)}  B=${fmt(b0)} B03`);
  if (a0 < ethers.parseEther(String(AMOUNT))) fail(`A 余额 ${fmt(a0)} 不足以转出 ${AMOUNT}`);

  // 与 wallet.js:137-142 完全同形：只给 to/value/gasLimit，nonce 与 gasPrice 交给 provider。
  // 断言要能代表界面，就不能在这里偷偷比界面多传参数。
  const tx = await A.sendTransaction({
    to: B.address,
    value: ethers.parseEther(String(AMOUNT)),
    gasLimit: 21000n,
  });
  console.log(`\n已广播   tx ${tx.hash}`);

  const rec = await tx.wait();
  console.log(`入块     #${rec.blockNumber}  status=${rec.status}  gasUsed=${rec.gasUsed}  from=${rec.from}`);
  if (rec.status !== 1) fail(`交易状态为 0（回滚），收款方不会收到任何价值`);

  const a1 = await bal(A.address);
  const b1 = await bal(B.address);
  const need = ethers.parseEther(String(AMOUNT));
  const dA = a0 - a1; // 期望 = need
  const dB = b1 - b0; // 期望 = need

  console.log(`\n转账后  A=${fmt(a1)}  B=${fmt(b1)} B03`);
  console.log(`增量     A 变化 -${fmt(dA)}（应 -${fmt(need)}）   B 变化 +${fmt(dB)}（应 +${fmt(need)}）`);

  const problems = [];
  if (dA !== need) problems.push(`A 未减少 ${fmt(need)}，实际减少 ${fmt(dA)}`);
  if (dB !== need) problems.push(`B 未增加 ${fmt(need)}，实际增加 ${fmt(dB)}`);
  if (problems.length) fail(problems.join("；"));

  console.log(`\n判定：PASS —— 价值确实从 A 移动到 B，两侧增量均为 ${fmt(need)} B03（本链零 gas，故 A 减少量恰等于面值）`);
  console.log(`可复核：把 ${tx.hash} 贴进 ${RPC.replace(/:\d+/, ":8080")}/b03/ 或用 /b03-api/api/v1/* 逐字段核对`);
})().catch((e) => fail(e.shortMessage || e.message));
