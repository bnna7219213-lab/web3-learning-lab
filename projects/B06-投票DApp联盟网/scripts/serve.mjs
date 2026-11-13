// scripts/serve.mjs —— BFF + 多成员前端（后端代签，不依赖 MetaMask）
//
// 联盟网语义：MetaMask 在零 gas 链上会按非零 baseFee 校验而拒绝/异常（差异矩阵 §2）。
// 交付口径是「后端代签」：成员身份由前端切换，交易由 BFF 用对应成员的密钥构造并显式
// `gasPrice=0 / type=0` 发出（等价于 viem 显式 maxFeePerGas=0 的语义）；密钥不出服务器。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { RPC, cfg, ROOT, CHAIN_ID } from "./lib.mjs";

const PORT = Number(process.env.PORT || 8803);
const FRONTEND = path.join(ROOT, "frontend");
const GAS = { gasLimit: 300000n, gasPrice: 0n, type: 0 };

const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "latest.json"), "utf8"));
const artAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "abi", "ApprovalFlow.json"), "utf8"));
const c = cfg();
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const flow = new ethers.Contract(dep.approvalFlow, artAbi, provider);

const MEMBERS = {
  A: { label: "成员 A（提案人/复核人）", wallet: new ethers.Wallet(c.MEMBER_A_PRIVATE_KEY, provider) },
  B: { label: "成员 B（提案人/复核人）", wallet: new ethers.Wallet(c.MEMBER_B_PRIVATE_KEY, provider) },
  admin: { label: "管理员（执行人）", wallet: new ethers.Wallet(c.ISSUER_PRIVATE_KEY, provider) },
  outsider: { label: "外部账户（无角色）", wallet: new ethers.Wallet(c.OUTSIDER_PRIVATE_KEY, provider) },
};

const STATE_NAMES = ["None", "Pending", "Approved", "Rejected", "Revoked", "Executed"];

function json(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function listProposals() {
  const count = Number(await flow.proposalCount());
  const head = await provider.getBlockNumber();
  const from = Math.max(0, head - 4000); // Besu getLogs 5000 块上限
  const evs = await flow.queryFilter(flow.filters.Proposed(), from, "latest");
  const out = [];
  for (let id = 0; id < count; id++) {
    const p = await flow.getProposal(id);
    out.push({
      id,
      title: p.title,
      proposer: p.proposer,
      reviewer: p.reviewer,
      target: p.target,
      value: p.value.toString(),
      state: STATE_NAMES[Number(p.state)],
      stateCode: Number(p.state),
      executeAfter: Number(p.executeAfter),
      createdAt: (evs.find((e) => e.args.id === BigInt(id))?.blockNumber ?? null),
    });
  }
  return out.reverse();
}

// 每个动作的参数组装；预检用 staticCall（只读、拿可读原因），发送只发一次
const ARGV = {
  propose: (w, b) => [b.target || w.address, BigInt(b.value || 0), b.data || "0x", b.title || "未命名提案"],
  approve: (w, b) => [Number(b.id)],
  reject: (w, b) => [Number(b.id), b.reason || "驳回"],
  revoke: (w, b) => [Number(b.id)],
  execute: (w, b) => [Number(b.id)],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/config") {
      return json(res, 200, {
        ok: true,
        contract: dep.approvalFlow,
        delaySeconds: dep.delaySeconds,
        members: Object.fromEntries(Object.entries(MEMBERS).map(([k, m]) => [k, { label: m.label, address: m.wallet.address }])),
        states: STATE_NAMES,
      });
    }
    if (url.pathname === "/api/proposals") {
      return json(res, 200, { ok: true, data: await listProposals() });
    }
    if (url.pathname === "/api/act" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const b = JSON.parse(body || "{}");
      const m = MEMBERS[b.member];
      const argsFn = ARGV[b.action];
      if (!m || !argsFn) return json(res, 400, { ok: false, error: "unknown member/action" });
      const args = argsFn(m.wallet, b);
      // 预检拿可读原因（前端展示）；无论预检结果如何都真发一笔——
      // 失败交易 status=0 入块就是链上留痕（B07 双路口径）
      let reason = "";
      try {
        await flow.connect(m.wallet)[b.action].staticCall(...args, GAS);
      } catch (e) {
        try {
          const p = flow.interface.parseError(e.data ?? e.info?.error?.data ?? "0x");
          reason = p ? `${p.name}(${p.args.map(String).join(", ")})` : String(e.shortMessage || e.message);
        } catch {
          reason = String(e.shortMessage || e.message);
        }
      }
      let receipt = null;
      try {
        receipt = await (await flow.connect(m.wallet)[b.action](...args, GAS)).wait();
      } catch (e) {
        receipt = e.receipt ?? null;
      }
      return json(res, 200, {
        ok: !!(receipt && receipt.status === 1),
        status: receipt ? Number(receipt.status) : null,
        txHash: receipt?.hash ?? null,
        block: receipt?.blockNumber ?? null,
        reason,
      });
    }
    // 静态前端
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(FRONTEND, path.normalize(file).replace(/^([/\\])+/, ""));
    if (full.startsWith(FRONTEND) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[path.extname(full)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(full));
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[b06] 审批台 http://127.0.0.1:${PORT}  合约 ${dep.approvalFlow}  delay=${dep.delaySeconds}s`);
  for (const [k, m] of Object.entries(MEMBERS)) console.log(`  ${k.padEnd(9)} ${m.label} ${m.wallet.address}`);
});
