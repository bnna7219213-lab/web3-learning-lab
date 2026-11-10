// 交易：显式携带公钥（见 crypto.js 的偏差说明），签名覆盖规范化 preimage。
import { sha256Hex, sign, verify, addressOf } from "./crypto.js";

export const TX_VERSION = "mini-v1";

export function txPreimage(tx) {
  return `${TX_VERSION}|${tx.pubkey}|${tx.nonce}|${tx.to}|${tx.value}|${tx.fee}`;
}

export async function txId(tx) {
  return sha256Hex(`${txPreimage(tx)}|${tx.sig}`);
}

export async function createTx({ wallet, to, value, fee = 1, nonce }) {
  const tx = { pubkey: wallet.publicKeyHex, from: wallet.address, nonce, to, value, fee, sig: "" };
  tx.sig = await sign(wallet.privateKey, txPreimage(tx));
  return tx;
}

/**
 * 与业务无关的「形 + 签名」检查：节点收交易、打包前、验证区块时都要跑一遍。
 * 返回 { ok, reason }，reason 要能直接进日志与告警（P21 的前置习惯）。
 */
export async function checkTx(tx) {
  if (!tx || typeof tx !== "object") return { ok: false, reason: "交易不是对象" };
  for (const field of ["pubkey", "from", "to", "sig"]) {
    if (typeof tx[field] !== "string" || !tx[field]) return { ok: false, reason: `字段 ${field} 缺失` };
  }
  for (const field of ["nonce", "value", "fee"]) {
    if (!Number.isInteger(tx[field]) || tx[field] < 0) return { ok: false, reason: `字段 ${field} 必须是非负整数` };
  }
  if ((await addressOf(tx.pubkey)) !== tx.from) return { ok: false, reason: "from 与公钥不匹配（冒名）" };
  if (!(await verify(tx.pubkey, tx.sig, txPreimage(tx)))) return { ok: false, reason: "签名无效（报文被篡改）" };
  return { ok: true, reason: "" };
}

export const emptyState = () => ({ accounts: {} });

export function ensureAccount(state, address) {
  return (state.accounts[address] ??= { balance: 0, nonce: 0 });
}

export function airdrop(state, address, amount) {
  ensureAccount(state, address).balance += amount;
}

/**
 * 状态迁移：nonce 必须严格等于账户当前值（防重放），余额必须够付 value + fee。
 * 手续费给 proposer，所以调用方要传 proposer 地址。
 */
export function applyTx(state, tx, proposer) {
  const sender = ensureAccount(state, tx.from);
  if (tx.nonce !== sender.nonce) {
    return { ok: false, reason: `nonce 期望 ${sender.nonce}，实际 ${tx.nonce}` };
  }
  if (sender.balance < tx.value + tx.fee) {
    return { ok: false, reason: `余额不足：需要 ${tx.value + tx.fee}，实际 ${sender.balance}` };
  }
  sender.balance -= tx.value + tx.fee;
  sender.nonce += 1;
  ensureAccount(state, tx.to).balance += tx.value;
  ensureAccount(state, proposer).balance += tx.fee;
  return { ok: true, reason: "" };
}

// 只读预检：进 mempool 前用，避免节点被垃圾交易塞满。
export function precheck(state, tx) {
  const sender = state.accounts[tx.from] ?? { balance: 0, nonce: 0 };
  if (tx.nonce < sender.nonce) return { ok: false, reason: "nonce 过旧（重放）" };
  if (tx.nonce > sender.nonce + 1) return { ok: false, reason: "nonce 跳号过多" };
  if (sender.balance < tx.value + tx.fee) return { ok: false, reason: "余额不足" };
  return { ok: true, reason: "" };
}
