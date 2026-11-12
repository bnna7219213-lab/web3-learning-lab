// B03 服务器专属水龙头：admin 签名发币，替代公共 faucet
// 启动：FAUCET_PK=0x... node server.js   （监听 127.0.0.1:8560，经 nginx /b03-faucet/ 暴露）
// 2026-10-16 加固：① 冷却落盘（进程重启不清零）② 每日总预算上限 ③ /health 探链（断链返 503）
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = 8560;
const RPC = "http://127.0.0.1:8551";
const CHAIN_ID = 19880601;
const AMOUNT = ethers.parseEther("10");          // 每次 10 B03
const COOLDOWN_MS = 60_000;                      // 同一地址 60s 冷却
const DAILY_BUDGET = ethers.parseEther("500");   // 每日总预算 500 B03（UTC 日切）
const DATA = process.env.FAUCET_DATA || path.join(__dirname, "data", "claims.json");
// 衔接 B07 权益凭证：配置后「领币」成功即回调发证服务，一次领取同时得到余额与凭证。
// 发证失败**不阻断领币**（币已经发出去了，不能因为凭证服务挂了让人拿不到钱）。
const CREDENTIAL_URL = (process.env.CREDENTIAL_URL || "").replace(/\/+$/, "");

const PK = process.env.FAUCET_PK;
if (!PK) { console.error("缺 FAUCET_PK"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const faucet = new ethers.Wallet(PK, provider);

// ---- 冷却与预算（落盘：进程重启不清零，防「重启清冷却」被薅）----
let state = { lastClaim: {}, day: null, spent: "0" };
try { state = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch { /* 首次运行 */ }
function persist() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state));
}
function utcDay() { return new Date().toISOString().slice(0, 10); }
function rollDay() {
  const d = utcDay();
  if (state.day !== d) { state.day = d; state.spent = "0"; }
}

function json(res, code, obj) {
  if (res.headersSent || res.writableEnded) return; // 防重复响应导致进程崩溃
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
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
      return json(res, 200, { ok: true, faucet: faucet.address, chain: "ok", blockNumber: bn });
    } catch (e) {
      return json(res, 503, { ok: false, faucet: faucet.address, chain: "down", error: e.message });
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

      const now = Date.now();
      const key = address.toLowerCase();
      const last = state.lastClaim[key] || 0;
      if (now - last < COOLDOWN_MS) {
        return json(res, 429, { error: `冷却中，请 ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)} 秒后再领` });
      }

      // 每日总预算（UTC 日切）
      rollDay();
      if (BigInt(state.spent || "0") + AMOUNT > DAILY_BUDGET) {
        return json(res, 429, { error: "今日发放总额度已用完（每日 500 B03），明日 UTC 0 点重置" });
      }

      const bal = await provider.getBalance(faucet.address);
      if (bal < AMOUNT) return json(res, 503, { error: "水龙头余额不足（运营方需充值）" });

      const tx = await faucet.sendTransaction({ to: address, value: AMOUNT, gasLimit: 21000n });
      state.lastClaim[key] = now;
      state.spent = (BigInt(state.spent || "0") + AMOUNT).toString();
      persist();                                  // 广播即记账（防止成功后崩溃导致重复发放）
      const rec = await tx.wait();

      // 衔接 B07：领币成功后回调发证服务（登记成员 + 发行凭证）
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
        amount: ethers.formatEther(AMOUNT),
        txHash: tx.hash,
        block: rec.blockNumber,
        from: faucet.address,
        dailySpent: ethers.formatEther(BigInt(state.spent)),
        dailyBudget: ethers.formatEther(DAILY_BUDGET),
        credential, // 有配置发证服务时返回凭证信息；没有则为 null
        note: "QBFT 单块终结：入块即最终",
      });
    } catch (e) {
      console.error("claim 失败:", e.message);
      json(res, 500, { error: e.shortMessage || e.message });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`B03 faucet 听在 127.0.0.1:${PORT}  管理账户=${faucet.address}  每次=${ethers.formatEther(AMOUNT)} B03  每日预算=${ethers.formatEther(DAILY_BUDGET)} B03`);
});
