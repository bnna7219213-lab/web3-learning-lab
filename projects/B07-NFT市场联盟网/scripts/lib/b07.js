// scripts/lib/b07.js —— B07 联盟网脚本公共层
// 联盟网三条硬规矩（deploy.sh 注释里同样写了）：
//   1. 零 gas：gasPrice = 0 + legacy(type 0)
//   2. 成员账户余额为 0 → eth_estimateGas 会以「余额不足」失败 → **必须显式给 gasLimit**
//   3. 合约编译必须 london（部署已按 consortium profile 编译，脚本只管发交易）
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, Network } = require("ethers");

const PROJECT = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(PROJECT, "..", "..");

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    const m = v.match(/^(.*?)\s+#/); // 去掉行尾注释
    if (m) v = m[1].trim();
    out[k] = v;
  }
  return out;
}

function cfg() {
  return {
    ...readEnvFile(path.join(PROJECT, "env", "consortium.env")),
    ...readEnvFile(path.join(PROJECT, "env", ".env.local")),
  };
}

function rpcUrl(port) {
  const c = cfg();
  if (port) return `http://127.0.0.1:${port}`;
  return c.RPC_URL || "http://127.0.0.1:8551";
}

function provider(port) {
  const c = cfg();
  const chainId = Number(c.CHAIN_ID || 19880601);
  return new JsonRpcProvider(rpcUrl(port), Network.from(chainId), { staticNetwork: true });
}

function wallet(keyName, port) {
  const c = cfg();
  const pk = c[keyName];
  if (!pk) throw new Error(`缺少私钥 ${keyName}（应放在 env/.env.local）`);
  return new Wallet(pk, provider(port));
}

function readJson(file) {
  // PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，JSON.parse 会直接报错 → 统一剥掉
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function abi() {
  return readJson(path.join(PROJECT, "abi", "LabCredential.json"));
}

function deployment() {
  return readJson(path.join(PROJECT, "deployments", "latest.json"));
}

function credential(signerOrProvider, port) {
  const dep = deployment();
  const p = signerOrProvider && signerOrProvider.provider ? signerOrProvider : provider(port);
  return new Contract(dep.credential, abi(), p);
}

/** 零 gas 交易参数：显式 gasLimit 绕过余额估算；legacy 交易 */
function txOpts(extra) {
  const c = cfg();
  return {
    gasLimit: Number(c.PER_TX_GAS_LIMIT || 8000000),
    gasPrice: 0n,
    type: 0,
    ...(extra || {}),
  };
}

async function send(contract, method, args, extra) {
  const tx = await contract[method](...args, txOpts(extra));
  const rec = await tx.wait();
  return { tx, rec };
}

let failures = 0;
function ok(cond, msg) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${msg}`);
  return !!cond;
}
function summary(title) {
  console.log(`\n${title}: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
  return failures === 0;
}
function hr(t) {
  console.log(`\n=== ${t} ===`);
}

/** 内网对象存储（本地 kubo）：multipart 多文件一次提交 → 包装目录 CID
 *  踩坑：这个 kubo 版本的 MFS files/write 行为异常（multipart/裸 body 都失败），
 *        改用 api/v0/add + wrap-with-directory；返回的是 NDJSON，最后一行是目录 CID。 */
const IPFS_API = process.env.IPFS_API || "http://127.0.0.1:5001";
async function ipfsAddDir(files) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new Blob([f.body], { type: "application/json" }), f.name);
  const r = await fetch(`${IPFS_API}/api/v0/add?wrap-with-directory=true&pin=true`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`ipfs add -> ${r.status} ${(await r.text()).slice(0, 160)}`);
  const lines = (await r.text()).trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).Hash;
}
function ipfsGateway(cid) {
  const list = [process.env.IPFS_GATEWAY || "http://127.0.0.1:8088", "http://127.0.0.1:8080"];
  return list;
}

module.exports = { PROJECT, REPO, cfg, rpcUrl, provider, wallet, abi, deployment, credential, txOpts, send, ok, summary, hr, readEnvFile, ipfsAddDir, ipfsGateway };
