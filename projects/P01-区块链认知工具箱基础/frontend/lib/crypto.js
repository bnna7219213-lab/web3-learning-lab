// P01 共用密码学工具：只用浏览器/Node 都内置的 Web Crypto，零依赖。
const encoder = new TextEncoder();

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function requireCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "crypto.subtle 不可用：请用 http://127.0.0.1 访问（安全上下文），或用 node 运行 demos/。"
    );
  }
  return globalThis.crypto;
}

export async function sha256Hex(input) {
  requireCrypto();
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export function shortHash(hash, head = 12, tail = 8) {
  if (!hash || hash.length <= head + tail + 3) return hash ?? "";
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function randomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  requireCrypto().getRandomValues(bytes);
  return toHex(bytes);
}

export function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// 两个十六进制摘要之间不同的比特数（雪崩效应度量）。
export function hexHamming(a, b) {
  let flipped = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    for (let bit = 0; bit < 4; bit++) if ((x >> bit) & 1) flipped++;
  }
  return flipped + Math.abs(a.length - b.length) * 4;
}

export function prefixMatchLength(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return i;
}
