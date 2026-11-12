# P06 · 投票 DApp（基础 · 全栈最小闭环）

> 状态：**已完成，本机实测通过（anvil + 浏览器 E2E；MetaMask 真实扩展全流程亦已实测）** ｜ 里程碑：M1·W5 ｜ 层级：基础 ｜ 主线：全栈 ｜ 依赖：P05 ｜ 更新：2026-11-12
> 一句话目标：完成合约 + React/Wagmi + 钱包 + 事件刷新的全栈最小闭环，作为后续所有 DApp 的骨架。

## 运行

```bash
cd projects/P06-投票DApp基础
forge build && forge test          # 13 项（含 2×500 轮 fuzz）
anvil                              # 另开终端
bash script/deploy.sh anvil        # 零私钥：解锁账户 + --unlocked；导出 abi/Voting.json + 部署记录

cd frontend
npm install
npm run dev                        # → http://127.0.0.1:5173
```

浏览器两条钱包路径（共用 injected 连接器 / 同一套 EIP-1193 代码）：

- **本地演示钱包**：页面按钮一键安装 EIP-1193 shim，anvil 解锁账户代签，零私钥；可切 5 个账户、可模拟错误网络。
- **MetaMask**：安装扩展 → 添加网络（名称 Anvil，RPC `http://127.0.0.1:8545`，chainId `31337`，符号 ETH）→
  页面「连接 MetaMask」→ 导入 anvil 开发账户（仅本地学习）→ 建提案/投票。
  **该路径已用真实扩展实测通过**（Edge 157 + `--load-extension` + CDP 驱动真实弹窗，
  见 docs/02-MetaMask真实扩展验收.md）；演示钱包 E2E 覆盖同一接口表面。

## 目录

```text
P06-投票DApp基础/
├── src/Voting.sol            owner 建提案(deadline) / 一人一票 yes-no / tally / 双投与过期强制
├── test/Voting.t.sol         13 项：权限/事件/边界(deadline 当刻)/双投换立场/跨提案独立 + 2 fuzz
├── script/Deploy.s.sol       DeploymentRecorder（admin 外置 + 指纹）
├── script/deploy.sh          anvil/sepolia/consortium 三 profile；anvil 零私钥
├── env/*.env                 无密钥入库
├── frontend/                 Vite + React18 + wagmi2 + viem2
│   └── src/wallet.js         EIP-1193 shim（演示钱包）+ makeConfig；App.jsx 业务与错误诊断
├── abi/ · deployments/       deploy.sh 自动导出；前端 import（禁手抄）
├── docs/01-全栈闭环与事件驱动刷新.md
├── docs/02-MetaMask真实扩展验收.md   真实扩展验收：三个根因 + 证据截图 + 可复用脚本
└── screenshots/01-投票全流程与事件流.png
```

## 知识点

- [x] Wagmi/Viem 读写与交易等待（useReadContract / useWriteContract / 显式回执轮询）
- [x] ABI 自动同步（import deploy.sh 导出的 JSON，HMR 跟随重部署）
- [x] 事件驱动列表刷新（watchContractEvent + invalidateQueries + 2s 轮询兜底；跨客户端实测）
- [x] 钱包状态与网络校验（chainId 不匹配 → 横幅拒绝 + 禁用写 + 一键切换）
- [x] 错误处理与用户可读文案（三层错误；挖块后 revert 用入块高度 eth_call 重放解码）
- [x] 本地 anvil 与测试网两套配置（env/anvil.env、env/sepolia.env；consortium 备用）

## 技术栈

- Solidity 0.8.28 + Foundry 1.7.1 + OZ v5.0.2（Ownable，vendored）
- Vite 6 + React 18 + wagmi 2 + viem 2 + @tanstack/react-query 5（选型偏离 Next/Tailwind 的理由见 docs/01 §6）
- 数据：合约事件直读（暂不建索引器，P09 再做）

## 验收（实测记录，2026-11-11）

| 项 | 结果 |
|----|------|
| forge test | **13 passed / 0 failed**；fuzz 2 项各 500 轮 |
| 部署 | anvil `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`，admin=0xf39F…2266，指纹 `0xbc85c0c7…` |
| 前端构建 | `npm run build` ✓（bundle 405KB / gzip 125KB） |
| 全流程 E2E | 建提案 tx `0x5d9037d4…`(#10) → #1 赞成 `0xacbd6af5…`(#11) → #3 赞成 `0x1bab96a8…`(#15) → tally 与「你已投票」正确 |
| 实时刷新 | 浏览器外 cast 投票 `0xdd22d3cf…`(#16)、`0x374bf6ef…`(#17) → 页面**不重载**事件流即时出现、tally 3/1 |
| 错误网络拒绝 | 模拟 chainId 1 → 横幅「只接受 Anvil (31337)，已禁用全部写操作」→ 切换恢复 ✓ |
| 失败可诊断 | 零时长提案挖块后 revert：tx `0xd1e4bba9…` #13 status=0 → UI「入块但执行失败：投票时长必须大于 0」✓ |
| 双投/过期防护 | 投过与截止后按钮禁用；合约层 AlreadyVoted/VotingClosed 由 forge 测试钉死 |
| MetaMask 全流程 | **真实扩展实测通过**（2026-11-12，Edge 157 + CDP 驱动真实弹窗）：连接授权→切 Anvil→建提案 tx `0x811730c7…`(#42)→投票 tx `0x6bc01067…`(#43)→tally 1/0；`cast` 独立核验 `proposalCount=3 / hasVoted=true / owner=0xf39Fd…2266`。详见 docs/02 |
| 截图 | screenshots/01-投票全流程与事件流.png |
| 仓库零私钥 | 演示钱包走节点代签；env 无密钥；MetaMask 导入步骤只面向本地学习账户 |

## 过程中修掉的真实缺陷（详见 docs/01）

1. **vite 根路径下 `fetch("../deployments/…")` 404**：浏览器把 `..` 归一化到根；改 import JSON（HMR 跟随）。
2. **只靠 invalidateQueries 时计数查询不重取**：加 2s 轮询兜底（事件管即时、轮询管正确）。
3. **useWaitForTransactionReceipt 本环境不更新**：改显式轮询回执；顺带补上「挖块后 revert」的重放解码——
   回执不带 reason，status=0 的交易原先在 UI 上只有沉默的「等待入块」。
4. **wagmi 自定义 queryKey 覆盖不可靠**：放弃手拼 key，回到 invalidate + 轮询的官方组合。

## lainchain 对照精读

- [ ] 读 `hardhat/contracts/dao/LainGovernor.sol` 的最小提案路径，对照自己的投票合约
- **待源件**：lainchain-defi 不在本机，不凭印象写对照；源件可得后补 `docs/S2-智能合约入门/lainchain对照-P06.md`。

## 复盘

- 卡住的点：wagmi 缓存语义（invalidate 与观察者生命周期）比合约本身难调——**前端状态层也要有「兜底巡检」思维**，与链下索引器同构。
- 与 Java/传统后端的对照：watchContractEvent ≈ 消息订阅（WebSocket/MQ）；invalidateQueries ≈ 缓存失效广播；
  轮询兜底 ≈ 定时对账任务；EIP-1193 shim ≈ 接口 mock/stub——同一接口两种实现，业务代码无感。
- 下次可压缩的时间：钱包 shim 与错误诊断骨架可直接复用到 P07/B06；MetaMask 扩展验收打法已沉淀在 docs/02（Edge + `--load-extension` + 原始 CDP 驱动真实弹窗），P07 可直接照搬。