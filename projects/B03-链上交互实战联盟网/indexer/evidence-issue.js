#!/usr/bin/env node
// 出证 CLI（在服务器上跑）。签发要发交易、要私钥，绝不能挂在公网 API 上——
// /b03-api/ 是全世界可读的，给它加个写入口等于请人拿你的签发身份出假证。
//
// 用法：
//   node evidence-issue.js --genkey                     # 首次：生成签发密钥对（落盘 600）
//   node evidence-issue.js --tx 0xaaa…,0xbbb…           # 给若干笔交易出一个批次
//   node evidence-issue.js --file batch.json            # 自定义批次 [{subjectKind,subjectId,data}]
//   node evidence-issue.js --verify ev_xxx              # 服务端当场复核一份证据包
const fs = require("fs");
const path = require("path");
const db = require("./db");
const cfg = require("./config");
const evidence = require("./evidence");
const { sign } = require("./core");

const KEY_DIR = process.env.EVIDENCE_KEYS || "/opt/b03-evidence-keys";
const KEY_JSON = path.join(KEY_DIR, "issuer.json");

function arg(n, def = null) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes(`--${n}`);

function loadIssuer() {
  if (!fs.existsSync(KEY_JSON)) throw new Error(`没有签发密钥，先跑：node evidence-issue.js --genkey`);
  return JSON.parse(fs.readFileSync(KEY_JSON, "utf8"));
}

function genKey() {
  if (fs.existsSync(KEY_JSON)) { console.log(`已存在 ${KEY_JSON}，不覆盖（覆盖会让历史证据包验签失败）`); return; }
  const { ethers } = require("ethers");
  const kp = sign.generateKeyPair();              // P-256：签证据包
  const acct = ethers.Wallet.createRandom();      // secp256k1：发锚点交易
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const rec = {
    name: process.env.EVIDENCE_ISSUER_NAME || "B03 联盟网运营方",
    keyId: kp.keyId,
    privateKeyPem: kp.privateKeyPem,
    publicKeyPem: kp.publicKeyPem,
    privateKeyHex: acct.privateKey,
    anchorFrom: acct.address,
  };
  fs.writeFileSync(KEY_JSON, JSON.stringify(rec, null, 2), { mode: 0o600 });
  // 私钥绝不打印到 stdout（会进 shell history 和日志），只告诉客户公钥
  console.log("已生成签发密钥：", KEY_JSON, "（权限 600，私钥不回显）");
  console.log("  keyId        =", kp.keyId);
  console.log("  锚点发交易地址 =", acct.address, "（零 gas + value=0，无需充值）");
  console.log("  公钥 PEM     =\n" + kp.publicKeyPem.trim());
  console.log("\n把上面公钥交给客户，他们就能自己验签，不必信任本服务。");
}

async function main() {
  if (has("genkey")) return genKey();

  const d = db.open(cfg.DB_PATH);
  evidence.ensureSchema(d);

  if (has("verify")) {
    // 公钥必须显式给：verifyLib 拿不到公钥时会跳过签名检查并返回 ok=false，
    // 但绝不能"因为跳过所以看起来通过"——这里主动加载，缺文件就直接报错停下。
    const issuer = loadIssuer();
    const r = await evidence.verifyStored(d, arg("verify"), issuer.publicKeyPem);
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  let items;
  if (has("file")) {
    items = JSON.parse(fs.readFileSync(arg("file"), "utf8"));
  } else if (has("tx")) {
    const hashes = String(arg("tx")).split(",").map((s) => s.trim()).filter(Boolean);
    if (!hashes.length) throw new Error("--tx 没给哈希");
    items = hashes.map((h) => ({ subjectKind: "settlement-batch", subjectId: h, data: h, displayName: `交易 ${h.slice(0, 12)}…` }));
  } else {
    throw new Error("用法：--genkey | --tx 0x…,0x… | --file batch.json | --verify ev_xxx");
  }

  const issuer = loadIssuer();
  // 公钥得能拿到才能验签：存在环境变量文件里，verify 时读
  process.env.EVIDENCE_PUBLIC_PEM = issuer.publicKeyPem;
  const r = await evidence.issueBatch(d, items, {
    batchId: arg("batch"),
    confirmationsRequired: Number(arg("confirm", 1)),
  }, issuer);

  console.log(`批次 ${r.batchId}  根 ${r.root}`);
  console.log(`锚定交易 ${r.anchor.txHash}  块 #${r.anchor.blockNumber}`);
  for (const p of r.packages) console.log(`  ${p.evidenceId}  leaf ${p.leaf.index}  ${p.subject.id}`);
  console.log(`\n复核：curl -s ${require("./config").PUBLIC_BASE}/b03-api/api/v1/evidence/${r.packages[0].evidenceId}/verify`);
  d.close();
}

main().catch((e) => { console.error("出证失败：", e.message); process.exit(1); });
