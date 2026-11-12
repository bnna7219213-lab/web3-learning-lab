// scripts/lib/b07.js —— B07 联盟网脚本公共层
// 联盟网三条硬规矩（deploy.sh 注释里同样写了）：
//   1. 零 gas：gasPrice = 0 + legacy(type 0)
//   2. 成员账户余额为 0 → eth_estimateGas 会以「余额不足」失败 → **必须显式给 gasLimit**
//   3. 合约编译必须 london（部署已按 consortium profile 编译，脚本只管发交易）
const fs = require("fs");
const path = require("path");
const { ethers, JsonRpcProvider, Wallet, Contract, Network } = require("ethers");

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

// ---------------- 链上额度与链上用量派生（B03 × B07 预算治理） ----------------
//
// 原则：**用量事实只从链上取**，服务自己的记账文件只当审计流水。
// 原因（实测）：Besu 侧历史状态被剪枝（只有 latest 可读），所以「日切时刻的余额 / nextId」
// 读不到；原生转账又不产生日志，所以水龙头侧干脆把额度本身搬上链（LabFaucet），
// 凭证侧则用**事件日志**（CredentialIssued.count 累计）按日派生。

/** LabFaucet ABI（额度合约；B03 水龙头用的是同一份 ABI 的副本） */
function faucetAbi() {
  return readJson(path.join(PROJECT, "abi", "LabFaucet.json"));
}

/** 额度合约实例（只读用 provider；要发交易用 signer） */
function faucetContract(signerOrProvider) {
  const dep = deployment();
  if (!dep.faucet) throw new Error("deployments/latest.json 缺 faucet 字段（先跑 scripts/deploy-faucet.ps1）");
  const p = signerOrProvider && signerOrProvider.provider ? signerOrProvider : provider();
  return new Contract(dep.faucet, faucetAbi(), p);
}

/** 当前 UTC 日切时间戳（与服务端 utcDay() 口径一致） */
function dayStartTs() {
  return Math.floor(Date.now() / 1000 / 86400) * 86400;
}

/** 按 block.timestamp 二分定位 UTC 日切区块（第一个 ts >= 日切时刻的块） */
async function findDayStartBlock(p, ts) {
  const latest = await p.getBlockNumber();
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const b = await p.getBlock(mid);
    if (b.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 链上派生：区间内某事件累计的第 1 个非 indexed 数值字段（uint256 count）。
 * Besu 单次 eth_getLogs 的区间上限实测约 5000 块（10000 会报 could not coalesce error）→ 分块查。
 */
async function chainEventCount(p, opts) {
  const { address, topic, fromBlock, toBlock } = opts;
  const chunk = opts.chunk || 2000;
  const topics = opts.topics || [topic];
  let total = 0n;
  let logs = 0;
  let chunks = 0;
  const errors = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    chunks++;
    try {
      const ls = await p.send("eth_getLogs", [
        { address, topics, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) },
      ]);
      logs += ls.length;
      for (const l of ls) total += BigInt("0x" + l.data.slice(2, 66));
    } catch (e) {
      errors.push(`${from}-${to}: ${e.shortMessage || e.message}`);
    }
  }
  return { total, logs, chunks, errors };
}

const CREDENTIAL_ISSUED_TOPIC = ethers.id("CredentialIssued(uint256,uint256,uint16,bytes32,address)");

/**
 * 链上派生：当日已发凭证份数（当日区块区间内 CredentialIssued.count 累计）
 * @param issuerFilter 只统计某个签发者（address）。CredentialIssued 的三个 indexed 参数是
 *   batchId / startId / issuer → issuer 落在 topics[3]。
 *   发证服务用独立签发账户，就是为了让「服务对外发放」与「运营方批量发行」分开算：
 *   否则 05-batch-1000.js 一次发 1000 份会把当日服务配额占满，用户领取路径被锁死。
 */
async function chainIssuedToday(p, contractAddress, issuerFilter) {
  const fromBlock = await findDayStartBlock(p, dayStartTs());
  const toBlock = await p.getBlockNumber();
  const topics = issuerFilter
    ? [CREDENTIAL_ISSUED_TOPIC, null, null, ethers.zeroPadValue(ethers.getAddress(issuerFilter), 32)]
    : [CREDENTIAL_ISSUED_TOPIC];
  const r = await chainEventCount(p, { address: contractAddress, topics, fromBlock, toBlock });
  return { issued: r.total, fromBlock, toBlock, logs: r.logs, chunks: r.chunks, errors: r.errors };
}

/**
 * 链上派生用量的完整性自检：全历史 count 合计应等于合约 nextId
 * （mintBatch 是唯一增发入口；两者相等说明历史日志没被剪枝，按日派生才可信）。
 */
async function chainIssuedIntegrity(p, contractAddress, contract) {
  const toBlock = await p.getBlockNumber();
  const r = await chainEventCount(p, {
    address: contractAddress,
    topic: CREDENTIAL_ISSUED_TOPIC,
    fromBlock: 0,
    toBlock,
  });
  const nextId = await contract.nextId();
  return { logCount: r.total, nextId, ok: r.total === nextId, errors: r.errors };
}

/** 链上事实：水龙头当日额度（dailyInfo） */
async function chainFaucetBudget(p) {
  const f = faucetContract(p);
  const [day, spent, remaining, cap, amountPerClaim, balance] = await f.dailyInfo();
  return {
    day: Number(day),
    spent,
    remaining,
    cap,
    amountPerClaim,
    contractBalance: balance,
    source: "chain",
  };
}

module.exports = {
  PROJECT,
  REPO,
  cfg,
  rpcUrl,
  provider,
  wallet,
  abi,
  deployment,
  credential,
  txOpts,
  send,
  ok,
  summary,
  hr,
  readEnvFile,
  ipfsAddDir,
  ipfsGateway,
  faucetAbi,
  faucetContract,
  dayStartTs,
  findDayStartBlock,
  chainEventCount,
  chainIssuedToday,
  chainIssuedIntegrity,
  chainFaucetBudget,
};
