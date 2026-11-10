#!/usr/bin/env node
// 合约源码登记 CLI（在服务器上跑，直接写 SQLite）。
//
// 为什么是 CLI 而不是 POST /api/v1/contracts：这个 API 经 nginx 挂在公网 /b03-api/ 上，
// 开一个无鉴权的写入端点等于让任意互联网用户往交付页面上塞"已验证合约"。
// 登记是运营方/交付方的动作，本来就该 ssh 进来做，并且天然留下 shell 审计痕迹。
//
// 用法：
//   node register.js --backfill
//   node register.js --addr 0x… --name Counter --source ../../P04-…/src/Counter.sol \
//                    [--abi ../../P04-…/out/Counter.sol/Counter.json] [--git-commit <sha>] [--note "…"]
//   node register.js --list
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const db = require("./db");
const cfg = require("./config");
const { rpcCall } = require("./scanner");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

// 源码指纹：对交付方要能"自己重算一遍"，所以规则必须写死且可移植——
//   source_hash = sha256( 每个文件的 sha256(内容) 十六进制串，按相对路径字典序拼接 )
// 客户侧等价命令（同一份源码、同一组文件）：
//   for f in $(printf '%s\n' 文件列表 | sort); do sha256sum "$f"; done | awk '{printf $1}' | sha256sum
function sourceHash(files) {
  const parts = files
    .map((f) => ({ f: path.basename(f), h: crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") }))
    .sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  return {
    hash: crypto.createHash("sha256").update(parts.map((x) => x.h).join("")).digest("hex"),
    files: parts,
  };
}

async function liveCodeHash(addr) {
  const code = await rpcCall("eth_getCode", [addr, "latest"]);
  if (!code || code === "0x") return null;
  return { hash: ethers.keccak256(code), size: (code.length - 2) / 2 };
}

async function backfill(d) {
  // 补登：登记表是这次才加的，之前扫到的合约只有 txs.contract_address，没有字节码指纹
  const rows = d.prepare(
    `SELECT t.hash AS tx_hash, t.block_number, t.from_addr, t.contract_address, t.status
       FROM txs t LEFT JOIN contracts c ON c.address = t.contract_address
      WHERE t.contract_address IS NOT NULL AND c.address IS NULL AND t.status = 1`
  ).all();
  console.log(`待补登合约 ${rows.length} 个（只算 status=1 的成功部署）`);
  // 失败部署单独点出来：它们同样带 contract_address 字段但链上永远没有字节码。
  // 本链实测过两个这种地址（solc 默认出 PUSH0、链 EVM 不支持 → status=0 烧光 gas），
  // 这正是 B04 风险点②的实物证据，别把它当噪声吞掉。
  const failed = d.prepare(
    `SELECT hash, block_number, contract_address FROM txs
      WHERE contract_address IS NOT NULL AND status = 0 ORDER BY block_number DESC LIMIT 10`
  ).all();
  if (failed.length) {
    console.log(`\n另有 ${failed.length} 笔「记录了合约地址但执行失败」的部署（链上无字节码）：`);
    for (const f of failed) console.log(`  tx=${f.hash} blk=${f.block_number} 声称地址=${f.contract_address}`);
  }
  for (const r of rows) {
    const live = await liveCodeHash(r.contract_address).catch(() => null);
    if (!live) { console.log(`  ${r.contract_address} 链上无字节码（自毁或地址有误），跳过`); continue; }
    db.upsertContractCreated(d, {
      address: r.contract_address, creator: r.from_addr, deployTx: r.tx_hash,
      blockNumber: r.block_number, deployedHash: live.hash, deployedSize: live.size,
    });
    console.log(`  ${r.contract_address}  size=${live.size}B  keccak(runtime)=${live.hash}`);
  }
  console.log("补登完成");
}

async function register(d) {
  const addr = (arg("addr") || "").toLowerCase();
  const name = arg("name");
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { console.error("缺 --addr 或格式不对"); process.exit(1); }
  if (!name) { console.error("缺 --name"); process.exit(1); }

  const srcFiles = String(arg("source") || "").split(",").filter(Boolean);
  if (!srcFiles.length) { console.error("缺 --source（逗号分隔的 .sol 路径）"); process.exit(1); }
  for (const f of srcFiles) if (!fs.existsSync(f)) { console.error(`源码文件不存在：${f}`); process.exit(1); }

  const sh = sourceHash(srcFiles);
  const live = await liveCodeHash(addr);
  if (!live) { console.error(`${addr} 链上没有字节码——它不是合约，或还没被索引到。先用 --backfill。`); process.exit(1); }

  const existing = db.getContract(d, addr);
  // 登记的"verified"含义：登记的源码指纹 + 链上 runtime 指纹都在，且登记方声明二者对应。
  // 注意这不是密码学意义上的"源码==字节码"证明（那需要重编译比对，见 --recompile-check 待办），
  // 它是"可复核的主张"：客户拿 git_commit 检出源码、自己编译、比对 deployed_hash。
  const verified = 1;
  let abi = null;
  const abiFile = arg("abi");
  if (abiFile && fs.existsSync(abiFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(abiFile, "utf8"));
      abi = j.abi || j.contractABI || j;
    } catch (e) { console.warn(`ABI 解析失败（不影响登记）：${e.message}`); }
  }

  db.upsertContractCreated(d, {
    address: addr, creator: existing?.creator || null, deployTx: existing?.deploy_tx || null,
    blockNumber: existing?.block_number || null, deployedHash: live.hash, deployedSize: live.size,
  });
  db.registerContractSource(d, {
    address: addr, name, sourceHash: sh.hash, gitCommit: arg("git-commit"), abi, verified,
    note: [arg("note"), `files=${sh.files.map((x) => `${x.f}:${x.h.slice(0, 12)}`).join(" ")}`].filter(Boolean).join(" | "),
  });

  console.log(`已登记 ${name} @ ${addr}`);
  console.log(`  source_hash  = ${sh.hash}`);
  console.log(`  deployed_hash= ${live.hash}  (${live.size}B runtime)`);
  console.log(`  git_commit   = ${arg("git-commit") || "（未填，客户无法检出同一份源码）"}`);
  console.log(`  abi          = ${abi ? `${abi.length} 项` : "（未登记）"}`);
}

async function list(d) {
  for (const c of db.listContracts(d, 200)) {
    console.log(`${c.address}  ${c.name || "-"}  verified=${c.verified}  blk=${c.block_number ?? "-"}  size=${c.deployed_size ?? "-"}B`);
  }
}

(async () => {
  // db.open 会建表（IF NOT EXISTS）并打开 WAL；CLI 与常驻索引器共用同一个库文件，
  // SQLite 的 WAL 支持多进程读写，但登记是低频动作，冲突概率可忽略。
  const d = db.open(cfg.DB_PATH);
  try {
    if (has("backfill")) await backfill(d);
    else if (has("list")) await list(d);
    else await register(d);
  } finally { d.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
