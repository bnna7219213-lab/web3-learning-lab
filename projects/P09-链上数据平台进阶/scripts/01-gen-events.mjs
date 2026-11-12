// 在 anvil 上制造 P07 事件流（索引器的"教材数据"）：
//   铸造 ×3 → 转移 → 授权 → 挂单 → 成交 → 设租期
// 全程用 anvil 解锁账户 eth_sendTransaction，仓库零私钥。
import { ethers } from "ethers";
import { rpc, accounts, sendTx, loadDeployment, loadAbi, head, ok, hr, summary } from "./lib.mjs";

hr("01 generate P07 event stream on anvil");
const dep = loadDeployment();
const accs = await accounts();
const [admin, alice, bob, carol] = accs;
console.log("  合约: nft=%s market=%s editions=%s", dep.nft, dep.market, dep.editions);
console.log("  账户: admin=%s alice=%s bob=%s", admin, alice, bob);

const nftIface = new ethers.Interface(loadAbi("LabNFT"));
const marketIface = new ethers.Interface(loadAbi("NFTMarket"));
const enc = (iface, fn, args) => iface.encodeFunctionData(fn, args);

// 前置：市场交易开关（部署记录默认关）
const tradingOn = await rpc("eth_call", [{ to: dep.market, data: marketIface.encodeFunctionData("tradingEnabled", []) }, "latest"]);
if (BigInt(tradingOn) === 0n) {
  await sendTx(admin, dep.market, enc(marketIface, "setTradingEnabled", [true]));
  ok(true, "市场 tradingEnabled=true（挂单/成交才放行）");
}

// 1) 铸造 3 个 NFT 给 alice（Transfer from=0x0）
const ids = [];
for (let i = 1; i <= 3; i++) {
  const { rec } = await sendTx(admin, dep.nft, enc(nftIface, "mint", [alice, `ipfs://p09-demo/${i}.json`]));
  ok(rec.status === "0x1", `铸造 #${i} 入块（block ${Number(rec.blockNumber)}）`);
}
const nextId = BigInt(await rpc("eth_call", [{ to: dep.nft, data: nftIface.encodeFunctionData("nextId", []) }, "latest"]));
for (let i = 1; i <= 3; i++) ids.push(nextId - BigInt(4 - i));

// 2) alice → bob 转移 1 个（Transfer 非零地址）
await sendTx(alice, dep.nft, enc(nftIface, "transferFrom", [alice, bob, ids[0]]));
ok(true, `转移 token#${ids[0]} alice→bob`);

// 3) alice 授权市场（ApprovalForAll）+ 挂单（Listed）
await sendTx(alice, dep.nft, enc(nftIface, "setApprovalForAll", [dep.market, true]));
const price = ethers.parseEther("1").toString();
await sendTx(alice, dep.market, enc(marketIface, "list", [dep.nft, ids[1], 1, price]));
ok(true, `挂单 token#${ids[1]} @ 1 ETH（Listed）`);

// 4) bob 购买（Sold + Transfer）
const listingId = BigInt(await rpc("eth_call", [{ to: dep.market, data: marketIface.encodeFunctionData("listingCount", []) }, "latest"]));
await sendTx(bob, dep.market, enc(marketIface, "buy", [listingId - 1n]));
ok(true, `成交 listing#${listingId - 1n}（Sold）`);

// 5) 设租期（UpdateUser，EIP-4907）
const expires = BigInt(Math.floor(Date.now() / 1000) + 86400);
await sendTx(alice, dep.nft, enc(nftIface, "setUser", [ids[2], carol, expires]));
ok(true, `设租期 token#${ids[2]} → carol（UpdateUser）`);

console.log(`  链高: ${await head()}`);
summary("01 gen-events");

