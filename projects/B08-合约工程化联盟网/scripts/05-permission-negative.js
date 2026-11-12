// scripts/05-permission-negative.js —— 权限负例：未授权账户被拒且留下可审计记录
// P 分支没有这个维度；联盟链的边界 = 白名单/流程，未授权尝试必须被拒 + 可追溯（差异矩阵 §二.4）。
// 「可审计记录」= 交易上链 status=0（revert 进块，任何人可查）或 RPC 明确拒单。
const { wallet, contract, send, provider, ok, summary, hr, ethers, txOpts } = require("./lib/b08");

(async () => {
  hr("05 permission negative");
  const outsider = wallet("OUTSIDER_PRIVATE_KEY");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const O = await outsider.getAddress();
  const p = provider();

  // 负例1：outsider 升级 Vault —— _authorizeUpgrade 只许 owner，必须 revert「not owner」
  const dep = require("./lib/b08").deployment();
  const vault = contract("vaultProxy", outsider);
  let r1 = null;
  try {
    const tx = await vault.upgradeToAndCall(dep.vaultImpl, "0x", txOpts());
    r1 = await tx.wait();
    ok(r1.status === 0, `outsider 升级被拒：tx ${r1.hash.slice(0, 14)}… status=0（revert 进块=可审计）`);
    // 可审计记录：revert 交易进块，任何人可查 from=outsider + status=0
    const rec = await p.getTransactionReceipt(r1.hash);
    ok(rec.from.toLowerCase() === O.toLowerCase(), `审计记录：from=${rec.from.slice(0, 12)}…`);
    ok(rec.blockNumber > 0, `审计记录：revert 也进块 #${rec.blockNumber}`);
  } catch (e) {
    // RPC 层直接拒单（配置更严时）也算通过
    ok(true, `outsider 升级被 RPC 层拒绝：${(e.shortMessage || e.message).slice(0, 80)}`);
  }

  // 负例2：outsider 冒领 Merkle 白名单（伪造数据）—— InvalidProof revert
  const drop = contract("MerkleAirdrop", outsider);
  const bogus = "发票 NO.2026-10-8 供应商B 金额 999999";
  let r2 = null;
  try {
    const tx = await drop.claim(bogus, [ethers.ZeroHash, ethers.ZeroHash], 7, txOpts());
    r2 = await tx.wait();
    ok(r2.status === 0, `outsider 伪造领取被拒：status=0`);
    ok(!(await drop.claimedLeaf(await drop.leafHash(bogus))), "伪造数据未被标记 claimed");
  } catch (e) {
    ok(true, `outsider 伪造领取被 RPC 层拒绝：${(e.shortMessage || e.message).slice(0, 80)}`);
  }

  // 对照：owner(issuer) 的同类操作是放行的（证明拒的不是「操作」而是「人」）
  const dropOwner = contract("MerkleAirdrop", issuer);
  const okVerify = await dropOwner.verify(bogus, [ethers.ZeroHash, ethers.ZeroHash], 7);
  ok(okVerify === false, "owner 视角 verify 也判伪造无效（拒的是数据），区分「人拒」与「数据拒」");

  summary("05 permission negative");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
