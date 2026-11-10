// P02 内核密码学：与 P01 同源的做法（Web Crypto，零依赖）。
// 刻意偏差：真实链用 secp256k1 + keccak256 + 可恢复签名（从签名反推公钥，交易里不必带 pubkey）。
// 浏览器/Node 内置 Web Crypto 没有 secp256k1，所以这里用 ECDSA P-256，并让交易显式携带公钥。
// 代价与收益都写进 docs/01-设计取舍.md，不假装它是真链。
const encoder = new TextEncoder();

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  return Uint8Array.from(hex.replace(/^0x/, "").match(/.{2}/g), (h) => parseInt(h, 16));
}

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

export async function generateWallet() {
  const pair = await globalThis.crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const publicKeyHex = toHex(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyHex, address: await addressOf(publicKeyHex) };
}

// 地址 = 公钥哈希的前 40 个十六进制位（20 字节），与以太坊「取 keccak 后 20 字节」同构。
export async function addressOf(publicKeyHex) {
  return `0x${(await sha256Hex(fromHex(publicKeyHex))).slice(0, 40)}`;
}

export async function sign(privateKey, message) {
  const sig = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(message)
  );
  return toHex(sig);
}

export async function importPublicKey(publicKeyHex) {
  return globalThis.crypto.subtle.importKey("raw", fromHex(publicKeyHex), ECDSA, false, ["verify"]);
}

/**
 * 确定性身份：验证人集合必须在节点重启后仍然一致，所以私钥要能导出/导入。
 * 用 JWK 承载（Web Crypto 不暴露原始 d 值）；真实项目里这一步是 HSM/密钥库的活。
 * 注意 ECDSA 的 usages 限制：私钥只能 ["sign"]、公钥只能 ["verify"]，混用会直接抛错。
 */
export async function exportPrivateKey(wallet) {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", wallet.privateKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
}

export async function importPrivateKey(saved) {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    { ...saved, key_ops: ["sign"] },
    ECDSA,
    true,
    ["sign"]
  );
  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    { kty: saved.kty, crv: saved.crv, x: saved.x, y: saved.y, key_ops: ["verify"], ext: true },
    ECDSA,
    true,
    ["verify"]
  );
  const publicKeyHex = toHex(await globalThis.crypto.subtle.exportKey("raw", publicKey));
  return { privateKey, publicKey, publicKeyHex, address: await addressOf(publicKeyHex) };
}

export async function verify(publicKeyHex, signatureHex, message) {
  try {
    return await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublicKey(publicKeyHex),
      fromHex(signatureHex),
      encoder.encode(message)
    );
  } catch {
    return false;
  }
}
