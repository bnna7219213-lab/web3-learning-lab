// scripts/credential-service.js —— 联盟内「领水 → 领凭证」发证服务（端口 8580）
//
// 与 B03 水龙头的衔接：
//   B03 faucet（8560）发币成功后，若配置了 CREDENTIAL_URL，就回调本服务 /claim：
//   一次领取同时拿到「联盟链余额」与「权益凭证」——这正是联盟网对用户有意义的形态。
//   本服务也可以独立被调（运营方发证 / 补发）。
//
// 为什么「领证」要有前置条件：
//   凭证是**权益**，不是空投。校验链上余额 > 0（= 确实领过联盟水，或已从其他成员处收款），
//   避免任何人找服务就能无限领证。
//
// 治理口径与水龙头同款：同地址冷却 + 每日凭证配额上限 + 落盘记账（进程重启不清零）。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { PROJECT, REPO, cfg, deployment, abi, ipfsAddDir } = require("./lib/b07");
const merkle = require(path.join(REPO, "shared", "evidence", "lib", "merkle-indexed.js"));

const PORT = Number(process.env.CREDENTIAL_PORT || 8580);
const RPC = process.env.CREDENTIAL_RPC || cfg().RPC_URL || "http://127.0.0.1:8551";
const CHAIN_ID = Number(cfg().CHAIN_ID || 19880601);
// 私钥来源：优先环境变量（会 trim —— 命令行传参容易带上尾随空格，ethers 会直接拒），
// 否则读 env/.env.local（本地不入库）
const ISSUER_PK = String(process.env.ISSUER_PRIVATE_KEY || cfg().ISSUER_PRIVATE_KEY || "").trim();
const COOLDOWN_MS = 60_000;
const DAILY_QUOTA = BigInt(process.env.CREDENTIAL_DAILY_QUOTA || 100); // 每日 100 份
const DATA = process.env.CREDENTIAL_DATA || path.join(PROJECT, "scripts", "data", "credential-claims.json");
const OSS_GATEWAY = process.env.OSS_GATEWAY || "http://127.0.0.1:8088";

if (!ISSUER_PK) {
  console.error("缺 ISSUER_PRIVATE_KEY（应放在 env/.env.local）");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const issuer = new ethers.Wallet(ISSUER_PK, provider);
const dep = deployment();
const cred = new ethers.Contract(dep.credential, abi(), issuer);

let state = { lastClaim: {}, day: null, issued: "0" };
try {
  state = JSON.parse(fs.readFileSync(DATA, "utf8"));
} catch {
  /* 首次运行 */
}
function persist() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state));
}
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
function rollDay() {
  const d = utcDay();
  if (state.day !== d) {
    state.day = d;
    state.issued = "0";
  }
}
function json(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(obj));
}

/** 领证前置校验：链上有余额（= 领过水或收过款）+ 额度 + 冷却 */
async function checkClaimable(address) {
  const bal = await provider.getBalance(address);
  if (bal === 0n) {
    return { ok: false, error: "该地址在联盟链上还没有余额——请先到水龙头领 10 B03 再领凭证" };
  }
  const now = Date.now();
  const key = address.toLowerCase();
  const last = state.lastClaim[key] || 0;
  if (now - last < COOLDOWN_MS) {
    return { ok: false, error: `冷却中，请 ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)} 秒后再领` };
  }
  rollDay();
  if (BigInt(state.issued || "0") >= DAILY_QUOTA) {
    return { ok: false, error: `今日凭证配额已用完（每日 ${DAILY_QUOTA} 份），明日 UTC 0 点重置` };
  }
  return { ok: true, balance: ethers.formatEther(bal) };
}

/** 生成一份元数据 → 上传内网 OSS → 用 P01 出证库算根 */
async function makeMetadata(address, tokenId, purpose) {
  const body = Buffer.from(
    JSON.stringify({
      id: tokenId,
      holder: address,
      kind: "lab-credential",
      purpose,
      issuedAt: Math.floor(Date.now() / 1000),
      chain: "consortium-qbft",
      note: "联盟内权益凭证（元数据存内网对象存储，链上只存 Merkle 根）",
    })
  );
  const cid = await ipfsAddDir([{ name: `${tokenId}.json`, body }]);
  const baseURI = `${OSS_GATEWAY}/ipfs/${cid}/`;
  const root = merkle.buildTree([body]).root;
  return { baseURI, root, uri: `${baseURI}${tokenId}.json` };
}

/** 发一份凭证（登记成员 → 铸造 → 回执） */
async function issue(address, purpose) {
  const tokenId = await cred.nextId(); // 先取 id，元数据文件名与链上 id 对齐
  const meta = await makeMetadata(address, tokenId.toString(), purpose);
  const wasMember = await cred.isMember(address);
  if (!wasMember) {
    const tx = await cred.setMember(address, true, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
    await tx.wait();
  }
  const tx = await cred.mintBatch(address, 1, meta.baseURI, meta.root, 0, true, { gasLimit: 500000n, gasPrice: 0n, type: 0 });
  const rec = await tx.wait();
  return {
    tokenId: tokenId.toString(),
    txHash: tx.hash,
    block: rec.blockNumber,
    gasUsed: rec.gasUsed.toString(),
    metadataUri: meta.uri,
    merkleRoot: meta.root,
    memberRegistered: !wasMember,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    try {
      const bn = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("探链超时")), 3000)),
      ]);
      return json(res, 200, { ok: true, issuer: issuer.address, contract: dep.credential, chain: "ok", blockNumber: bn });
    } catch (e) {
      return json(res, 503, { ok: false, chain: "down", error: e.message });
    }
  }
  if (req.method === "GET" && req.url === "/status") {
    rollDay();
    return json(res, 200, {
      ok: true,
      issuer: issuer.address,
      contract: dep.credential,
      chainId: CHAIN_ID,
      dayIssued: state.issued,
      dayQuota: DAILY_QUOTA.toString(),
      nextId: (await cred.nextId()).toString(),
    });
  }
  if (req.method !== "POST" || !req.url.startsWith("/")) {
    return json(res, 404, { error: "only GET /health|GET /status|POST /claim|POST /issue" });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 4096) req.destroy();
  });
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch (e) {
      return json(res, 400, { error: "请求体不是 JSON" });
    }
    const address = String(body.address || "").trim();
    const purpose = String(body.purpose || "member-onboarding").slice(0, 60);
    if (!ethers.isAddress(address)) return json(res, 400, { error: "地址非法（需 0x 开头 42 字符）" });

    try {
      // 独立领证也要走前置校验；运营方强制发证用 /issue（跳过余额检查，但要求已在册或由本服务登记）
      const isIssue = req.url.startsWith("/issue");
      if (!isIssue) {
        const chk = await checkClaimable(address);
        if (!chk.ok) return json(res, 429, { error: chk.error });
      } else {
        rollDay();
        if (BigInt(state.issued || "0") >= DAILY_QUOTA) {
          return json(res, 429, { error: `今日凭证配额已用完（每日 ${DAILY_QUOTA} 份）` });
        }
      }

      const result = await issue(address, purpose);
      const key = address.toLowerCase();
      state.lastClaim[key] = Date.now();
      state.issued = (BigInt(state.issued || "0") + 1n).toString();
      persist(); // 广播即记账，防重启重复发放
      return json(res, 200, {
        ok: true,
        address,
        ...result,
        dayIssued: state.issued,
        note: "QBFT 单块终结：入块即最终；凭证元数据在内网对象存储，链上只存 Merkle 根",
      });
    } catch (e) {
      console.error("issue 失败:", e.shortMessage || e.message);
      return json(res, 500, { error: e.shortMessage || e.message });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `B07 发证服务 127.0.0.1:${PORT}  issuer=${issuer.address}  contract=${dep.credential}  每日配额=${DAILY_QUOTA} 份`
  );
});
