// ERC-20 识别：receipt logs 里的 Transfer(address indexed from, address indexed to, uint256 value)
// topic0 = keccak("Transfer(address,address,uint256)")，为静态常量（app.js 的 TOPICS 同值）
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// 最小 ABI：读代币元数据
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

// topic（32字节）→ 40 位地址
function topicToAddr(t) {
  return "0x" + String(t).slice(-40).toLowerCase();
}

// 从单笔回执里抽出所有 ERC-20 Transfer（含 mint: from=0x0、burn: to=0x0）
function extractTransfers(receipt) {
  const out = [];
  const logs = receipt.logs || [];
  for (const l of logs) {
    // ERC20 是 3 topics + 32B data；ERC721 同名事件为 4 topics + 空 data。
    // 后者不能进代币转账表，否则 BigInt("0x") 会让整个扫描批次永久停在同一高度。
    if (!l.topics || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(l.data || "")) continue;
    out.push({
      txHash: receipt.transactionHash || l.transactionHash,
      blockNumber: Number(BigInt(receipt.blockNumber || "0x0")),
      logIndex: Number(BigInt(l.logIndex || "0x0")),
      token: String(l.address).toLowerCase(),
      from: topicToAddr(l.topics[1]),
      to: topicToAddr(l.topics[2]),
      value: BigInt(l.data || "0x0").toString(10),
    });
  }
  return out;
}

// 遇到新代币合约 → eth_call 拉元数据缓存（读失败容错：存 null，页面显示"未验证元数据"）
async function fetchTokenMeta(provider, tokenAddr, blockNumber) {
  const { Contract } = require("ethers");
  const c = new Contract(tokenAddr, ERC20_ABI, provider);
  const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
    c.name(), c.symbol(), c.decimals(), c.totalSupply(),
  ]);
  return {
    address: tokenAddr,
    name: name.status === "fulfilled" ? String(name.value) : null,
    symbol: symbol.status === "fulfilled" ? String(symbol.value) : null,
    decimals: decimals.status === "fulfilled" ? Number(decimals.value) : null,
    totalSupply: totalSupply.status === "fulfilled" ? BigInt(totalSupply.value).toString(10) : null,
    firstBlock: blockNumber,
  };
}

module.exports = { TRANSFER_TOPIC, extractTransfers, fetchTokenMeta };
