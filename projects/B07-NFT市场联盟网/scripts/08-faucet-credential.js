// scripts/08-faucet-credential.js —— B03 水龙头与 B07 凭证发放的衔接验收
//
// 链路：钱包页「领币」→ B03 faucet(8560) 发 10 B03 → 回调 B07 发证服务(8580)
//       → 校验链上有余额 → 登记为链上成员 → 生成元数据入内网 OSS → 算 Merkle 根 → 发行 1 份凭证
// 验收点：一次领取同时得到「余额 + 凭证」；凭证元数据可取回且哈希锚定一致；负例按预期被拒。
const path = require("path");
const { ethers } = require("ethers");
const { wallet, credential, provider, deployment, ok, summary, hr, REPO, cfg } = require("./lib/b07");

const FAUCET = process.env.FAUCET_URL || "http://127.0.0.1:8560";
const CRED = process.env.CREDENTIAL_URL || "http://127.0.0.1:8580";

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

(async () => {
  hr("08 faucet claim -> credential issuance (B03 x B07 integration)");
  const p = provider();
  const cred = credential(p);
  const dep = deployment();

  // 1) 两个全新地址：一个用来领，一个用来做「没领过水」的负例
  const fresh = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();
  console.log("  新地址(领) ", fresh.address);
  console.log("  新地址(负例)", stranger.address);

  // 2) 领水 + 领证（一次请求）
  const t0 = Date.now();
  const claim = await post(`${FAUCET}/claim`, { address: fresh.address });
  console.log(`  faucet HTTP ${claim.status}（${Date.now() - t0}ms）`);
  console.log("  faucet 返回:", JSON.stringify(claim.body).slice(0, 400));
  ok(claim.status === 200 && claim.body && claim.body.ok, "水龙头领取成功");
  ok(claim.body && claim.body.credential && claim.body.credential.ok, "同一次领取带回凭证信息（衔接生效）");
  if (!claim.body || !claim.body.credential || !claim.body.credential.ok) {
    console.log("  凭证信息：", JSON.stringify(claim.body && claim.body.credential));
  }

  // 3) 链上核对：余额
  const bal = await p.getBalance(fresh.address);
  ok(bal === ethers.parseEther("10"), `链上余额 10 B03（实测 ${ethers.formatEther(bal)}）`);

  // 4) 链上核对：成员资格 + 凭证归属
  ok((await cred.isMember(fresh.address)) === true, "该地址已被登记为链上成员（isMember=true）");
  const nextId = await cred.nextId();
  const tokenId = nextId - 1n;
  ok((await cred.ownerOf(tokenId)) === fresh.address, `凭证 #${tokenId} 归该地址`);
  ok((await cred.balanceOf(fresh.address)) === 1n, "该地址持有 1 份凭证");

  // 5) 元数据可取回 + 哈希锚定一致
  const uri = await cred.tokenURI(tokenId);
  console.log("  tokenURI =", uri);
  const meta = await (await fetch(uri)).json();
  ok(meta && meta.holder === fresh.address, "元数据可从内网对象存储取回且持有人一致");
  const anchored = await cred.merkleRootOf(tokenId);
  const merkle = require(path.join(REPO, "shared", "evidence", "lib", "merkle-indexed.js"));
  const recomputed = merkle.buildTree([Buffer.from(JSON.stringify(meta))]).root;
  ok(recomputed === anchored, "元数据重算的 Merkle 根与链上锚定一致");
  console.log(`  merkleRoot(链上) = ${anchored}`);
  console.log(`  merkleRoot(重算) = ${recomputed}`);

  // 6) 负例 A：没领过水的地址不能领凭证
  const neg = await post(`${CRED}/claim`, { address: stranger.address });
  ok(neg.status === 429 || (neg.body && !neg.body.ok), `没领过水的地址被拒（HTTP ${neg.status}）`);
  console.log("  拒绝原因：", (neg.body && neg.body.error || "").slice(0, 90));

  // 7) 负例 B：同一地址 60s 内重复领取 → 冷却
  const again = await post(`${FAUCET}/claim`, { address: fresh.address });
  ok(again.status === 429 || (again.body && !again.body.ok), `重复领取被冷却拦截（HTTP ${again.status}）`);
  console.log("  冷却原因：", (again.body && again.body.error || "").slice(0, 90));

  summary("08 faucet-credential");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
