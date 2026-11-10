// 工作量证明：难度每 +1（一个十六进制前导 0），期望尝试次数 ×16。
import { sha256Hex } from "./crypto.js";

export function meetsTarget(hash, difficulty) {
  return hash.startsWith("0".repeat(difficulty));
}

export function preimage(index, difficulty, prevHash, data, nonce) {
  return `${index}|${difficulty}|${prevHash}|${data}|${nonce}`;
}

export async function mineBlock({ index = 0, difficulty = 3, prevHash = "0".repeat(64), data = "", maxAttempts = 2_000_000 }) {
  const started = performance.now();
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const hash = await sha256Hex(preimage(index, difficulty, prevHash, data, nonce));
    if (meetsTarget(hash, difficulty)) {
      return { nonce, hash, attempts: nonce + 1, ms: Math.round(performance.now() - started), difficulty };
    }
  }
  return { nonce: -1, hash: null, attempts: maxAttempts, ms: Math.round(performance.now() - started), difficulty };
}

// 用一次实际搜索估算，避免把 16^difficulty 的大数直接摊给用户。
export function expectedAttempts(difficulty) {
  return Math.pow(16, difficulty);
}
