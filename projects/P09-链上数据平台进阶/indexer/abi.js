// 事件注册表 + 解码。复用 P03 scripts/lib.mjs 的 decodeLog/decodeInput 思路：
// topic0 = keccak(签名)，indexed 参数从 topics 取，其余从 data 解码。
// 事件源是 P07 三件套（LabNFT / LabEditions / NFTMarket），签名与 abi/*.json 逐字对齐。
import { ethers } from "ethers";

export const EVENT_FRAGMENTS = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires)",
  "event MetadataUpdate(uint256 _tokenId)",
  "event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event URI(string value, uint256 indexed id)",
  "event Listed(uint256 indexed listingId, address indexed seller, address indexed nft, uint256 tokenId, uint256 amount, uint256 price)",
  "event Sold(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 royaltyPaid)",
  "event OrderFilled(bytes32 indexed orderHash, address indexed seller, address indexed buyer, address nft, uint256 tokenId, uint256 amount, uint256 price)",
  "event Cancelled(uint256 indexed listingId)",
  "event TradingEnabled(bool on)",
];

export const iface = new ethers.Interface(EVENT_FRAGMENTS);
const BY_TOPIC = new Map(iface.fragments.map((f) => [f.topicHash, f]));

// 交易方法登记（P03 SELECTORS 原样 + ERC721 常用）：够用即可，未知选择器不猜
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

/**
 * 解码一条日志 → { eventName, decoded, fromAddr, toAddr, tokenId, batch }
 * 未登记的 topic0 不猜语义：eventName=null，原始 topics/data 照存（可查询、可出证）。
 */
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
    out.eventName = frag.name; // 解码失败（形状不符）也记下名字，data 留原始
  }
  return out;
}

