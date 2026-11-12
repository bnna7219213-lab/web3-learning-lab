import React, { useEffect, useMemo, useState } from "react";
import { WagmiProvider, useAccount, useConnect, useDisconnect, useSwitchChain, useReadContract, useReadContracts, useWriteContract, useWatchContractEvent, usePublicClient, useSignTypedData } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { anvil } from "wagmi/chains";
import { decodeErrorResult, parseEther } from "viem";
import nftAbi from "../../abi/LabNFT.json";
import edAbi from "../../abi/LabEditions.json";
import mkAbi from "../../abi/NFTMarket.json";
import record from "../../deployments/31337/P07.json";
import { makeConfig, installDemoProvider, DEMO_ACCOUNTS } from "./wallet.js";

const queryClient = new QueryClient();
const IPFS_API = "http://127.0.0.1:5001";
const GATEWAY = "http://127.0.0.1:8088";
const gw = (uri) => (uri || "").replace("ipfs://", `${GATEWAY}/ipfs/`);
const ABIS = [nftAbi, edAbi, mkAbi];

const ERROR_TEXT = {
  TradingDisabled: "二级市场入口未开启（合规默认关闭）：需 admin 显式开启",
  NotSeller: "只有挂单卖家能下架",
  InactiveListing: "挂单已失效（成交或下架）",
  WrongPayment: "支付金额与挂单价不一致",
  BadSignature: "签名校验失败（改价/代签/域不匹配）",
  BadNonce: "订单 nonce 已用（重放）",
  OrderExpired: "签名订单已过期",
  NotAuthorizedForToken: "只有 owner 或授权操作者能设置租期",
  ZeroPrice: "价格必须大于 0",
  ZeroAmount: "份数必须大于 0",
};

function explainError(err) {
  let e = err;
  while (e) {
    if (typeof e.data === "string" && e.data.startsWith("0x") && e.data.length >= 10) {
      for (const abi of ABIS) {
        try {
          const { errorName } = decodeErrorResult({ abi, data: e.data });
          return ERROR_TEXT[errorName] || `合约拒绝：${errorName}`;
        } catch { /* 换下一个 ABI */ }
      }
    }
    e = e.cause;
  }
  return err.shortMessage || err.message || "未知错误";
}

function useReceipt(hash) {
  const client = usePublicClient();
  const [rec, setRec] = useState(null);
  const [reason, setReason] = useState(null);
  useEffect(() => {
    if (!hash || !client) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const r = await client.getTransactionReceipt({ hash });
        if (stop) return;
        setRec(r);
        if (r.status === "reverted") {
          const tx = await client.getTransaction({ hash });
          try {
            await client.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, blockNumber: r.blockNumber });
          } catch (e) {
            if (!stop) setReason(explainError(e));
          }
        }
        return;
      } catch { /* 未入块 */ }
      if (!stop) setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; };
  }, [hash, client]);
  return { rec, reason };
}

function TxStatus({ hash, error, reason }) {
  const { rec, reason: r2 } = useReceipt(hash);
  return (
    <>
      {hash && <p className="note">tx {hash.slice(0, 14)}… {rec ? `入块 #${rec.blockNumber} status=${rec.status === "success" ? 1 : 0}` : "等待入块…"}</p>}
      {error && <p className="bad">失败：{explainError(error)}</p>}
      {(reason || r2) && <p className="bad">入块但执行失败：{reason || r2}</p>}
    </>
  );
}

async function ipfsAdd(buf, filename) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  const res = await fetch(`${IPFS_API}/api/v0/add?pin=true&cid-version=1`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`IPFS add ${res.status}（kubo daemon 没起？见 README）`);
  return (await res.json()).Hash;
}

export default function App() {
  const [mode, setMode] = useState(null);
  const config = useMemo(() => (mode ? makeConfig() : null), [mode]);
  if (!mode) {
    return (
      <div className="pick">
        <h1>P07 · NFT 市场</h1>
        <p className="note">ERC721/1155 铸造—挂单—成交—下架 + EIP-4907 租期 + ERC2981 版税 + 签名订单。元数据在本地 IPFS。</p>
        <button onClick={() => setMode("metamask")}>连接 MetaMask（浏览器扩展）</button>
        <button onClick={() => { installDemoProvider(); setMode("demo"); }}>使用本地演示钱包（anvil 解锁账户 · 零私钥）</button>
      </div>
    );
  }
  return (
    <WagmiProvider config={config} key={mode}>
      <QueryClientProvider client={queryClient}>
        <Dapp mode={mode} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Dapp({ mode }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [events, setEvents] = useState([]);
  const { nft, editions, market } = record;

  const push = (name) => (logs) => {
    setEvents((p) => [...logs.map((l) => ({ time: new Date().toLocaleTimeString("zh-CN"), name, args: l.args })), ...p].slice(0, 30));
    queryClient.invalidateQueries();
  };
  useWatchContractEvent({ abi: mkAbi, address: market, eventName: "Listed", onLogs: push("Listed") });
  useWatchContractEvent({ abi: mkAbi, address: market, eventName: "Sold", onLogs: push("Sold") });
  useWatchContractEvent({ abi: mkAbi, address: market, eventName: "Cancelled", onLogs: push("Cancelled") });
  useWatchContractEvent({ abi: mkAbi, address: market, eventName: "OrderFilled", onLogs: push("OrderFilled") });
  useWatchContractEvent({ abi: nftAbi, address: nft, eventName: "UpdateUser", onLogs: push("UpdateUser") });

  const { data: trading } = useReadContract({ abi: mkAbi, address: market, functionName: "tradingEnabled", query: { refetchInterval: 2000 } });
  const { data: owner } = useReadContract({ abi: mkAbi, address: market, functionName: "owner" });
  const { data: nextId } = useReadContract({ abi: nftAbi, address: nft, functionName: "nextId", query: { refetchInterval: 2000 } });
  const { data: minterRole } = useReadContract({ abi: nftAbi, address: nft, functionName: "MINTER_ROLE" });
  const { data: isMinter } = useReadContract({ abi: nftAbi, address: nft, functionName: "hasRole", args: minterRole && address ? [minterRole, address] : undefined, query: { enabled: !!minterRole && !!address } });
  const { data: listCount } = useReadContract({ abi: mkAbi, address: market, functionName: "listingCount", query: { refetchInterval: 2000 } });
  const { data: listings } = useReadContracts({
    contracts: Array.from({ length: Number(listCount ?? 0n) }, (_, i) => ({ address: market, abi: mkAbi, functionName: "listings", args: [BigInt(i)] })),
    query: { refetchInterval: 2000 },
  });

  const wrongNetwork = isConnected && chainId !== anvil.id;
  const ready = isConnected && !wrongNetwork;
  const isAdmin = address && owner && address.toLowerCase() === owner.toLowerCase();
  const rows = (listings ?? [])
    .map((r, i) => {
      const v = r.result; // tuple 返回是数组，不是对象
      return v ? { id: i, seller: v[0], nft: v[1], tokenId: v[2], amount: v[3], price: v[4], active: v[5] } : null;
    })
    .filter((l) => l && l.active);
  const ids = Array.from({ length: Number(nextId ?? 0n) }, (_, i) => i);

  return (
    <div className="wrap">
      <header>
        <h1>P07 · NFT 市场</h1>
        <div className="conn">
          {!isConnected ? <button onClick={() => connect({ connector: connectors[0] })}>连接钱包</button> : (
            <>
              <span className="ok">{address.slice(0, 8)}…{address.slice(-4)}</span>
              <span className={wrongNetwork ? "bad" : "ok"}>chain {chainId}</span>
              <button onClick={() => disconnect()}>断开</button>
            </>
          )}
        </div>
      </header>

      {wrongNetwork && (
        <p className="bad banner">网络不匹配：当前 {chainId}，只接受 Anvil (31337)。写操作已禁用。
          <button onClick={() => switchChain({ chainId: anvil.id })}>切换到 Anvil</button></p>
      )}

      {mode === "demo" && isConnected && (
        <section className="demo">
          <b>演示钱包</b>
          <select value={window.ethereum._accountIndex()} onChange={(e) => window.ethereum._setAccount(Number(e.target.value))}>
            {DEMO_ACCOUNTS.map((a, i) => <option key={a} value={i}>#{i} {a.slice(0, 8)}…</option>)}
          </select>
          <button onClick={() => window.ethereum._setWrongNetwork(true)}>模拟错误网络</button>
        </section>
      )}

      <section className="card">
        <h2>市场状态（合规开关）</h2>
        <p>tradingEnabled = <b className={trading ? "ok" : "bad"}>{String(trading)}</b>
          {trading === false && <span className="note">　二级市场入口默认关闭；开启是 admin 的显式治理动作</span>}</p>
        {isAdmin && <TradingToggle on={trading} market={market} />}
      </section>

      {ready && isMinter && <MintForm nft={nft} editions={editions} address={address} />}

      <section>
        <h2>画廊（{ids.length} 个 721）</h2>
        {ids.length === 0 && <p className="note">还没有 NFT。minter 连接后可铸造（元数据自动 pin 到本地 IPFS）。</p>}
        {ids.map((id) => (
          <TokenCard key={id} id={id} nft={nft} market={market} address={address} ready={ready}
            listing={rows.find((l) => l.nft?.toLowerCase() === nft.toLowerCase() && Number(l.tokenId) === id)} />
        ))}
      </section>

      {ready && <EditionsPanel editions={editions} market={market} address={address} ready={ready} />}

      <section>
        <h2>活跃挂单（{rows.length}）</h2>
        {rows.length === 0 && <p className="note">无活跃挂单。</p>}
        {rows.map((l) => <ListingRow key={l.id} l={l} market={market} address={address} ready={ready} />)}
      </section>

      {ready && <SignedOrderPanel market={market} nft={nft} address={address} />}

      <section>
        <h2>事件流</h2>
        {events.length === 0 && <p className="note">暂无事件。</p>}
        <table><tbody>
          {events.map((e, i) => (
            <tr key={i}><td>{e.time}</td><td>{e.name}</td>
              <td className="mono">{JSON.stringify(e.args, (k, v) => (typeof v === "bigint" ? v.toString() : v))}</td></tr>
          ))}
        </tbody></table>
      </section>
    </div>
  );
}

function TradingToggle({ on, market }) {
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  return (
    <>
      <button disabled={isPending} onClick={() => writeContract({ abi: mkAbi, address: market, functionName: "setTradingEnabled", args: [!on] })}>
        {on ? "关闭二级市场入口" : "开启二级市场入口"}
      </button>
      <TxStatus hash={hash} error={error} />
    </>
  );
}

function MintForm({ nft, editions, address }) {
  const [name, setName] = useState("Lab NFT");
  const [desc, setDesc] = useState("学习用 NFT 凭证（零价值）");
  const [file, setFile] = useState(null);
  const [edId, setEdId] = useState(1);
  const [edAmt, setEdAmt] = useState(10);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const { writeContract, data: hash, error } = useWriteContract();

  const pin = async () => {
    let imageUri = "";
    if (file) imageUri = `ipfs://${await ipfsAdd(await file.arrayBuffer(), file.name)}`;
    const meta = { name, description: desc, image: imageUri, attributes: [{ trait_type: "value", value: "zero" }] };
    const cid = await ipfsAdd(new TextEncoder().encode(JSON.stringify(meta, null, 2)), "metadata.json");
    return `ipfs://${cid}`;
  };

  return (
    <section className="card">
      <h2>铸造（minter）</h2>
      <label>名称 <input value={name} onChange={(e) => setName(e.target.value)} size="24" /></label>
      <label>描述 <input value={desc} onChange={(e) => setDesc(e.target.value)} size="32" /></label>
      <label>图片 <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files[0])} /></label>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setMsg("");
        try {
          const uri = await pin();
          setMsg(`已 pin：${uri}`);
          writeContract({ abi: nftAbi, address: nft, functionName: "mint", args: [address, uri] });
        } catch (e) { setMsg(e.message); }
        setBusy(false);
      }}>{busy ? "pin 中…" : "铸造 721"}</button>
      <label>1155 id <input type="number" value={edId} onChange={(e) => setEdId(e.target.value)} size="4" /></label>
      <label>份数 <input type="number" value={edAmt} onChange={(e) => setEdAmt(e.target.value)} size="4" /></label>
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const uri = await pin();
          writeContract({ abi: edAbi, address: editions, functionName: "mint", args: [address, BigInt(edId), BigInt(edAmt), uri] });
        } catch (e) { setMsg(e.message); }
        setBusy(false);
      }}>铸造 1155</button>
      {msg && <p className="note">{msg}</p>}
      <TxStatus hash={hash} error={error} />
    </section>
  );
}

function TokenCard({ id, nft, market, address, ready, listing }) {
  const { data: owner } = useReadContract({ abi: nftAbi, address: nft, functionName: "ownerOf", args: [BigInt(id)], query: { refetchInterval: 2000 } });
  const { data: uri } = useReadContract({ abi: nftAbi, address: nft, functionName: "tokenURI", args: [BigInt(id)] });
  const { data: user } = useReadContract({ abi: nftAbi, address: nft, functionName: "userOf", args: [BigInt(id)], query: { refetchInterval: 2000 } });
  const { data: expires } = useReadContract({ abi: nftAbi, address: nft, functionName: "userExpires", args: [BigInt(id)] });
  const [meta, setMeta] = useState(null);
  const [price, setPrice] = useState("1");
  const [rentUser, setRentUser] = useState("");
  const [rentHours, setRentHours] = useState(24);
  const { writeContract, writeContractAsync, data: hash, error, reset } = useWriteContract();
  const { data: approved } = useReadContract({ abi: nftAbi, address: nft, functionName: "isApprovedForAll", args: address ? [address, market] : undefined, query: { enabled: !!address, refetchInterval: 2000 } });

  const doList = async () => {
    reset();
    // 托管前置授权：未授权先补 setApprovalForAll；同 sender 的 nonce 顺序保证先授权后挂单
    if (!approved) await writeContractAsync({ abi: nftAbi, address: nft, functionName: "setApprovalForAll", args: [market, true] });
    await writeContractAsync({ abi: mkAbi, address: market, functionName: "list", args: [nft, BigInt(id), 1n, parseEther(price)] });
  };

  useEffect(() => {
    if (!uri) return;
    fetch(gw(uri)).then((r) => r.json()).then(setMeta).catch(() => setMeta(null));
  }, [uri]);

  const mine = owner && address && owner.toLowerCase() === address.toLowerCase();
  return (
    <div className="card">
      <h3>#{id} {meta?.name ?? "…"} {listing && <span className="ok">[挂单中 {listing.price ? (Number(listing.price) / 1e18).toString() : ""} ETH]</span>}</h3>
      {meta?.image && <img src={gw(meta.image)} alt="" width="96" height="96" />}
      <p className="note">owner {owner?.slice(0, 10)}… · user {user === "0x0000000000000000000000000000000000000000" ? "无" : user?.slice(0, 10) + "…"}
        {Number(expires ?? 0) > 0 && ` · 租期至 ${new Date(Number(expires) * 1000).toLocaleString("zh-CN")}`}</p>
      {mine && !listing && (
        <>
          <label>挂单价 ETH <input value={price} onChange={(e) => setPrice(e.target.value)} size="8" /></label>
          <button disabled={!ready} onClick={doList}>挂单（托管进市场）</button>
        </>
      )}
      {mine && (
        <>
          <label>租给 <input value={rentUser} onChange={(e) => setRentUser(e.target.value)} size="42" placeholder="0x…" /></label>
          <label>小时 <input type="number" value={rentHours} onChange={(e) => setRentHours(e.target.value)} size="5" /></label>
          <button disabled={!ready || !rentUser} onClick={() => { reset(); writeContract({ abi: nftAbi, address: nft, functionName: "setUser", args: [BigInt(id), rentUser, BigInt(Math.floor(Date.now() / 1000) + Number(rentHours) * 3600)] }); }}>设置租期（4907）</button>
        </>
      )}
      <TxStatus hash={hash} error={error} />
    </div>
  );
}

function EditionsPanel({ editions, market, address, ready }) {
  const [id, setId] = useState(1);
  const [amount, setAmount] = useState(4);
  const [price, setPrice] = useState("2");
  const { data: bal } = useReadContract({ abi: edAbi, address: editions, functionName: "balanceOf", args: address ? [address, BigInt(id)] : undefined, query: { enabled: !!address, refetchInterval: 2000 } });
  const { data: approved } = useReadContract({ abi: edAbi, address: editions, functionName: "isApprovedForAll", args: address ? [address, market] : undefined, query: { enabled: !!address, refetchInterval: 2000 } });
  const { writeContractAsync, data: hash, error, reset } = useWriteContract();
  const doList = async () => {
    reset();
    if (!approved) await writeContractAsync({ abi: edAbi, address: editions, functionName: "setApprovalForAll", args: [market, true] });
    await writeContractAsync({ abi: mkAbi, address: market, functionName: "list", args: [editions, BigInt(id), BigInt(amount), parseEther(price)] });
  };
  return (
    <section className="card">
      <h2>1155 挂单（多份托管）</h2>
      <label>id <input type="number" value={id} onChange={(e) => setId(e.target.value)} size="4" /></label>
      <label>份数 <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} size="4" /></label>
      <label>总价 ETH <input value={price} onChange={(e) => setPrice(e.target.value)} size="8" /></label>
      <p className="note">当前账户持有 id#{id}：{String(bal ?? 0n)} 份</p>
      <button disabled={!ready || !address || (bal ?? 0n) < BigInt(amount || 0)} onClick={doList}>挂单 1155</button>
      <TxStatus hash={hash} error={error} />
    </section>
  );
}

function ListingRow({ l, market, address, ready }) {
  const { writeContract, data: hash, error, reset } = useWriteContract();
  const isSeller = address && l.seller?.toLowerCase() === address.toLowerCase();
  return (
    <div className="card">
      <p>挂单#{l.id} · {l.nft?.slice(0, 10)}… token#{String(l.tokenId)} ×{String(l.amount)} · <b>{(Number(l.price) / 1e18).toString()} ETH</b> · 卖家 {l.seller?.slice(0, 10)}…</p>
      <button disabled={!ready} onClick={() => { reset(); writeContract({ abi: mkAbi, address: market, functionName: "buy", args: [BigInt(l.id)], value: l.price }); }}>购买</button>
      {isSeller && <button disabled={!ready} onClick={() => { reset(); writeContract({ abi: mkAbi, address: market, functionName: "cancel", args: [BigInt(l.id)] }); }}>下架</button>}
      <TxStatus hash={hash} error={error} />
    </div>
  );
}

function SignedOrderPanel({ market, nft, address }) {
  const [price, setPrice] = useState("0.5");
  const [order, setOrder] = useState(null);
  const { data: nonce } = useReadContract({ abi: mkAbi, address: market, functionName: "orderNonces", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { refetchInterval: 2000 } });
  const { signTypedData, data: sig, error: signError, isPending } = useSignTypedData();
  const { writeContract, data: hash, error, reset } = useWriteContract();

  const sign = () => {
    const o = { seller: address, nft, tokenId: 0n, amount: 1n, price: parseEther(price), nonce: nonce ?? 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    setOrder(o);
    signTypedData({
      domain: { name: "NFTMarket", version: "1", chainId: anvil.id, verifyingContract: market },
      types: { SellOrder: [
        { name: "seller", type: "address" }, { name: "nft", type: "address" }, { name: "tokenId", type: "uint256" },
        { name: "amount", type: "uint256" }, { name: "price", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "SellOrder",
      message: o,
    });
  };

  return (
    <section className="card">
      <h2>签名卖单（链下撮合原语：不托管）</h2>
      <label>价格 ETH <input value={price} onChange={(e) => setPrice(e.target.value)} size="8" /></label>
      <button disabled={isPending || !address} onClick={sign}>以当前账户签名卖单（token#0）</button>
      {sig && order && (
        <>
          <p className="note">签名完成：切换账户后以买家身份成交（nonce={String(order.nonce)}，1 小时内有效）</p>
          <button disabled={!address} onClick={() => { reset(); writeContract({ abi: mkAbi, address: market, functionName: "fillOrder", args: [order, sig], value: order.price }); }}>以当前账户成交该卖单</button>
        </>
      )}
      {signError && <p className="bad">签名失败：{explainError(signError)}</p>}
      <TxStatus hash={hash} error={error} />
    </section>
  );
}