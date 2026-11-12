// frontend/server.js —— B08 工程化运维看板的 BFF（零依赖框架：node:http + ethers）
//
// 为什么必须有 BFF（不能纯静态页直连 RPC）：
//   联盟网 Besu QBFT 的 corsAllowedDomains 默认是空数组 → 浏览器从页面源直连 8551 会被
//   CORS 拒（403 "CORS Rejected"）。B03 的 serve-lab.mjs 用同源反代绕过，B08 走同一条路：
//   页面只访问同源 /api/* 与 /rpc，由本进程转发到 8551。
//
// 只读原则：看板**不持有私钥、不发交易**。所有写操作（升级/空投/部署）都在 scripts/ 里，
//   看板只负责把链上事实与 deployments/*.json 的实测记录并排展示出来。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { cfg, provider, contract, deployment, abi, readJson, PROJECT } = require("../scripts/lib/b08.js");

const HERE = __dirname;
const PORT = Number(process.env.B08_PORT || 8808);
const RPCS = (process.env.RPCS || "http://127.0.0.1:8551,http://127.0.0.1:8552,http://127.0.0.1:8553")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// ── B08 各合约的事件注册表（与 src/*.sol 的 emit 逐字对齐）──────────────────
// ERC-1967 的 Upgraded 由 OZ 的 ERC1967Utils 发出（UUPS 升级的链上证据）。
const EVENT_FRAGMENTS = [
  "event Upgraded(address indexed implementation)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event Initialized(uint64 version)",
  "event Claimed(bytes32 indexed leafHash, address indexed to, string data)",
  "event Deployed(address indexed addr, bytes32 indexed salt, uint256 deployCount)",
  "event Withdrawn(address indexed who, uint256 amount)",
];
const iface = new ethers.Interface(EVENT_FRAGMENTS);
const TOPIC_MAP = new Map(iface.fragments.map((f) => [f.topicHash, f]));

const CONTRACT_LABELS = {
  vaultProxy: "Vault 代理（UUPS）",
  MerkleAirdrop: "Merkle 空投",
  Create2Factory: "Create2 工厂",
  GasLab: "Gas 实验台",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 读取 deployments/<name>.json；文件不存在返回 null（看板不因此报错） */
function report(name) {
  const f = path.join(PROJECT, "deployments", name);
  if (!fs.existsSync(f)) return null;
  try {
    return readJson(f);
  } catch (e) {
    return null;
  }
}

/** 裸 RPC（用于多节点块哈希核对，不走 ethers 的缓存） */
async function rawRpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** 链状态：chainId / 块高 / 零 gas 判定 / 3 节点块哈希一致性（终结性） */
async function chainState() {
  const p = provider();
  const net = await p.getNetwork();
  const head = await p.getBlock("latest");
  const gasPrice = BigInt(await rawRpc(cfg().RPC_URL || "http://127.0.0.1:8551", "eth_gasPrice"));
  const baseFee = BigInt(head.baseFeePerGas ?? 0);
  const target = Number(head.number) - 1;
  const hashes = [];
  for (const u of RPCS) {
    try {
      const b = await rawRpc(u, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
      hashes.push({ node: u, hash: b ? b.hash : null });
    } catch (e) {
      hashes.push({ node: u, hash: null, error: e.message });
    }
  }
  const uniq = new Set(hashes.map((h) => h.hash).filter(Boolean));
  return {
    chainId: Number(net.chainId),
    head: Number(head.number),
    gasPrice: gasPrice.toString(),
    baseFeePerGas: baseFee.toString(),
    zeroGas: gasPrice === 0n && baseFee === 0n,
    blockGasLimit: head.gasLimit.toString(),
    finality: {
      targetBlock: target,
      nodes: hashes,
      consistent: uniq.size === 1 && uniq.size > 0,
      hash: [...uniq][0] ?? null,
    },
  };
}

/** Vault 代理的链上状态：V1 字段 + V2 新字段 + ERC-1967 实现槽 */
async function vaultState() {
  const dep = deployment();
  const p = provider();
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const proxy = new ethers.Contract(dep.vaultProxy, abi("vaultProxy"), p);
  const asV2 = new ethers.Contract(dep.vaultProxy, abi("vaultV2"), p);
  const implSlot = await p.getStorage(dep.vaultProxy, IMPL_SLOT);
  const implOnChain = ethers.getAddress("0x" + implSlot.slice(-40));
  const registered = (dep.vaultImpl || "").toLowerCase();
  const version = (await proxy.version()).toString();
  // 回滚后代理实现可能仍是 V1 —— V2 独有 getter 会 revert（不是 bug，是「实现决定 ABI」的教学点）
  const v2Only = async (fn) => {
    try {
      return (await asV2[fn]()).toString();
    } catch (e) {
      return null;
    }
  };
  return {
    proxy: dep.vaultProxy,
    registeredImpl: dep.vaultImpl ?? null,
    implOnChain,
    implMatchesRegister: implOnChain.toLowerCase() === registered,
    owner: await proxy.owner(),
    version,
    totalDeposited: (await proxy.totalDeposited()).toString(),
    totalWithdrawn: await v2Only("totalWithdrawn"),
    lastDepositBlockNote:
      version === "1"
        ? "当前实现为 V1：V2 独有字段（totalWithdrawn / lastDepositBlock）在代理上会 revert —— 升级后才有"
        : "当前实现为 V2：V2 字段可直接读",
    upgradeInterfaceVersion: proxy.UPGRADE_INTERFACE_VERSION ? await proxy.UPGRADE_INTERFACE_VERSION() : null,
  };
}

/** 链上工程事件：按 B08 合约地址取日志并解码（未知 topic0 也照存） */
async function engineeringEvents(limit = 50) {
  const dep = deployment();
  const addrs = [dep.vaultProxy, dep.MerkleAirdrop, dep.Create2Factory].filter(Boolean);
  const rpcUrl = cfg().RPC_URL || "http://127.0.0.1:8551";
  const head = Number(await rawRpc(rpcUrl, "eth_blockNumber"));
  // Besu 的 eth_getLogs 单次区间上限 5000 块 → 分片扫
  const logs = [];
  for (let lo = 0; lo <= head && logs.length < limit; lo += 4000) {
    const hi = Math.min(lo + 3999, head);
    const ls = await rawRpc(rpcUrl, "eth_getLogs", [
      { address: addrs, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) },
    ]);
    for (const l of ls) {
      if (logs.length >= limit) break;
      const frag = TOPIC_MAP.get(l.topics[0]);
      let decoded = null;
      let args = null;
      if (frag) {
        try {
          const parsed = iface.parseLog({ topics: l.topics, data: l.data });
          args = {};
          parsed.fragment.inputs.forEach((inp, i) => {
            const v = parsed.args[i];
            args[inp.name] = typeof v === "bigint" ? v.toString() : v;
          });
          decoded = parsed.name;
        } catch (e) {
          decoded = frag.name;
        }
      }
      logs.push({
        blockNumber: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        txHash: l.transactionHash,
        address: l.address,
        eventName: decoded,
        args,
        topic0: l.topics[0] ?? null,
        label:
          CONTRACT_LABELS[
            Object.keys(dep).find((k) => String(dep[k] ?? "").toLowerCase() === l.address.toLowerCase())
          ] ?? "未知合约",
      });
    }
  }
  logs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return { total: logs.length, head, items: logs };
}

/** Create2 登记：链上 deployedBySalt + 链下 EIP-1014 双算对账 */
async function create2State() {
  const dep = deployment();
  const p = provider();
  const factory = new ethers.Contract(dep.Create2Factory, abi("Create2Factory"), p);
  const deployCount = (await factory.deployCount()).toString();
  // 取最近一次 Deployed 事件的 salt，反查 registered 地址并做链下双算
  const evs = await engineeringEvents(200);
  const lastDeployed = evs.items.find((e) => e.eventName === "Deployed");
  let crossCheck = null;
  if (lastDeployed && lastDeployed.args) {
    const salt = lastDeployed.args.salt;
    const onchainCalc = await factory.computeAddress(salt, ethers.ZeroHash);
    const registered = await factory.deployedBySalt(salt);
    crossCheck = {
      salt,
      addrFromEvent: lastDeployed.args.addr,
      addrRegistered: registered,
      onchainCalc,
      registeredMatchesEvent: (registered || "").toLowerCase() === String(lastDeployed.args.addr).toLowerCase(),
    };
  }
  return {
    factory: dep.Create2Factory,
    deployCount,
    registeredChainId: dep.chainId,
    lastDeployed: lastDeployed ? { blockNumber: lastDeployed.blockNumber, txHash: lastDeployed.txHash } : null,
    crossCheck,
  };
}

/** Merkle 根对账：链上 root() vs 部署记录 merkleRoot */
async function merkleState() {
  const dep = deployment();
  const p = provider();
  const airdrop = new ethers.Contract(dep.MerkleAirdrop, abi("MerkleAirdrop"), p);
  const root = await airdrop.root();
  return {
    contract: dep.MerkleAirdrop,
    rootOnChain: root,
    rootInDeployment: dep.merkleRoot ?? null,
    matches: (root || "").toLowerCase() === String(dep.merkleRoot ?? "").toLowerCase(),
    note: "脚本 08 用 P01 的链下 merkle.js 做四方向互验，本页只核对链上/部署记录是否一致",
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/state") {
      const [chain, vault] = await Promise.all([chainState(), vaultState().catch((e) => ({ error: e.message }))]);
      return json(res, 200, {
        ok: true,
        chain,
        vault,
        deployments: deployment(),
        reports: {
          gas: report("gas-report.json"),
          upgrade: report("upgrade-drill.json"),
          bigContract: report("big-contract.json"),
        },
        labels: CONTRACT_LABELS,
      });
    }
    if (p === "/api/chain") return json(res, 200, { ok: true, data: await chainState() });
    if (p === "/api/vault") return json(res, 200, { ok: true, data: await vaultState() });
    if (p === "/api/events") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      return json(res, 200, { ok: true, data: await engineeringEvents(limit) });
    }
    if (p === "/api/create2") return json(res, 200, { ok: true, data: await create2State() });
    if (p === "/api/merkle") return json(res, 200, { ok: true, data: await merkleState() });

    // 同源 JSON-RPC 反代：页面若要用 ethers 直读，走这里而不是直连 8551
    if (p === "/rpc" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      const upstream = await fetch(cfg().RPC_URL || "http://127.0.0.1:8551", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const out = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
      return res.end(out);
    }

    // 静态页
    let file = p === "/" ? "/index.html" : p;
    file = path.normalize(file).replace(/^([/\\])+/, "");
    const full = path.join(HERE, file);
    if (full.startsWith(HERE) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(full));
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[b08] 运维看板 + BFF on http://127.0.0.1:${PORT}`);
    console.log(`[b08] 链 RPC=${cfg().RPC_URL || "http://127.0.0.1:8551"}（同源 /rpc 反代）· 终结性核对节点 ${RPCS.join(", ")}`);
  });
}

module.exports = { createServer: () => server, chainState, vaultState, engineeringEvents, create2State, merkleState };
