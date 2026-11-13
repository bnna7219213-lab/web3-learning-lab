// B09 事件注册表：B05 记账单位 / B06 审批流 / B07 凭证与水龙头 / B08 工程事件。
// 同名事件必须按完整签名解码，不能只按名字猜业务类型。
import { ethers } from "ethers";

export const ERC20_TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 value)";
export const ERC20_APPROVAL = "event Approval(address indexed owner, address indexed spender, uint256 value)";
export const ERC721_TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)";
export const ERC721_APPROVAL = "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)";
export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export const EVENT_FRAGMENTS = [
  // 同 topic0、不同索引布局：ERC20 的 value 在 data，ERC721 的 tokenId 在 topics[3]。
  ERC721_TRANSFER,
  ERC20_TRANSFER,
  ERC721_APPROVAL,
  ERC20_APPROVAL,
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

  // B05 的 Transfer/Approval 与 ERC721 topic0 相同，但参数索引不同；
  // AccessControl 的 RoleGranted/RoleRevoked/RoleAdminChanged 共用上方片段。

  // ── B06 审批流 ApprovalFlow ──
  // 注意 `Executed` 与 B08 的 `Executed(uint256,bytes4)` 同名但签名不同 →
  //   topic0 不同（keccak 的是完整签名），两条可以共存，不会互相覆盖。
  "event Proposed(uint256 indexed id, address indexed proposer, string title)",
  "event Reviewed(uint256 indexed id, address indexed reviewer, bool approved, string reason)",
  "event Revoked(uint256 indexed id, address indexed by)",
  "event Executed(uint256 indexed id, address indexed by)",

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
const BY_TOPIC = new Map();
for (const fragment of iface.fragments) {
  const list = BY_TOPIC.get(fragment.topicHash) ?? [];
  list.push(fragment);
  BY_TOPIC.set(fragment.topicHash, list);
}

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
  tokenId: ["tokenId", "_tokenId", "_fromTokenId"],
  batch: ["batchId", "listingId", "orderHash"],
};

function pick(args, names) {
  for (const n of names) if (args[n] != null) return String(args[n]);
  return null;
}

/** 解码日志并区分资产语义；未知 topic0 照存原始，不能悄悄丢弃。 */
export function decodeLog(log) {
  const topics = [...log.topics];
  const out = {
    blockNumber: Number(log.blockNumber), blockHash: log.blockHash,
    txHash: log.transactionHash ?? log.txHash, logIndex: Number(log.logIndex),
    address: log.address, topic0: log.topic0 ?? topics[0] ?? null,
    topics: JSON.stringify(topics), data: log.data,
    eventName: null, decoded: null, fromAddr: null, toAddr: null,
    tokenId: null, batch: null, transferKind: null,
  };
  const fragments = BY_TOPIC.get(topics[0]);
  if (!fragments) return out;

  // ERC20 / ERC721 的 Transfer、Approval 共享 topic0；ethers 的 parseLog 只返回
  // 第一个同签名片段，无法靠它判断标准。按日志结构显式判定。
  if (topics[0] === TRANSFER_TOPIC && topics.length === 3) {
    out.transferKind = "erc20";
  } else if (topics[0] === TRANSFER_TOPIC && topics.length === 4) {
    out.transferKind = "erc721";
  }

  for (const frag of fragments) {
    try {
      const parsed = iface.decodeEventLog(frag, log.data, topics);
      const args = {};
      frag.inputs.forEach((inp, i) => {
        const v = parsed[i];
        args[inp.name] = typeof v === "bigint" ? v.toString() : v;
      });
      out.eventName = frag.name;
      out.decoded = JSON.stringify(args);
      out.fromAddr = pick(args, LOWER_FIELDS.from);
      out.toAddr = pick(args, LOWER_FIELDS.to);
      out.tokenId = out.transferKind === "erc721" ? pick(args, LOWER_FIELDS.tokenId) : null;
      out.batch = pick(args, LOWER_FIELDS.batch);
      return out;
    } catch {
      // 同 topic0 的另一条索引布局可能可解；全部失败时保留下面的原始事件名。
    }
  }
  out.eventName = fragments[0].name;
  return out;
}

