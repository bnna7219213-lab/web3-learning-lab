#!/usr/bin/env node
// scripts/make-stuck-tx.js —— 复现「卡单」：零余额账户发一笔付不起手续费的交易（只用于本地实验链）
//
// 交易形状（B04 坑 1 的原样复现）：legacy / gasPrice=1 / value=0 / gas=505440
// → 需要 505440 wei 手续费而账户余额 0；因 tx-pool-enable-balance-check=false 它会**进池**，
//   拿到 hash、永远不入块、并占住 nonce 0。这正是要观测/处置的对象。
//
// 用法: node scripts/make-stuck-tx.js [--rpc http://127.0.0.1:8551]
// 输出: txHash。私钥仅写本地 docs/evidence/latest-stuck-account.json（权限 0600、gitignore），
// 不打印到终端或聊天记录；文件路径由 --key-out 指定，默认拒绝覆盖已有文件。
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const RPC = arg("rpc", "http://127.0.0.1:8551");
const KEY_OUT = arg("key-out", path.join(__dirname, "..", "docs", "evidence", "latest-stuck-account.json"));
if (!KEY_OUT.includes(`${path.sep}docs${path.sep}evidence${path.sep}`)) throw new Error("密钥文件只能落在项目 docs/evidence/ 下");
if (fs.existsSync(KEY_OUT)) throw new Error(`密钥文件已存在，拒绝覆盖：${KEY_OUT}（请显式指定新的 --key-out）`);

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  const w = ethers.Wallet.createRandom();
  const signed = await w.signTransaction({
    to: w.address,
    value: 0n,
    nonce: 0,
    gasLimit: 505440n,
    gasPrice: 1n,
    type: 0,
    chainId: Number(net.chainId),
  });
  const hash = await provider.send("eth_sendRawTransaction", [signed]);
  console.log(`账户(余额 0): ${w.address}`);
  fs.mkdirSync(path.dirname(KEY_OUT), { recursive: true });
  fs.writeFileSync(KEY_OUT, JSON.stringify({ address: w.address, txHash: hash, privateKey: w.privateKey }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`卡单账户密钥已写入本地受控文件（不入库，不打印）：${KEY_OUT}`);
  console.log(`卡单 txHash: ${hash}`);
  const tx = await provider.getTransaction(hash);
  console.log(`进池确认: tx 非 null=${!!tx} blockNumber=${tx ? tx.blockNumber : "-"}（null=卡在池里）`);
  console.log(`\n下一步: node scripts/observe-stuck-tx.js ${hash} --minutes 2 --interval 30`);
})();
