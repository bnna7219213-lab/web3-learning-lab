// 钱包层：两条路径共用 wagmi 的 injected 连接器（同一套 EIP-1193 代码）。
//  - MetaMask：浏览器扩展注入 window.ethereum，直接连。
//  - 本地演示钱包：安装一个 EIP-1193 shim，把 eth_sendTransaction 转给 anvil 的解锁账户
//    （节点代签，前端零私钥）；读请求直接转发 anvil RPC。
// shim 不是「另一套钱包逻辑」：它和 MetaMask 对 DApp暴露同一个接口，
// 因此无扩展环境里的 E2E 走的就是 MetaMask 会走的代码路径。
import { createConfig, http } from "wagmi";
import { anvil, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const ANVIL_RPC = "http://127.0.0.1:8545";
// anvil 默认 mnemonic 的前 5 个账户地址（公开测试材料，非私钥）
export const DEMO_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

async function rpc(method, params = []) {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

export function installDemoProvider() {
  if (window.ethereum?.isLabDemo) return window.ethereum;
  const listeners = new Map();
  let accountIndex = 0;
  let wrongNetwork = false;
  const emit = (ev, payload) => (listeners.get(ev) || []).forEach((cb) => cb(payload));
  const chainHex = () => "0x" + (wrongNetwork ? 1 : anvil.id).toString(16);

  const provider = {
    isLabDemo: true,
    isMetaMask: false,
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId":
          return chainHex();
        case "net_version":
          return String(wrongNetwork ? 1 : anvil.id);
        case "eth_accounts":
        case "eth_requestAccounts":
          return [DEMO_ACCOUNTS[accountIndex]];
        case "wallet_switchEthereumChain": {
          const target = Number.parseInt(params[0].chainId, 16);
          if (target !== anvil.id) {
            const err = new Error("演示钱包只支持 Anvil (31337)");
            err.code = 4902;
            throw err;
          }
          wrongNetwork = false;
          emit("chainChanged", chainHex());
          return null;
        }
        case "eth_signTypedData_v4":
          // anvil 支持 eth_signTypedData_v4：演示钱包的签名也由节点代劳（零私钥）
          return rpc("eth_signTypedData_v4", [DEMO_ACCOUNTS[accountIndex], params[1]]);
        case "eth_sendTransaction":
          // from 必须是当前选中的解锁账户；anvil 见 unlocked 账户即代签
          return rpc("eth_sendTransaction", [{ ...params[0], from: DEMO_ACCOUNTS[accountIndex] }]);
        default:
          return rpc(method, params);
      }
    },
    on(ev, cb) {
      listeners.set(ev, [...(listeners.get(ev) || []), cb]);
      return provider;
    },
    removeListener(ev, cb) {
      listeners.set(ev, (listeners.get(ev) || []).filter((f) => f !== cb));
      return provider;
    },
    // 演示 UI 用的两个开关（MetaMask 没有这些，DApp 业务代码不依赖它们）
    _setAccount(i) {
      accountIndex = i;
      emit("accountsChanged", [DEMO_ACCOUNTS[i]]);
    },
    _setWrongNetwork(b) {
      wrongNetwork = b;
      emit("chainChanged", chainHex());
    },
    _accountIndex: () => accountIndex,
  };
  window.ethereum = provider;
  return provider;
}

export function makeConfig() {
  return createConfig({
    chains: [anvil, sepolia],
    connectors: [injected({ shimDisconnect: true })],
    transports: {
      [anvil.id]: http(ANVIL_RPC, { pollingInterval: 1000 }),
      [sepolia.id]: http(undefined, { pollingInterval: 4000 }),
    },
  });
}