// B09 索引器配置（联盟网版）：与 P09 同构，差异只在「链语义」与「事件源」。
//   · RPC/chainId → 联盟网 Besu QBFT（默认 8551 / 19880601）
//   · 事件源 → B07 的 LabCredential（权益凭证）+ LabFaucet（水龙头额度）
//                + B08 的 Vault 代理 / Merkle 空投 / Create2 工厂（工程证据，B08×B09 联动）
//   · confirmations 默认 0 —— QBFT 单块终结，无公链式重组（见 docs/01 差异一节）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RPC = process.env.RPC || "http://127.0.0.1:8551";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 19880601);
export const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "index.db");

// QBFT 单块终结：深度语义从「等 N 个块」变成「等跨节点一致性核对」（验收里 3 节点对块哈希）
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 0);
export const LOG_CHUNK = Number(process.env.LOG_CHUNK || 2000);
export const START_BLOCK = Number(process.env.START_BLOCK || 0);

export const API_PORT = Number(process.env.API_PORT || 8802);
export const API_KEY = process.env.API_KEY || "b09-dev-key";
export const POLL_MS = Number(process.env.POLL_MS || 5000); // 5s 出块周期

// 监控合约：env CONTRACTS 优先；缺省读 B07 部署记录（credential + faucet）
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 读某个联盟网项目的部署记录；缺失或损坏都只返回 null（不拖垮索引器） */
function readDeployment(dir) {
  const f = path.resolve(ROOT, "..", dir, "deployments", "latest.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(f, "utf8")));
  } catch (e) {
    return null;
  }
}

/** 读指定相对路径的部署记录（如 B05 的 deployments/19880601/LabToken.json —— latest.json 指向的是 anvil 那份） */
function readDeploymentAt(dir, rel) {
  const f = path.resolve(ROOT, "..", dir, "deployments", rel);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(f, "utf8")));
  } catch (e) {
    return null;
  }
}

/**
 * 事件源清单（带中文标签，供看板与文档展示）：
 *   B05 → 记账单位 LabToken（ERC20：Transfer/Approval/RoleGranted，签名与凭证同名，可直接解码）
 *   B06 → 审批流 ApprovalFlow（Proposed/Reviewed/Revoked/Executed）
 *   B07 → 业务凭证（LabCredential）+ 水龙头额度（LabFaucet）
 *   B08 → 工程证据（Vault 代理升级 / Merkle 空投 / Create2 落址）  ← B08 × B09 联动点
 *
 * 全部是**软依赖**：读不到部署记录就跳过该源，索引器照常跑（这是 B09 独立可交付的根据）。
 */
export function watchSources() {
  const out = [];
  // B05：注意它 deployments/latest.json 指的是 anvil(31337) 那份，联盟链要用链号目录里的
  const b5 = readDeploymentAt("B05-ERC20代币联盟网", `${CHAIN_ID}/LabToken.json`);
  if (b5 && b5.address) out.push({ domain: "B05", label: "LabToken（记账单位）", address: b5.address });
  // B06：审批流（提案 → 双人复核 → 生效延迟 → 执行）
  const b6 = readDeployment("B06-投票DApp联盟网");
  if (b6 && b6.approvalFlow) out.push({ domain: "B06", label: "ApprovalFlow（双人复核审批）", address: b6.approvalFlow });
  const b7 = readDeployment("B07-NFT市场联盟网");
  if (b7) {
    if (b7.credential) out.push({ domain: "B07", label: "LabCredential（权益凭证）", address: b7.credential });
    if (b7.faucet) out.push({ domain: "B07", label: "LabFaucet（水龙头额度）", address: b7.faucet });
  }
  const b8 = readDeployment("B08-合约工程化联盟网");
  if (b8) {
    if (b8.vaultProxy) out.push({ domain: "B08", label: "Vault 代理（UUPS 升级证据）", address: b8.vaultProxy });
    if (b8.MerkleAirdrop) out.push({ domain: "B08", label: "Merkle 空投", address: b8.MerkleAirdrop });
    if (b8.Create2Factory) out.push({ domain: "B08", label: "Create2 工厂", address: b8.Create2Factory });
  }
  return out;
}

export function watchContracts() {
  const env = (process.env.CONTRACTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length) return env;
  const f = path.resolve(ROOT, "..", "B07-NFT市场联盟网", "deployments", "latest.json");
  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
    return [...new Set([d.credential, d.faucet, ...watchSources().map((s) => s.address)])].filter(Boolean);
  }
  return watchSources().map((s) => s.address);
}

