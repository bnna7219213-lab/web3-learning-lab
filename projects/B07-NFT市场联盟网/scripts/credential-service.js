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
//
// 2026-11-13 预算治理衔接（B03 × B07）：判定口径全部换成**链上事实**：
//   · 每日凭证配额：当日已发份数 = 链上 CredentialIssued 事件累计（chainIssuedToday），
//     本地 issued 记账降级为审计流水 —— 改本地文件不能突破配额；
//   · 水龙头预算联动：凭证是「领币」的配对权益，水龙头当日额度不够发一份 10 B03 时，
//     暂停发证（chainFaucetBudget 读的是链上 dailyInfo）；
//   · 同地址冷却：仍是服务侧防抖（软约束，非安全边界；真正的边界是上面两条链上事实）。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  PROJECT,
  REPO,
  cfg,
  deployment,
  abi,
  ipfsAddDir,
  chainIssuedToday,
  chainIssuedIntegrity,
  chainFaucetBudget,
} = require("./lib/b07");
const merkle = require(path.join(REPO, "shared", "evidence", "lib", "merkle-indexed.js"));

const PORT = Number(process.env.CREDENTIAL_PORT || 8580);
const RPC = process.env.CREDENTIAL_RPC || cfg().RPC_URL || "http://127.0.0.1:8551";
const CHAIN_ID = Number(cfg().CHAIN_ID || 19880601);
// 私钥来源：优先环境变量（会 trim —— 命令行传参容易带上尾随空格，ethers 会直接拒），
// 否则读 env/.env.local（本地不入库）
const ISSUER_PK = String(process.env.ISSUER_PRIVATE_KEY || cfg().ISSUER_PRIVATE_KEY || "").trim();
// 发证服务专用签发账户（2026-11-13 预算治理）：
//   与运营方 ISSUER 分开 —— 链上派生「当日服务发放份数」时，才能把用户领取路径的发放
//   与运营方批量发行（一次 1000 份）分开统计，批量发行不会占满用户路径的当日配额。
//   该账户的 MINTER_ROLE / DEFAULT_ADMIN_ROLE 由 scripts/11-grant-service-issuer.js 授予。
const SERVICE_ISSUER_PK = String(
  process.env.SERVICE_ISSUER_PRIVATE_KEY || cfg().SERVICE_ISSUER_PRIVATE_KEY || ISSUER_PK
).trim();
const COOLDOWN_MS = 60_000;
const DAILY_QUOTA = BigInt(process.env.CREDENTIAL_DAILY_QUOTA || 100); // 每日 100 份
const DATA = process.env.CREDENTIAL_DATA || path.join(PROJECT, "scripts", "data", "credential-claims.json");
const OSS_GATEWAY = process.env.OSS_GATEWAY || "http://127.0.0.1:8088";

if (!ISSUER_PK) {
  console.error("缺 ISSUER_PRIVATE_KEY（应放在 env/.env.local）");
  process.exit(1);
}
if (!SERVICE_ISSUER_PK) {
  console.error("缺 SERVICE_ISSUER_PRIVATE_KEY（应放在 env/.env.local）");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const issuer = new ethers.Wallet(SERVICE_ISSUER_PK, provider); // 服务签发账户
const dep = deployment();
const cred = new ethers.Contract(dep.credential, abi(), issuer);
// 水龙头额度合约（用于「凭证挂水龙头预算」的联动判定）；地址缺省取部署记录
const FAUCET_ADDRESS = (process.env.CREDENTIAL_FAUCET || dep.faucet || "").trim();
// 服务签发地址：链上按 issuer 维度统计当日发放份数时用它做过滤
const SERVICE_ISSUER_ADDRESS = issuer.address;

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
  // BigInt 不能直接 JSON.stringify（链上额度/用量都是 BigInt）→ 统一转字符串
  const body = JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

/** 领证前置校验：链上事实为准（余额 / 当日已发份数 / 水龙头当日额度）+ 服务侧防抖冷却 */
async function checkClaimable(address) {
  const bal = await provider.getBalance(address);
  if (bal === 0n) {
    return { ok: false, error: "该地址在联盟链上还没有余额——请先到水龙头领 10 B03 再领凭证" };
  }

  // 1) 每日凭证配额：链上派生（当日由**本服务签发账户**签发的份数），本地 issued 不参与判定
  const issued = await chainIssuedToday(provider, dep.credential, SERVICE_ISSUER_ADDRESS);
  if (issued.errors && issued.errors.length) {
    return { ok: false, error: `链上用量读取失败（日志分片报错）：${issued.errors[0]}` };
  }
  if (issued.issued >= DAILY_QUOTA) {
    return {
      ok: false,
      error: `今日凭证配额已用完（链上已发 ${issued.issued}/${DAILY_QUOTA} 份），明日 UTC 0 点重置`,
    };
  }

  // 2) 水龙头预算联动：凭证是「领币」的配对权益 —— 水龙头当日额度不够发一份，就暂停发证
  let faucetBudget = null;
  if (FAUCET_ADDRESS) {
    try {
      faucetBudget = await chainFaucetBudget(provider);
      if (faucetBudget.remaining < faucetBudget.amountPerClaim) {
        return {
          ok: false,
          error:
            `水龙头今日额度已用完（链上剩余 ${ethers.formatEther(faucetBudget.remaining)} B03，` +
            `单次需 ${ethers.formatEther(faucetBudget.amountPerClaim)} B03），暂停发证`,
        };
      }
    } catch (e) {
      return { ok: false, error: `读取水龙头链上额度失败：${e.shortMessage || e.message}` };
    }
  }

  // 3) 同地址冷却（服务侧防抖，软约束：真边界在上面两条链上事实）
  const now = Date.now();
  const key = address.toLowerCase();
  const last = state.lastClaim[key] || 0;
  if (now - last < COOLDOWN_MS) {
    return { ok: false, error: `冷却中，请 ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)} 秒后再领` };
  }

  return {
    ok: true,
    balance: ethers.formatEther(bal),
    issuedToday: issued.issued.toString(),
    dayIssuedLimit: DAILY_QUOTA.toString(),
    faucetBudget,
  };
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
    // 注意：这个分支必须自己兜住异常 —— 异步处理里抛出去会变成 unhandledRejection，
    // Node 会直接结束进程（曾因此把发证服务打死过一次）。
    try {
      rollDay();
      const issued = await chainIssuedToday(provider, dep.credential, SERVICE_ISSUER_ADDRESS);
      const issuedAll = await chainIssuedToday(provider, dep.credential);
      const integrity = await chainIssuedIntegrity(provider, dep.credential, cred);
      let faucetBudget = null;
      if (FAUCET_ADDRESS) {
        try {
          faucetBudget = await chainFaucetBudget(provider);
        } catch (e) {
          faucetBudget = { error: e.shortMessage || e.message };
        }
      }
      return json(res, 200, {
        ok: true,
        issuer: issuer.address,
        contract: dep.credential,
        chainId: CHAIN_ID,
        // 链上派生（判定依据）
        dayIssued: issued.issued.toString(),
        dayIssuedByService: issued.issued.toString(),
        dayIssuedAllIssuers: issuedAll.issued.toString(),
        serviceIssuer: SERVICE_ISSUER_ADDRESS,
        dayQuota: DAILY_QUOTA.toString(),
        dayIssuedFromBlock: issued.fromBlock,
        dayIssuedToBlock: issued.toBlock,
        integrity: { logCount: integrity.logCount.toString(), nextId: integrity.nextId.toString(), ok: integrity.ok },
        faucet: FAUCET_ADDRESS || null,
        faucetBudget,
        // 本地审计流水（不参与判定）
        audit: { dayIssued: state.issued, note: "本地记账只是审计，判定看 dayIssued（链上）" },
        nextId: (await cred.nextId()).toString(),
      });
    } catch (e) {
      console.error("status 失败:", e.shortMessage || e.message);
      return json(res, 503, { ok: false, error: e.shortMessage || e.message });
    }
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
        // 运营方强制发证：同样受链上当日配额约束（额度是链上事实，本地记账不算数）
        const issued = await chainIssuedToday(provider, dep.credential, SERVICE_ISSUER_ADDRESS);
        if (issued.errors && issued.errors.length) {
          return json(res, 503, { error: `链上用量读取失败：${issued.errors[0]}` });
        }
        if (issued.issued >= DAILY_QUOTA) {
          return json(res, 429, { error: `今日凭证配额已用完（链上已发 ${issued.issued}/${DAILY_QUOTA} 份）` });
        }
      }

      const result = await issue(address, purpose);
      const key = address.toLowerCase();
      state.lastClaim[key] = Date.now();
      state.issued = (BigInt(state.issued || "0") + 1n).toString();
      persist(); // 本地只是审计流水（不参与判定）
      // 链上派生的当日已发份数（判定口径；本地 issued 不算数）
      const after = await chainIssuedToday(provider, dep.credential, SERVICE_ISSUER_ADDRESS);
      return json(res, 200, {
        ok: true,
        address,
        ...result,
        dayIssued: after.issued.toString(), // 链上口径
        dayIssuedLocal: state.issued, // 本地审计口径
        note: "QBFT 单块终结：入块即最终；凭证元数据在内网对象存储，链上只存 Merkle 根；配额与水龙头额度均按链上事实判定",
      });
    } catch (e) {
      console.error("issue 失败:", e.shortMessage || e.message);
      return json(res, 500, { error: e.shortMessage || e.message });
    }
  });
});

// 兜底：异步处理里漏出的异常不能把服务打死（曾因 /status 抛错导致进程退出）
process.on("unhandledRejection", (e) => console.error("未处理的 Promise 异常:", (e && e.stack) || e));
process.on("uncaughtException", (e) => console.error("未捕获异常:", (e && e.stack) || e));

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `B07 发证服务 127.0.0.1:${PORT}  issuer=${issuer.address}  contract=${dep.credential}  每日配额=${DAILY_QUOTA} 份（链上派生）`
  );
  console.log(`  水龙头额度联动：${FAUCET_ADDRESS || "（未配置，不做联动）"}`);
  console.log(`  服务签发账户：${SERVICE_ISSUER_ADDRESS}（当日配额只统计它签发的份数）`);
});
