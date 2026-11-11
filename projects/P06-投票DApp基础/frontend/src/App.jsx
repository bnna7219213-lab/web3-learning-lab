import React, { useEffect, useMemo, useState } from "react";
import { WagmiProvider, useAccount, useConnect, useDisconnect, useSwitchChain, useReadContract, useWriteContract, useWatchContractEvent, usePublicClient } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { anvil } from "wagmi/chains";
import { decodeErrorResult } from "viem";
import votingAbi from "../../abi/Voting.json";
import votingRecord from "../../deployments/31337/Voting.json";
import { makeConfig, installDemoProvider, DEMO_ACCOUNTS } from "./wallet.js";

const abi = votingAbi;
const queryClient = new QueryClient();

const ERROR_TEXT = {
  AlreadyVoted: "你已投过该提案：一人一票，换立场也不行",
  VotingClosed: "投票已截止（超过 deadline）",
  ProposalNotFound: "提案不存在",
  OwnableUnauthorizedAccount: "只有 admin 能创建提案",
  EmptyTitle: "标题不能为空",
  ZeroDuration: "投票时长必须大于 0",
};

// 交易失败要给可诊断信息：逐层 cause 找 revert data，用 ABI 解码成中文文案
function explainError(err) {
  let e = err;
  while (e) {
    if (typeof e.data === "string" && e.data.startsWith("0x") && e.data.length >= 10) {
      try {
        const { errorName } = decodeErrorResult({ abi, data: e.data });
        return ERROR_TEXT[errorName] || `合约拒绝：${errorName}`;
      } catch { /* 不是本合约的自定义错误，继续往下找 */ }
    }
    e = e.cause;
  }
  return err.shortMessage || err.message || "未知错误";
}

// 显式轮询回执：入块后若 status=reverted，在入块高度重放 eth_call 取 revert 原因。
// 回执本身不带 reason——这是 P03 手册 §4 的同一条技术。
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
      } catch { /* 尚未入块 */ }
      if (!stop) setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; };
  }, [hash, client]);
  return { rec, reason };
}

export default function App() {
  const [mode, setMode] = useState(null);
  const config = useMemo(() => (mode ? makeConfig() : null), [mode]);
  if (!mode) {
    return (
      <div className="pick">
        <h1>P06 · 投票 DApp</h1>
        <p className="note">合约 + React/Wagmi + 钱包 + 事件刷新的全栈最小闭环。两条钱包路径共用 injected 连接器（同一套 EIP-1193 代码）。</p>
        <button onClick={() => setMode("metamask")}>连接 MetaMask（浏览器扩展）</button>
        <button onClick={() => { installDemoProvider(); setMode("demo"); }}>使用本地演示钱包（anvil 解锁账户 · 零私钥）</button>
        <p className="note">演示钱包把 eth_sendTransaction 转给 anvil 节点代签；MetaMask 路径需本机安装扩展并添加 Anvil 网络（31337，RPC http://127.0.0.1:8545）。</p>
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
  const { connect, connectors, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const contract = votingRecord.address;
  const [events, setEvents] = useState([]);

  const pushEvents = (name) => (logs) => {
    setEvents((prev) => [...logs.map((l) => ({ time: new Date().toLocaleTimeString("zh-CN"), name, args: l.args })), ...prev].slice(0, 30));
    // 事件驱动刷新：失效全部 readContract 缓存，活跃观察者自动重取（wagmi 官方模式）
    queryClient.invalidateQueries();
  };
  useWatchContractEvent({ abi, address: contract, eventName: "ProposalCreated", onLogs: pushEvents("ProposalCreated"), enabled: !!contract });
  useWatchContractEvent({ abi, address: contract, eventName: "Voted", onLogs: pushEvents("Voted"), enabled: !!contract });

  const { data: owner } = useReadContract({ abi, address: contract, functionName: "owner", query: { enabled: !!contract } });
  const { data: count } = useReadContract({ abi, address: contract, functionName: "proposalCount", query: { enabled: !!contract, refetchInterval: 2000 } });

  const wrongNetwork = isConnected && chainId !== anvil.id;
  const ready = isConnected && !wrongNetwork && !!contract;
  const ids = count ? Array.from({ length: Number(count) }, (_, i) => i) : [];

  return (
    <div className="wrap">
      <header>
        <h1>P06 · 投票 DApp</h1>
        <div className="conn">
          {!isConnected ? (
            <button onClick={() => connect({ connector: connectors[0] })}>连接钱包</button>
          ) : (
            <>
              <span className="ok">{address.slice(0, 8)}…{address.slice(-4)}</span>
              <span className={wrongNetwork ? "bad" : "ok"}>chain {chainId}</span>
              <button onClick={() => disconnect()}>断开</button>
            </>
          )}
        </div>
        {connectError && <p className="bad">连接失败：{explainError(connectError)}</p>}
      </header>

      {wrongNetwork && (
        <p className="bad banner">
          网络不匹配：当前 chainId {chainId}，本 DApp 只接受 Anvil (31337)。已禁用全部写操作。
          <button onClick={() => switchChain({ chainId: anvil.id })}>切换到 Anvil</button>
        </p>
      )}

      {mode === "demo" && isConnected && (
        <section className="demo">
          <b>演示钱包控制</b>
          <label>账户
            <select value={window.ethereum._accountIndex()} onChange={(e) => window.ethereum._setAccount(Number(e.target.value))}>
              {DEMO_ACCOUNTS.map((a, i) => <option key={a} value={i}>#{i} {a.slice(0, 8)}…</option>)}
            </select>
          </label>
          <button onClick={() => window.ethereum._setWrongNetwork(true)}>模拟错误网络</button>
          <span className="note">切换账户/网络会发 accountsChanged / chainChanged 事件——与 MetaMask 行为一致</span>
        </section>
      )}

      {ready && address && owner && address.toLowerCase() === owner.toLowerCase() && (
        <CreateForm contract={contract} />
      )}

      <section>
        <h2>提案（{ids.length}）</h2>
        {ids.length === 0 && <p className="note">还没有提案。admin 账户连接后可创建。</p>}
        {ids.map((id) => <ProposalCard key={id} id={id} contract={contract} address={address} ready={ready} />)}
      </section>

      <section>
        <h2>事件流（watchContractEvent 实时刷新）</h2>
        {events.length === 0 && <p className="note">暂无事件。另一个浏览器页投票，这里也会实时出现。</p>}
        <table>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td>{e.time}</td>
                <td>{e.name}</td>
                <td className="mono">{JSON.stringify(e.args, (k, v) => (typeof v === "bigint" ? v.toString() : v))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CreateForm({ contract }) {
  const [title, setTitle] = useState("");
  const [hours, setHours] = useState(24);
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { rec, reason } = useReceipt(hash);
  return (
    <section>
      <h2>创建提案（admin）</h2>
      <label>标题 <input value={title} onChange={(e) => setTitle(e.target.value)} size="40" /></label>
      <label>时长（小时） <input type="number" value={hours} onChange={(e) => setHours(e.target.value)} size="6" /></label>
      <button disabled={isPending || !title} onClick={() => writeContract({ abi, address: contract, functionName: "createProposal", args: [title, BigInt(Math.round(Number(hours) * 3600))] })}>
        {isPending ? "等待钱包/节点…" : "创建"}
      </button>
      {hash && <p className="note">tx {hash.slice(0, 14)}… {rec ? `入块 #${rec.blockNumber} status=${rec.status === "success" ? 1 : 0}` : "等待入块…"}</p>}
      {error && <p className="bad">创建失败：{explainError(error)}</p>}
      {reason && <p className="bad">入块但执行失败：{reason}</p>}
    </section>
  );
}

function ProposalCard({ id, contract, address, ready }) {
  const { data: p } = useReadContract({ abi, address: contract, functionName: "getProposal", args: [BigInt(id)], query: { enabled: !!contract, refetchInterval: 2000 } });
  const { data: t } = useReadContract({ abi, address: contract, functionName: "tally", args: [BigInt(id)], query: { enabled: !!contract, refetchInterval: 2000 } });
  const { data: voted } = useReadContract({ abi, address: contract, functionName: "hasVoted", args: [BigInt(id), address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: !!contract && !!address, refetchInterval: 2000 } });
  const { writeContract, data: hash, error, isPending, reset } = useWriteContract();
  const { rec, reason } = useReceipt(hash);
  if (!p) return null;
  const [title, deadline, forVotes, againstVotes] = p;
  const total = Number((t?.[0] ?? forVotes) + (t?.[1] ?? againstVotes));
  const closed = Date.now() / 1000 > Number(deadline);
  const vote = (support) => { reset(); writeContract({ abi, address: contract, functionName: "vote", args: [BigInt(id), support] }); };
  return (
    <div className="card">
      <h3>#{id} {title}</h3>
      <p className="note">截止 {new Date(Number(deadline) * 1000).toLocaleString("zh-CN")} {closed ? "（已结束）" : ""}</p>
      <div className="bar">
        <div className="for" style={{ width: total ? `${(Number(t?.[0] ?? forVotes) / total) * 100}%` : "0%" }} />
      </div>
      <p>赞成 {String(t?.[0] ?? forVotes)} · 反对 {String(t?.[1] ?? againstVotes)} {voted && <span className="ok">（你已投票）</span>}</p>
      <button disabled={!ready || closed || voted || isPending} onClick={() => vote(true)}>赞成</button>
      <button disabled={!ready || closed || voted || isPending} onClick={() => vote(false)}>反对</button>
      {hash && <p className="note">tx {hash.slice(0, 14)}… {rec ? `入块 #${rec.blockNumber} status=${rec.status === "success" ? 1 : 0}` : "等待入块…"}</p>}
      {error && <p className="bad">投票失败：{explainError(error)}</p>}
      {reason && <p className="bad">入块但执行失败：{reason}</p>}
    </div>
  );
}