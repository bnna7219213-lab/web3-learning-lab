// 出证包验证：链上部分通过注入的 fetchAnchor 完成，本模块不认识任何具体链
// （shared/evidence 要能被 B03/B08/P09 复用，所以这里只收回调）
const m = require("./merkle-indexed");
const sign = require("./sign");

// schema 里 required 的顶层字段——手写极简校验，不引 JSON Schema 库。
// 出证是要给客户跑的，依赖越少客户越容易自己复现。
const REQUIRED = ["schema", "evidenceId", "subject", "batch", "algorithm", "leaf", "root", "proof", "anchor", "status", "validity", "issuer"];

function shapeCheck(pkg) {
  const errs = [];
  for (const k of REQUIRED) if (pkg[k] === undefined) errs.push(`缺字段 ${k}`);
  if (pkg.schema && pkg.schema !== "minichain.evidence/1") errs.push(`schema 不认识：${pkg.schema}`);
  if (pkg.algorithm && pkg.algorithm.variant !== "v2-indexed")
    errs.push(`algorithm.variant=${pkg.algorithm.variant}，本验证器只接受 v2-indexed（v1 的 duplicate-last 有等价树缺陷，见 lib/merkle-indexed.js 注释）`);
  if (pkg.status === "voided" && !pkg.void) errs.push("status=voided 但缺 void 说明");
  return errs;
}

/// pkg: 出证包；fetchAnchor(anchor) → { root, blockNumber, txHash, confirmations }
/// 由调用方负责真的去链上取，并保证取到的是**多数节点一致**的结果。
/// minConfirmations：交付策略的确认数下限。不传则只能信包内声明——那是不安全的，
/// 调用方（尤其是对客出证场景）应当显式传。
async function verifyPackage(pkg, { fetchAnchor, publicKeyPem, minConfirmations, now = Date.now() }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const errs = shapeCheck(pkg);
  add("包结构", errs.length === 0, errs.join("；") || "ok");
  if (errs.length) return { ok: false, checks };

  // 1) Merkle 证明：叶子 → 根
  let proofOk = false, recomputed = null;
  try {
    const r = m.verifyProof(pkg.leaf.leafHash, pkg.proof, pkg.root);
    proofOk = r.ok; recomputed = r.recomputedRoot;
    add("Merkle 证明", proofOk, proofOk ? `重算根 == 包内根` : `重算得 ${r.recomputedRoot}，包内写 ${pkg.root}`);
  } catch (e) {
    add("Merkle 证明", false, e.message);
  }

  // 2) 披露数据一致性：给了 data 就必须能重算出同一个叶子
  if (pkg.leaf.data !== undefined) {
    const re = m.leafAt(pkg.leaf.index, pkg.leaf.data).toString("hex");
    const want = pkg.leaf.leafHash.replace(/^0x/, "");
    add("披露数据与叶子一致", re === want, re === want ? "data 重算 == leafHash" : "data 与 leafHash 不符（可能篡改了披露内容）");
  } else if (pkg.leaf.disclosure === "full") {
    add("披露数据与叶子一致", false, "disclosure=full 但没有 data");
  }

  // 3) 锚点在链上：根必须真的被写进交易里，而不是包里自称
  try {
    const a = await fetchAnchor(pkg.anchor);
    const rootOnChain = a && a.root;
    add("链上锚点存在", !!a, a ? `块高 ${a.blockNumber}` : "取不到锚定交易");
    add("链上根 == 包内根", rootOnChain === pkg.root, `链上 ${rootOnChain} vs 包 ${pkg.root}`);
    add("链上根 == Merkle 重算根", rootOnChain === recomputed, "三者必须一致，否则证明与锚点无关");
    const conf = a ? a.confirmations : 0;
    // 确认数策略**不能只信包里写的**：confirmationsRequired 是包内字段，
    // 若它不参与签名、验证方又只拿它自己比，攻击者把它改成 0 就能让一笔刚入块、
    // 甚至还在分叉风险里的交易看起来"达标"（实测：改成 0 后整包验签通过）。
    // 所以：验证方传入交付策略下限 minConfirmations，取两者较大值作为实际要求。
    // 但"包内声明低于策略"**不能判包无效**——第一版就是这么写的，结果 CLI 默认
    // --confirm 1 而策略 2，于是每一个默认签发的包永远验不过，确认数涨到多少都没用。
    // 声明低只是签发方要得少，应当由策略抬起来等够为止，而不是把包本身打死。
    const claim = pkg.anchor.confirmationsRequired;
    const policy = Number.isFinite(minConfirmations) ? minConfirmations : claim;
    const need = Math.max(claim, policy);
    add("确认数达标", conf >= need,
      `${conf} / 需要 ${need}（包内声明 ${claim}，验证方策略 ${policy}）` +
      (claim < policy ? " — 签发时要求的确认数低于本验证方策略，已按策略抬高" : ""));
  } catch (e) {
    add("链上锚点存在", false, e.message);
  }

  // 4) 签发方签名。
  //    没公钥时也要产出一条**失败**的签名检查：出证系统里"没验"绝不能等于"过了"。
  //    （早先这里无条件先 add 一条占位失败、再在 if 里 add 真结果，导致有公钥时
  //     也出现两条"签名"、其中一条永远 FAIL——重复计数比漏计数更容易骗过看报告的人。）
  const iss = pkg.issuer;
  if (publicKeyPem) {
    const v = sign.verify(pkg, iss.signedFields, iss.signature, publicKeyPem);
    add("签名", v.ok, v.ok ? "ECDSA P-256/SHA-256 验签通过" : `验签失败：${v.reason || "signature mismatch"}`);
  } else {
    add("签名", false, "未提供签发方公钥，无法验签（视为不通过，不是跳过）");
  }

  // 5) 有效期
  if (pkg.validity.expiresAt) {
    const exp = Date.parse(pkg.validity.expiresAt);
    add("未过期", exp > now, `expiresAt=${pkg.validity.expiresAt} now=${new Date(now).toISOString()}`);
  }
  if (pkg.status === "voided") add("未被作废", false, `作废原因：${pkg.void && pkg.void.reason}`);

  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { verifyPackage, shapeCheck, REQUIRED };
