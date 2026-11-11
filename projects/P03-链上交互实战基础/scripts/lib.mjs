// P03 共享库：RPC 连接、交易逐字段解析、证据落盘。
// 解析不依赖任何浏览器/Etherscan——这正是联盟网场景的核心能力（B03 差异矩阵第 1 行）。
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(ROOT, "../..");
export const RPC = process.env.RPC || "http://127.0.0.1:8551";
export const CHAIN_ID = 19880601;
export const FAUCET_URL = process.env.FAUCET_URL || "http://127.0.0.1:8560";

export function loadEnv(file = path.join(ROOT, ".env")) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function provider() {
  const p = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  p.pollingInterval = 1000; // 出块 5s，默认 4s 轮询会让等待回执体感很慢
  return p;
}

export function learnerWallet() {
  const env = loadEnv();
  if (!env.LEARNER_PK) throw new Error("缺 LEARNER_PK：先跑 node scripts/01-new-wallet.mjs");
  return new ethers.Wallet(env.LEARNER_PK, provider());
}

// 已知选择器：够用即可，完整 4byte 目录是公网服务，联盟网里靠自己登记（P04 的 abi/*.selectors.json 思路）
export const SELECTORS = {
  "0xa9059cbb": { sig: "transfer(address,uint256)", types: ["address", "uint256"], names: ["to", "value"] },
  "0x40c10f19": { sig: "mint(address,uint256)", types: ["address", "uint256"], names: ["to", "value"] },
  "0x095ea7b3": { sig: "approve(address,uint256)", types: ["address", "uint256"], names: ["spender", "value"] },
  "0x23b872dd": { sig: "transferFrom(address,address,uint256)", types: ["address", "address", "uint256"], names: ["from", "to", "value"] },
};
export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
export const APPROVAL_TOPIC = ethers.id("Approval(address,address,uint256)");

export function decodeInput(data) {
  if (!data || data === "0x") return { selector: null, note: "空 input：原生转账（或纯 value 交易）" };
  const selector = data.slice(0, 10).toLowerCase();
  const known = SELECTORS[selector];
  if (!known) return { selector, note: "未登记的选择器（联盟网里没有 4byte.directory，需自己登记 ABI）" };
  try {
    const args = ethers.AbiCoder.defaultAbiCoder().decode(known.types, "0x" + data.slice(10));
    const decoded = {};
    known.names.forEach((n, i) => { decoded[n] = args[i].toString(); });
    return { selector, sig: known.sig, args: decoded };
  } catch (e) {
    return { selector, sig: known.sig, note: "参数解码失败：" + e.message };
  }
}

export function decodeLog(log) {
  const out = { address: log.address, topics: [...log.topics], data: log.data };
  if (log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3) {
    out.event = "Transfer(address indexed from, address indexed to, uint256 value)";
    out.decoded = {
      from: ethers.getAddress("0x" + log.topics[1].slice(26)),
      to: ethers.getAddress("0x" + log.topics[2].slice(26)),
      value: BigInt(log.data).toString(),
    };
    if (out.decoded.from === ethers.ZeroAddress) out.note = "from=0x0 → 这是一笔 mint";
  } else if (log.topics[0] === APPROVAL_TOPIC && log.topics.length === 3) {
    out.event = "Approval(address indexed owner, address indexed spender, uint256 value)";
    out.decoded = {
      owner: ethers.getAddress("0x" + log.topics[1].slice(26)),
      spender: ethers.getAddress("0x" + log.topics[2].slice(26)),
      value: BigInt(log.data).toString(),
    };
  }
  return out;
}

// 逐字段解析一笔交易：tx 本体 + 签名恢复 + 回执 + 区块 + 终结性。
// 签名恢复是重点：from 不是"声明"出来的，是从 v/r/s 恢复出来的——节点只认恢复结果。
export async function parseTx(hash) {
  const p = provider();
  const tx = await p.getTransaction(hash);
  if (!tx) throw new Error(`链上查不到 ${hash}（节点没这笔交易，或哈希抄错）`);
  const rec = await p.getTransactionReceipt(hash);
  if (!rec) throw new Error(`${hash} 还在池里没入块（receipt=null）——零 gas 链上先怀疑链停摆，见 B03 排障口诀`);
  const [block, head] = await Promise.all([p.getBlock(rec.blockNumber), p.getBlockNumber()]);

  // 签名恢复：用 RPC 字段重建**无符号**交易 → 取签名摘要 → ecrecover，与 tx.from 对账。
  // 不用 tx.serialized：ethers 6.17 的 getTransaction 响应里它可能是 undefined（实测）。
  const unsigned = ethers.Transaction.from({
    type: tx.type,
    to: tx.to,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice ?? undefined,
    maxFeePerGas: tx.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? undefined,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
  });
  const digest = unsigned.unsignedHash;
  const sig = tx.signature;
  const recovered = ethers.recoverAddress(digest, sig);

  const record = {
    hash,
    lifecycle: {
      chainId: Number(tx.chainId),
      type: tx.type,
      typeName: tx.type === 0 ? "legacy（EIP-155）" : tx.type === 2 ? "EIP-1559" : `type-${tx.type}`,
      nonce: tx.nonce,
      from: tx.from,
      to: tx.to,
      valueWei: tx.value.toString(),
      valueB03: ethers.formatEther(tx.value),
      gasLimit: tx.gasLimit.toString(),
      gasPriceWei: (tx.gasPrice ?? 0n).toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString() ?? null,
      input: decodeInput(tx.data),
      rawData: tx.data,
      signature: {
        v: sig.v, r: sig.r, s: sig.s,
        eip155Digest: digest,
        recoveredFrom: recovered,
        recoveryMatchesFrom: recovered === tx.from,
      },
    },
    receipt: {
      status: rec.status,
      statusMeaning: rec.status === 1 ? "成功（EVM 执行未 revert）" : "失败（EVM revert，gas 照烧）",
      gasUsed: rec.gasUsed.toString(),
      effectiveGasPriceWei: rec.gasPrice.toString(),
      feeWei: (rec.gasUsed * rec.gasPrice).toString(),
      cumulativeGasUsed: rec.cumulativeGasUsed.toString(),
      transactionIndex: rec.index,
      logs: rec.logs.map(decodeLog),
      revertReason: null,
    },
    block: {
      number: rec.blockNumber,
      hash: rec.blockHash,
      timestamp: block.timestamp,
      timestampISO: new Date(Number(block.timestamp) * 1000).toISOString(),
      proposer: block.miner,
      txCount: block.transactions.length,
    },
    finality: {
      model: "QBFT 确定性终结",
      confirmations: head - rec.blockNumber + 1,
      note: "入块即最终：≥quorum(3/4) 验证者签过 commit 证书，不存在公链式重组。confirmations 只是链头距离，不是安全参数。",
    },
  };

  // 失败交易：在入块高度重放 eth_call 拿 revert 原因（链上回执本身不带 reason）
  if (rec.status === 0) {
    try {
      await p.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, rec.blockNumber);
      record.receipt.revertReason = "（重放未复现 revert——状态依赖型失败，需按当时状态分析）";
    } catch (e) {
      const data = e.data ?? e.error?.data;
      if (typeof data === "string" && data.startsWith("0x08c379a0")) {
        record.receipt.revertReason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
      } else {
        record.receipt.revertReason = e.shortMessage || e.message;
      }
    }
  }
  return record;
}

export function renderTxMarkdown(r, title) {
  const L = r.lifecycle, R = r.receipt, B = r.block;
  const lines = [];
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`\`${r.hash}\``);
  lines.push("");
  lines.push("| 字段 | 值 | 解释 |");
  lines.push("|------|----|------|");
  lines.push(`| type | ${L.type}（${L.typeName}） | 0=legacy 带 chainId 防重放（EIP-155）；2=EIP-1559 双费用字段 |`);
  lines.push(`| chainId | ${L.chainId} | 本联盟网自定义 ID，签名摘要的一部分——换链重放必失败 |`);
  lines.push(`| nonce | ${L.nonce} | 该账户的第 N 笔交易（从 0 起），防重放 + 定序 |`);
  lines.push(`| from | \`${L.from}\` | **不是声明，是 v/r/s 恢复出来的**（见下） |`);
  lines.push(`| to | \`${L.to ?? "（合约创建）"}\` | 收款方；null 表示部署合约 |`);
  lines.push(`| value | ${L.valueWei} wei = ${L.valueB03} B03 | 转账面值。零 gas 免的是手续费，**本金照查** |`);
  lines.push(`| gasLimit | ${L.gasLimit} | 愿意烧的上限；原生转账恒 21000 |`);
  lines.push(`| gasPrice | ${L.gasPriceWei} wei | 本链恒 0（--min-gas-price=0 + zeroBaseFee） |`);
  if (L.input.sig) {
    lines.push(`| input.selector | \`${L.input.selector}\` | ${L.input.sig} —— 前 4 字节 = keccak256(签名) 的前 4 字节 |`);
    lines.push(`| input.args | ${JSON.stringify(L.input.args)} | ABI 解码（uint256 按 wei 计） |`);
  } else {
    lines.push(`| input | ${L.input.note} | 原生转账没有选择器 |`);
  }
  lines.push(`| v / r / s | ${L.signature.v} / \`${L.signature.r.slice(0, 18)}…\` / \`${L.signature.s.slice(0, 18)}…\` | ECDSA(secp256k1) 签名三元组 |`);
  lines.push(`| 签名摘要 | \`${L.signature.eip155Digest.slice(0, 26)}…\` | keccak256(RLP(交易字段, chainId, 0, 0))，EIP-155 |`);
  lines.push(`| ecrecover | \`${L.signature.recoveredFrom}\` | 与 from ${L.signature.recoveryMatchesFrom ? "**一致 ✓**" : "不一致 ✗（异常！）"} |`);
  lines.push(`| status | ${R.status} | ${R.statusMeaning} |`);
  if (R.revertReason) lines.push(`| revert reason | "${R.revertReason}" | 回执不带 reason，用入块高度 eth_call 重放取得 |`);
  lines.push(`| gasUsed | ${R.gasUsed} | 实际烧掉的 gas（失败也烧） |`);
  lines.push(`| effectiveGasPrice | ${R.effectiveGasPriceWei} wei | 实际单价；fee = gasUsed × 单价 = ${R.feeWei} wei |`);
  lines.push(`| block | #${B.number} \`${B.hash.slice(0, 26)}…\` | 块高 + 块哈希；proposer=${B.proposer} |`);
  lines.push(`| 入块时间 | ${B.timestampISO} | 块时间戳（QBFT 出块间隔 5s） |`);
  lines.push(`| logs | ${R.logs.length} 条 | ${R.logs.length ? "见下方事件解码" : "原生转账不产生日志"} |`);
  lines.push(`| 终结性 | ${r.finality.model} | ${r.finality.note} |`);
  if (R.logs.length) {
    lines.push("");
    lines.push("事件解码：");
    for (const log of R.logs) {
      lines.push(`- \`${log.address}\` ${log.event ?? "未知事件"}${log.note ? "（" + log.note + "）" : ""}`);
      if (log.decoded) lines.push(`  - ${JSON.stringify(log.decoded)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function saveEvidence(obj) {
  const dir = path.join(ROOT, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transactions.json");
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}