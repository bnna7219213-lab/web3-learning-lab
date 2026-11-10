// 出证签名：ECDSA P-256 / SHA-256（schema 的 ecdsa-p256-sha256 一档）
//
// 为什么不用 secp256k1：那条路线要 keccak + 地址恢复，得引依赖；P-256 是 node:crypto
// 原生支持的，客户拿 openssl 就能复核。出证方是企业（Java/Spring 栈），P-256 反而是他们
// 最常见的签名算法。要上链上验签时再加 secp256k1 分支不迟。
//
// 签名对象是**规范化后的字段子集**（signedFields），不是整个包：
// 包里的 signature 自己不能被签；而 status/void 这类会随时间变的字段也不该进签名，
// 否则"作废"操作会让自己刚签的签名失效。哪些字段进签名，必须写进包里让客户看得见。
const crypto = require("node:crypto");

const ALG = "ecdsa-p256-sha256";

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey, privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    // keyId 用公钥指纹前 16 位：换钥匙时客户能立刻发现"签发方密钥变了"
    keyId: "k_" + crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16),
  };
}

function loadPublic(pem) {
  return crypto.createPublicKey(pem);
}
function loadPrivate(pem) {
  return crypto.createPrivateKey(pem);
}

/// 只取 signedFields 且按字段名字典序输出，避免"对象键顺序影响签名"这种坑。
/// undefined 字段跳过但会记录在 signedFields 里，缺字段即验签失败——不允许静默省略。
function canonicalPayload(pkg, signedFields) {
  const picked = {};
  for (const f of signedFields) {
    const v = f.split(".").reduce((o, k) => (o == null ? o : o[k]), pkg);
    if (v === undefined) throw new Error(`signedFields 声明了 ${f}，但包里该字段缺失`);
    picked[f] = v;
  }
  return JSON.stringify(picked, Object.keys(picked).sort());
}

function sign(pkg, signedFields, privateKey) {
  const payload = canonicalPayload(pkg, signedFields);
  const sig = crypto.sign("sha256", Buffer.from(payload, "utf8"), loadPrivate(privateKey));
  return { signature: "0x" + sig.toString("hex"), signedPayload: payload, algorithm: ALG };
}

function verify(pkg, signedFields, signatureHex, publicKeyPem) {
  let payload;
  try { payload = canonicalPayload(pkg, signedFields); }
  catch (e) { return { ok: false, reason: e.message }; }
  const pub = typeof publicKeyPem === "string" ? loadPublic(publicKeyPem) : publicKeyPem;
  let sigBuf;
  if (/^0x[0-9a-f]*$/i.test(signatureHex)) sigBuf = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  else return { ok: false, reason: "signature 不是 0x 十六进制" };
  return {
    ok: crypto.verify("sha256", Buffer.from(payload, "utf8"), pub, sigBuf),
    canonicalPayload: payload,
  };
}

module.exports = { ALG, generateKeyPair, loadPublic, loadPrivate, canonicalPayload, sign, verify };
