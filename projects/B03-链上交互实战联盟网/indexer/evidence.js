// B03 联盟链的出证适配器：把 shared/evidence 的算法核心接到这条链上。
//
// 锚点做法（不需要部署合约）：发一笔 value=0、gasPrice=0 的旧式交易，
// input = 0x45564944 ‖ merkleRoot（前 4 字节是 ASCII "EVID"，用来把这批交易和别的区分开）。
// 于是"根在链上"这件事的可验证形式就是：任意节点上 eth_getTransactionByHash(txHash)
// 取回的 input 字段等于 0x45564944+root，且 receipt.status==1。
//
// 为什么这样成立：B04 实测过零 gas 链上 value=0 的交易**不需要账户有任何余额**
// （intrinsic cost = gas×0 + 0 = 0），所以出证方密钥可以是专门新生成的一把，
// 不占用、也不动用运营方水龙头的资金。
//
// 为什么先不写合约：合约要 address 管理、要 ABI、要升级；而"把根写进 input"这一招
// 在联盟链（成员固定、可审计）里已经足够，且客户复核只要一条 cast/eth_getTransactionByHash。
// 真正需要"任何人可查、签发方不可篡改"时再换 IEvidenceRegistry（M4 的链上部分）。
const { ethers } = require("ethers");
const crypto = require("node:crypto");
const { merkle: m, sign, verify: verifyLib } = require("./core");
const cfg = require("./config");

const MAGIC = "45564944"; // "EVID"

const DDL = `
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  batch_id    TEXT,
  leaf_index  INTEGER,
  subject_kind TEXT,
  subject_id   TEXT,
  root         TEXT,
  leaf_hash    TEXT,
  anchor_tx    TEXT,
  anchor_block INTEGER,
  package      TEXT,
  issued_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ev_batch ON evidence(batch_id);
CREATE INDEX IF NOT EXISTS idx_ev_subject ON evidence(subject_kind, subject_id);
`;

function ensureSchema(db) { db.exec(DDL); }

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/// 把根锚到链上：一笔零 gas、零面值的旧式交易。
async function anchorRoot(provider, wallet, root) {
  const to = cfg.ANCHOR_REGISTRY;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("ANCHOR_REGISTRY 未配置（需要一个收款地址承载锚点交易）");
  const tx = await wallet.sendTransaction({
    to,
    value: 0n,
    // 不能写死 21000：那是"纯转账"的 intrinsic gas。锚点交易带 36 字节 calldata
    // （4 字节 EVID 魔数 + 32 字节根），非零字节每个 68 gas、零字节每个 4 gas，
    // intrinsic 约 25.3k > 21000，节点直接拒 "Intrinsic gas exceeds gas limit"（实测踩过）。
    // 本链 gas 上限是 0x1fffffffffffff，多给不花钱（零 gas），所以留足余量。
    gasLimit: 100000n,
    gasPrice: 0,          // 必须显式 0 且走 legacy：B04 实测 EIP-1559 会被抬到 1 wei 而永远付不起
    type: 0,
    data: "0x" + MAGIC + root.replace(/^0x/, ""),
  });
  const rec = await tx.wait();
  if (rec.status !== 1) throw new Error(`锚定交易 status=${rec.status}，出证中止（不能锚一条失败的交易）`);
  return { txHash: rec.hash, blockNumber: rec.blockNumber, contract: to.toLowerCase() };
}

/// 从**多个节点**取锚点交易并要多数一致。只问一台的话，那台在骗你你也看不出来。
async function fetchAnchor(anchor) {
  const urls = cfg.NODES;
  const want = "0x" + MAGIC + anchor.topicRoot.replace(/^0x/, "");
  const got = [];
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, cfg.CHAIN_ID, { staticNetwork: true });
      const [tx, rec, head] = await Promise.all([
        p.getTransaction(anchor.txHash),
        p.getTransactionReceipt(anchor.txHash),
        p.getBlockNumber(),
      ]);
      if (!tx) continue;
      got.push({
        url,
        root: tx.data && tx.data.startsWith("0x" + MAGIC) ? "0x" + tx.data.slice(2 + MAGIC.length) : null,
        inputMatches: tx.data === want,
        status: rec ? Number(rec.status) : null,
        blockNumber: rec ? rec.blockNumber : null,
        confirmations: rec ? head - rec.blockNumber + 1 : 0,
      });
    } catch { /* 节点不可达就少一票 */ }
  }
  if (!got.length) return null;
  const agreeing = got.filter((g) => g.inputMatches && g.status === 1);
  if (!agreeing.length) return { root: null, nodes: got, confirmations: 0 };
  const a = agreeing[0];
  return { root: a.root, blockNumber: a.blockNumber, confirmations: a.confirmations, nodesChecked: got.length, nodesAgreeing: agreeing.length };
}

/// 出一个批次里第 index 条的证据包。
/// items: [{ subjectKind, subjectId, data, displayName }]
/// issuer: { name, privateKeyHex(发锚点交易的 secp256k1 key), privateKeyPem(P-256 签名 key), keyId }
/// 两把钥匙是分开的：链上交易必须 secp256k1，证据包签名用 P-256（见 lib/sign.js 的理由）。
async function issueBatch(db, items, meta, issuer) {
  if (!items?.length) throw new Error("空批次不出证");
  if (!issuer?.privateKeyHex || !issuer?.privateKeyPem) throw new Error("issuer 需同时提供 privateKeyHex（上链）与 privateKeyPem（签名）");
  const provider = new ethers.JsonRpcProvider(cfg.RPC, cfg.CHAIN_ID, { staticNetwork: true });
  const wallet = new ethers.Wallet(issuer.privateKeyHex, provider);
  const batchId = meta.batchId || `batch_${crypto.randomBytes(6).toString("hex")}`;
  const payloadItems = items.map((it) => it.data);
  const { root } = m.buildTree(payloadItems);
  const anchor = await anchorRoot(provider, wallet, root);
  const issuedAt = nowIso();
  const out = [];

  for (let i = 0; i < items.length; i++) {
    const pf = m.proofFor(payloadItems, i);
    const evidenceId = `ev_${crypto.randomBytes(9).toString("base64url")}`;
    const pkg = {
      schema: "minichain.evidence/1",
      evidenceId,
      subject: { kind: items[i].subjectKind, id: items[i].subjectId, displayName: items[i].displayName },
      batch: { batchId, leafCount: items.length, issuedAt },
      algorithm: { name: "sha256-merkle", variant: "v2-indexed", leafPrefix: "4c", nodePrefix: "4e", oddLeaf: "indexed-position" },
      leaf: { index: i, leafHash: pf.leafHash, disclosure: items[i].disclosure || "full", data: items[i].data, dataEncoding: "utf8" },
      root,
      proof: pf.proof,
      anchor: {
        chainProfile: "unionchain", chainId: cfg.CHAIN_ID, contract: anchor.contract,
        txHash: anchor.txHash.toLowerCase(), blockNumber: anchor.blockNumber,
        topicRoot: root, confirmationsRequired: meta.confirmationsRequired ?? 1,
        rpcUrl: cfg.RPC, explorerUrl: `${cfg.PUBLIC_BASE}/b03/`,
      },
      status: "anchored",
      validity: { issuedAt },
      issuer: { name: issuer.name, keyId: issuer.keyId, address: wallet.address.toLowerCase(),
                algorithm: sign.ALG, signature: "0x",
                // anchor.confirmationsRequired 必须进签名：它是"多少确认才算数"的策略声明，
                // 不签的话谁都能把它改成 0 来蒙过验证（实测过这个洞）。
                signedFields: meta.signedFields || ["root", "batch.batchId", "batch.leafCount", "evidenceId", "subject.id", "anchor.confirmationsRequired"] },
    };
    const s = sign.sign(pkg, pkg.issuer.signedFields, issuer.privateKeyPem);
    pkg.issuer.signature = s.signature;
    db.prepare(`INSERT INTO evidence(evidence_id,batch_id,leaf_index,subject_kind,subject_id,root,leaf_hash,anchor_tx,anchor_block,package,issued_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(evidenceId, batchId, i, pkg.subject.kind, pkg.subject.id, root, pf.leafHash, anchor.txHash, anchor.blockNumber, JSON.stringify(pkg), Math.floor(Date.now() / 1000));
    out.push(pkg);
  }
  return { batchId, root, anchor, packages: out };
}

/// 只取公钥：验签需要它，而 API 进程不该碰私钥。缺文件就返回 null，由调用方决定怎么报。
function loadPublicKey() {
  try {
    const p = require("node:path").join(cfg.EVIDENCE_KEYS_DIR, "issuer.json");
    return JSON.parse(require("node:fs").readFileSync(p, "utf8")).publicKeyPem || null;
  } catch { return null; }
}

/// 服务端完整验证（客户也可以拿 verify.js 自己跑，这里是给浏览器一个"当场复核"的按钮）
/// 没有公钥时**明确报"未验签"并判失败**——跳过签名却返回 ok 是出证系统最坏的错误。
async function verifyStored(db, evidenceId, publicKeyPem) {
  const row = db.prepare("SELECT package FROM evidence WHERE evidence_id=?").get(evidenceId);
  if (!row) return { ok: false, checks: [{ name: "存在", ok: false, detail: "找不到该 evidenceId" }] };
  const pkg = JSON.parse(row.package);
  const pem = publicKeyPem || process.env.EVIDENCE_PUBLIC_PEM || loadPublicKey();
  const r = await verifyLib.verifyPackage(pkg, { fetchAnchor, publicKeyPem: pem, minConfirmations: cfg.MIN_CONFIRMATIONS });
  if (!pem) {
    // verifyLib 已经加了一条"未提供公钥"的失败项，这里只补一句可操作的提示，不重复计数
    const last = r.checks[r.checks.length - 1];
    if (last && last.name === "签名") last.detail += "；修复：确认 " + cfg.EVIDENCE_KEYS_DIR + "/issuer.json 可读";
  }
  return { ...r, ok: r.ok && !!pem, publicKeyAvailable: !!pem };
}

module.exports = { ensureSchema, issueBatch, verifyStored, fetchAnchor, MAGIC };
