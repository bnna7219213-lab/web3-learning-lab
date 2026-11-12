// B09 事件注册表（联盟网版）：LabCredential（B07 权益凭证 12 事件）+ LabFaucet（水龙头额度 4 事件）。
// 签名与 B07 abi/*.json 逐字对齐。批次列 = CredentialIssued.batchId（看板主力筛选），
// 权限负例留痕 = TransferBlocked（被拒的转让也进审计，见差异矩阵第 4 条）。
import { ethers } from "ethers";

export const EVENT_FRAGMENTS = [
  // LabCredential（权益凭证）
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event CredentialIssued(uint256 indexed batchId, uint256 indexed startId, uint16 count, bytes32 merkleRoot, address indexed issuer)",
  "event TransferBlocked(address indexed actor, address indexed from, address indexed to, uint256 tokenId, bytes32 reason)",
  "event MemberUpdated(address indexed account, bool member)",
  "event Redeemed(uint256 indexed tokenId, address indexed holder, address indexed redeemer)",
  "event ExpiredSwept(uint256 indexed tokenId, address indexed holder, address indexed sweeper)",
  "event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  // LabFaucet（水龙头额度）
  "event Payout(address indexed to, uint256 amount, uint256 day, uint256 spentAfter)",
  "event Funded(address indexed from, uint256 amount)",
  "event PolicyUpdated(uint256 dailyCap, uint256 amountPerClaim, uint32 cooldownSeconds)",
  "event AdminTransferred(address indexed oldAdmin, address indexed newAdmin)",

  // ── B08 合约工程事件（B08 × B09 联动的第二个事件源）──
  // ERC-1967 的 Upgraded 由 OZ ERC1967Utils 发出 → UUPS 代理升级的链上证据：
  //   索引层能看到「升级→回滚」两次实现切换，就能把代理的代码版本史还原出来。
  "event Upgraded(address indexed implementation)",
  "event Claimed(bytes32 indexed leafHash, address indexed to, string data)", // B08 MerkleAirdrop
  "event Deployed(address indexed addr, bytes32 indexed salt, uint256 deployCount)", // B08 Create2Factory
  "event Withdrawn(address indexed who, uint256 amount)", // B08 VaultV2
  "event Executed(uint256 indexed nonce, bytes4 selector)", // B08 账户抽象 SmartAccount
  "event HandleOp(address indexed sender, uint256 nonce)", // B08 MiniEntryPoint
];

export const iface = new ethers.Interface(EVENT_FRAGMENTS);
const BY_TOPIC = new Map(iface.fragments.map((f) => [f.topicHash, f]));

// 交易方法登记（P03 SELECTORS + 凭证/水龙头常用方法）：未登记的不猜
export const SELECTORS = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
};

export function decodeMethod(input) {
  if (!input || input === "0x") return { selector: null, method: "原生转账" };
  const selector = input.slice(0, 10).toLowerCase();
  return { selector, method: SELECTORS[selector] ?? "未登记选择器" };
}

const LOWER_FIELDS = {
  from: ["from", "seller", "owner", "account", "actor", "holder", "previousOwner"],
  to: ["to", "buyer", "user", "operator", "newOwner", "redeemer", "sweeper", "approved"],
  tokenId: ["tokenId", "id", "_tokenId", "_fromTokenId"],
  batch: ["batchId", "listingId", "orderHash"],
};

function pick(args, names) {
  for (const n of names) if (args[n] != null) return String(args[n]);
  return null;
}

/** 解码一条日志 → { eventName, decoded, fromAddr, toAddr, tokenId, batch }；未知 topic0 照存原始 */
export function decodeLog(log) {
  const topics = [...log.topics];
  const out = { eventName: null, decoded: null, fromAddr: null, toAddr: null, tokenId: null, batch: null };
  const frag = BY_TOPIC.get(topics[0]);
  if (!frag) return out;
  try {
    const parsed = iface.parseLog({ topics, data: log.data });
    const args = {};
    parsed.fragment.inputs.forEach((inp, i) => {
      const v = parsed.args[i];
      args[inp.name] = typeof v === "bigint" ? v.toString() : v;
    });
    out.eventName = parsed.name;
    out.decoded = JSON.stringify(args);
    out.fromAddr = pick(args, LOWER_FIELDS.from);
    out.toAddr = pick(args, LOWER_FIELDS.to);
    out.tokenId = pick(args, LOWER_FIELDS.tokenId);
    out.batch = pick(args, LOWER_FIELDS.batch);
  } catch (e) {
    out.eventName = frag.name;
  }
  return out;
}

