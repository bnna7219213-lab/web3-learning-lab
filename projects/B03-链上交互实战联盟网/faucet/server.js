// B03 服务器专属水龙头：每日额度由链上合约 LabFaucet 强制
//
// 2026-10-16 加固：① 冷却落盘（进程重启不清零）② 每日总预算上限 ③ /health 探链（断链返 503）
// 2026-11-13 预算治理上链（B03 × B07 衔接）：每日额度不再由本进程的常量 + 本地 JSON 记账决定，
//   而是交给链上额度合约 LabFaucet 强制：
//   · 「今日已发放多少」= 链上状态（spentByDay），eth_call 一次读到，任何人可用同一 RPC 复核；
//   · 「今日还能发多少」= 链上状态（cap - spent），额度用尽由合约 revert，服务绕不过去；
//   · 每地址冷却同样在链上，重启服务不再清零冷却；
//   · 本地 data/claims.json 降级为**审计流水**（谁在什么时候领了多少），不再参与额度判定；
//   · 治理参数（每日额度/单次金额/冷却）由 admin 在链上可改，改动留事件痕迹。
//
//   为什么必须上链（实测结论）：Besu 侧历史状态被剪枝（只有 latest 可读），原生转账又不产生日志，
//   服务端**没有可靠办法**从链上回算「当日已发放」；若额度仍由本地记账决定，改一下本地文件
//   就能重置额度。详见 projects/B07-NFT市场联盟网/docs/02-预算治理衔接.md。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = Number(process.env.FAUCET_PORT || 8560);
const RPC = process.env.FAUCET_RPC || "http://127.0.0.1:8551";
const CHAIN_ID = 19880601;
const DATA = process.env.FAUCET_DATA || path.join(__dirname, "data", "claims.json");
const ABI_PATH = process.env.FAUCET_ABI || path.join(__dirname, "abi", "LabFaucet.json");

function defaultContractAddress() {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "deployment.json"), "utf8").replace(/^\uFEFF/, ""));
    return rec.faucet || "";
  } catch (e) {
    return "";
  }
}
const FAUCET_CONTRACT = (process.env.FAUCET_CONTRACT || defaultContractAddress()).trim();
const CREDENTIAL_URL = (process.env.CREDENTIAL_URL || "").replace(/\/+$/, "");

const PK = process.env.FAUCET_PK;
if (!PK) { console.error("缺 FAUCET_PK"); process.exit(1); }
if (!FAUCET_CONTRACT) { console.error("缺额度合约地址（FAUCET_CONTRACT 或 faucet/deployment.json）"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const operator = new ethers.Wallet(PK, provider);
const faucetAbi = JSON.parse(fs.readFileSync(ABI_PATH, "utf8").replace(/^\uFEFF/, ""));
const faucet = new ethers.Contract(FAUCET_CONTRACT, faucetAbi, operator);

// ---- 审计流水（落盘）：谁在什么时候领了多少。**不参与额度判定**，额度只看链上 ----
let state = { claims: [] };
try { state = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch { /* 首次运行 */ }
if (!Array.isArray(state.claims)) state.claims = [];
function persist() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state));
}
function utcDay() { return new Date().toISOString().slice(0, 10); }

function json(res, code, obj) {
  if (res.headersSent || res.writableEnded) return; // 防重复响应导致进程崩溃
  // BigInt 不能直接 JSON.stringify（链上额度都是 BigInt）→ 统一转字符串
  const body = JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

/** 链上当日额度事实：唯一权威口径 */
async function chainBudget() {
  const [day, spent, remaining, cap, amountPerClaim, balance] = await faucet.dailyInfo();
  return {
    day: Number(day),
    spent,
    remaining,
    cap,
    amountPerClaim,
    contractBalance: balance,
    source: "chain", // 关键：额度口径来自链上，不是本地记账
  };
}

/** 合约 revert 的错误翻译成人话（服务只做翻译，不做判定） */
function explainChainError(err) {
  const msg = err && (err.shortMessage || err.message) ? err.shortMessage || err.message : String(err);
  if (/DailyCapExceeded/.test(msg)) return "今日发放总额度已用完（链上额度上限），明日 UTC 0 点重置";
  if (/CooldownActive/.test(msg)) return "冷却中，请稍后再领";
  if (/InsufficientBalance/.test(msg)) return "水龙头合约余额不足（运营方需充值）";
  if (/InvalidAddress/.test(msg)) return "地址非法";
  if (/InvalidPolicy/.test(msg)) return "额度策略非法";
  return msg;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  // 健康检查：探链（eth_blockNumber，3s 超时），断链返 503——不再用静态 200 掩盖链故障
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    try {
      const bn = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("探链超时")), 3000)),
      ]);
      return json(res, 200, {
        ok: true,
        faucet: FAUCET_CONTRACT,
        operator: operator.address,
        chain: "ok",
        blockNumber: bn,
      });
    } catch (e) {
      return json(res, 503, { ok: false, faucet: FAUCET_CONTRACT, chain: "down", error: e.message });
    }
  }

  // 额度总览：链上事实 + 本地审计流水（两者分开摆，别让人误以为本地记账就是额度依据）
  if (req.method === "GET" && req.url.startsWith("/status")) {
    try {
      const budget = await chainBudget();
      const today = utcDay();
      const localToday = state.claims.filter((c) => c && c.day === today);
      const localAmount = localToday.reduce((s, c) => s + Number(c.amount || 0), 0);
      return json(res, 200, {
        ok: true,
        faucet: FAUCET_CONTRACT,
        operator: operator.address,
        chainId: CHAIN_ID,
        budget,
        audit: {
          day: today,
          claims: localToday.length,
          amount: localAmount,
          note: "本地流水只用于审计，额度判定看 budget（链上）",
        },
      });
    } catch (e) {
      return json(res, 503, { ok: false, error: e.message });
    }
  }

  if (req.method !== "POST" || !req.url.startsWith("/claim")) {
    return json(res, 404, { error: "only POST /claim" });
  }

  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on("end", async () => {
    try {
      const { address } = JSON.parse(raw || "{}");
      if (!ethers.isAddress(address)) return json(res, 400, { error: "地址非法（需 0x 开头 42 字符）" });

      // 1) 先读链上事实：额度与冷却都在链上判定（claimable 给出原因码）
      const [canClaim, waitSeconds, remaining, reason] = await faucet.claimable(address);
      if (!canClaim) {
        const why = {
          1: "地址非法",
          2: "水龙头已暂停发放（链上策略 dailyCap=0）",
          3: "今日发放总额度已用完（链上额度上限），明日 UTC 0 点重置",
          4: `冷却中，请 ${waitSeconds} 秒后再领`,
          5: "水龙头合约余额不足（运营方需充值）",
        }[Number(reason)] || "当前不可领取";
        return json(res, 429, {
          error: why,
          reasonCode: Number(reason),
          remaining: ethers.formatEther(remaining),
        });
      }

      // 2) 领取（链上转账，额度与冷却由合约强制）
      const tx = await faucet.claim(address, { gasLimit: 200000n, gasPrice: 0n, type: 0 });
      const rec = await tx.wait();
      if (rec.status !== 1) return json(res, 500, { error: "领取交易上链失败（status=0）", txHash: tx.hash });

      // 3) 审计流水（落盘，不参与额度判定）
      const budget = await chainBudget();
      state.claims.push({
        day: utcDay(),
        at: new Date().toISOString(),
        address: address.toLowerCase(),
        amount: ethers.formatEther(budget.amountPerClaim),
        txHash: tx.hash,
        block: rec.blockNumber,
      });
      if (state.claims.length > 5000) state.claims = state.claims.slice(-5000);
      persist();

      // 4) 衔接 B07：领币成功后回调发证服务（登记成员 + 发行凭证）
      let credential = null;
      if (CREDENTIAL_URL) {
        try {
          const cr = await Promise.race([
            fetch(CREDENTIAL_URL + "/claim", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ address, purpose: "faucet-claim" }),
            }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
            // 超时给足：发证服务要先 setMember 再 mintBatch，两个块 ≈ 10s（5s/块）
            new Promise((_, rej) => setTimeout(() => rej(new Error("凭证服务超时（30s）")), 30000)),
          ]);
          credential =
            cr.body && cr.body.ok
              ? { ok: true, tokenId: cr.body.tokenId, txHash: cr.body.txHash, metadataUri: cr.body.metadataUri }
              : { ok: false, error: (cr.body && cr.body.error) || `凭证服务返回 HTTP ${cr.status}` };
        } catch (e) {
          credential = { ok: false, error: "凭证发放未完成（不影响已发放的币）：" + (e.message || e) };
        }
        console.log("凭证回调：", JSON.stringify(credential));
      }

      json(res, 200, {
        ok: true,
        amount: ethers.formatEther(budget.amountPerClaim),
        txHash: tx.hash,
        block: rec.blockNumber,
        from: FAUCET_CONTRACT,
        dailySpent: ethers.formatEther(budget.spent),   // 链上口径
        dailyBudget: ethers.formatEther(budget.cap),      // 链上口径
        budget,                                         // 结构化明细（source=chain）
        credential, // 有配置发证服务时返回凭证信息；没有则为 null
        note: "QBFT 单块终结：入块即最终；额度与冷却由链上合约强制",
      });
    } catch (e) {
      console.error("claim 失败:", e.message);
      // 链上 revert（额度/冷却/余额）翻译成 429，其余算服务端错误
      const msg = explainChainError(e);
      const isPolicy = /额度|冷却|余额不足|暂停/.test(msg);
      json(res, isPolicy ? 429 : 500, { error: msg });
    }
  });
});

// 兜底：异步处理里漏出的异常不能把服务打死
process.on("unhandledRejection", (e) => console.error("未处理的 Promise 异常:", (e && e.stack) || e));
process.on("uncaughtException", (e) => console.error("未捕获异常:", (e && e.stack) || e));

server.listen(PORT, "127.0.0.1", async () => {
  let line = `B03 faucet 听在 127.0.0.1:${PORT}  额度合约=${FAUCET_CONTRACT}  operator=${operator.address}`;
  try {
    const b = await chainBudget();
    line += `  每日额度=${ethers.formatEther(b.cap)} B03  单次=${ethers.formatEther(b.amountPerClaim)} B03  今日已发=${ethers.formatEther(b.spent)} B03`;
  } catch (e) {
    line += `  [额度读取失败: ${e.message}]`;
  }
  line += `  凭证回调=${CREDENTIAL_URL || "（未配置）"}`;
  console.log(line);
});
