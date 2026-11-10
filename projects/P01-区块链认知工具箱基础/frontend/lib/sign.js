// 非对称签名与对称加密：用浏览器内置 ECDSA P-256 讲清「私钥签名 / 公钥验证」。
// 与链上 secp256k1 的差别只在曲线与哈希（以太坊地址 = keccak256(pubkey)[12:]），流程完全一致。
import { requireCrypto, toHex, sha256Hex } from "./crypto.js";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

export async function generateIdentity() {
  requireCrypto();
  const pair = await globalThis.crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const rawPub = await globalThis.crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyHex: toHex(rawPub),
    // 教学用「地址」：公钥哈希前 40 个十六进制位，真实链上是 keccak256 取后 20 字节
    address: `0x${(await sha256Hex(new Uint8Array(rawPub))).slice(0, 40)}`,
  };
}

export async function identityFromPublicKeyHex(publicKeyHex) {
  requireCrypto();
  const bytes = Uint8Array.from(publicKeyHex.match(/.{2}/g), (h) => parseInt(h, 16));
  const publicKey = await globalThis.crypto.subtle.importKey("raw", bytes, ECDSA, false, ["verify"]);
  return { publicKey, publicKeyHex };
}

export async function signMessage(privateKey, message) {
  requireCrypto();
  const sig = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message)
  );
  return toHex(sig);
}

export async function verifyMessage(publicKey, signatureHex, message) {
  requireCrypto();
  const sig = Uint8Array.from(signatureHex.match(/.{2}/g), (h) => parseInt(h, 16));
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sig,
    new TextEncoder().encode(message)
  );
}

// 设备报文的规范化字符串：签名的输入必须与验证方逐字节一致，
// chainId + 合约地址进签名域可防跨链/跨合约重放（与 EIP-191/EIP-712 同一思路）。
export function devicePreimage({ deviceId, ts, seq, payload, chainId = 31337, contract = "0xIOT" }) {
  return `${deviceId}|${ts}|${seq}|${payload}|${chainId}|${contract}`;
}

export async function digestAESKey() {
  const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  return key;
}

export async function aesGcmEncrypt(key, plaintext) {
  requireCrypto();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ivHex: toHex(iv), cipherHex: toHex(cipher) };
}

export async function aesGcmDecrypt(key, ivHex, cipherHex) {
  requireCrypto();
  const parse = (h) => Uint8Array.from(h.match(/.{2}/g), (b) => parseInt(b, 16));
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: parse(ivHex) },
      key,
      parse(cipherHex)
    );
    return { ok: true, plaintext: new TextDecoder().decode(plain) };
  } catch {
    return { ok: false, plaintext: null };
  }
}
