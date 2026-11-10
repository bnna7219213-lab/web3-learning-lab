# P26 · 搭建可部署到互联网的私有 PoS 以太坊网络（专家 / 超纲）

> 状态：**设计完成，本机未实测** ｜ 里程碑：M5 选修（P22 同级） ｜ 层级：专家 ｜ 依赖：P02、P11 ｜ 更新：2026-10-14
> ⚠️ 诚实声明：开发机为 Windows，**未安装 Docker / Kurtosis / 任何客户端**（`docker`、`kurtosis`、`geth`、`besu`、`lighthouse`、`prysm`、`teku`、`lodestar` 全部缺失，见 `scripts/00-preflight.sh`）。
> 因此本章所有命令均**逐字取自权威源**并标注抓取日期，不在本机执行；实际运行需要一台 Linux 主机（本机可用 WSL2 或任意云主机）。
> 主要来源：`ethpandaops/ethereum-package` README 与 `.github/tests/`（CI 实测过的配置），抓取于 2026-10-14。

---

## 一、为什么 Anvil 不够（你的清单，逐条校准）

| 维度 | Anvil / Hardhat 本地链 | 真实私有 PoS 网络 | 校准说明 |
|------|------------------------|-------------------|----------|
| 共识 | 无真实共识，`--silent`/auto-seal 即时出块 | 执行层 + 共识层双进程，BLS 投票 + fork-choice | ✅ 你的判断正确 |
| 最终性 | **无** checkpoint/finality，只有"下一块" | 2 个 epoch（约 12.8 分钟，可调 slot）后才 finalized | ✅ 正确，且这是 P02 实验 3「重组」的真实版本 |
| 验证者 | 无验证者网络（单节点自封） | 每节点一组 keystore，>2/3 权重才能最终化 | ⚠️ 见下方「几个验证者才够」 |
| 网络 | 默认只绑 `127.0.0.1` | 多主机、公网 IP、节点发现（enode/ENR） | ⚠️ 不是"仅本地"：`anvil --host 0.0.0.0` 也能对外，只是**没有共识与发现机制**，两个 anvil 连不上彼此 |
| 安全 | 无任何保障（固定测试助记词、预存款人人可得） | 密钥治理、防火墙、JWT、RPC 鉴权都成为真问题 | ✅ 正确，且这是本章最重的一段 |
| 时间 | 块时间可任意伪造（`evm_setNextBlockTimestamp`） | 真实墙钟，**时钟漂移会直接导致掉签与不最终化** | ➕ 你没列，但这是最常见的翻车点 |
| 状态 | 单进程内存态，重启即清空 | 状态增长、快照、归档、blob 存储都要规划 | ⚠️ 磁盘瓶颈是**状态与 blob**，不是"区块大小" |

**适合 / 不适合**（你的分类基本对，补一条）：

- Anvil 适合：快速开发、单元与 fork 测试、前端调试、**Gas 与状态实验（P04–P08 全程够用）**
- Anvil 不适合：生产环境、真实共识、网络拓扑、最终性/重组、验证者运维、多客户端兼容性
- ➕ 还不适合：**性能与容量压测**（没有真实 P2P 传播与 Gossip 延迟）

### 几个验证者才够？（常见误解）

最终性阈值按**权重**算，不按节点数算：1 个验证者也能 100% 自最终化。所以

| 目的 | 最低配置 |
|------|----------|
| 只是想有一条能最终化的链 | 1 节点 / 1 组验证者密钥 |
| 测 P2P 传播、区块广播、节点掉线恢复 | **2 节点**（你的清单说"至少 2 个验证者"，准确说是至少 2 个**节点**） |
| 测重组、分叉、双签罚没、延迟容忍 | **4 节点**（能构造 1/3 失效场景） |
| 测多客户端兼容性 | 6 节点，EL/CL 各取不同实现（见 `mix-with-tools.yaml`） |

---

## 二、真实网络的组件（补全你的清单）

```text
                       ┌──────────────── 一台主机（participant）────────────────┐
   你的应用/合约 ──RPC──▶│  执行层 EL (Geth/Nethermind/Besu/Erigon/Reth/...)      │
                       │     ▲ 30303 tcp+udp (eth/66 P2P)                       │
                       │     │ JWT secret（EL↔CL 私有 RPC 认证，必配）           │
                       │ 共识层 CL (Prysm/Lighthouse/Teku/Nimbus/Lodestar)       │
                       │     ▲ 9000 tcp+udp (attestation/gossip P2P, ENR)        │
                       │     │                                                  │
                       │ 验证者客户端 VC (Proposer/Attester，可与 CL 分离部署)    │
                       └────────────────────────────────────────────────────────┘
   共享引导：EL bootnode(enode) + CL bootstrap ENR —— Kurtosis 自动接线，手工搭才需要自建
   可选：MEV-Boost + builder、Prometheus/Grafana/Xatu 监控、tx-fuzz/spamoor 压测
```

| 你的清单 | 校准 |
|----------|------|
| `execution_client: Geth/Nethermind/Besu/Erigon` | ✅ 还有 Reth、EthereumJS、Nimbus-eth1、ethrex（Kurtosis 全部支持） |
| `consensus_client: Prysm/Lighthouse/Teku/Nimbus/Lodestar` | ✅ 另有 Caplin、Grandine |
| `validators: 至少 2 个（最好 4+）` | ⚠️ 见上表：2 是**节点数**要求，验证者密钥默认每节点 128 个 |
| `bootnode: 引导节点` | ✅ 手工搭需要；用 Kurtosis 时由包自动写入 `--bootnodes` / `--boot-nodes` |
| `genesis_config` | ✅ 由包生成（`el_cl_genesis_data` 产物），含 `network_id`、`deposit_contract_address`、`seconds_per_slot` |
| `infrastructure.servers` | ✅ 单机多容器即可跑通；跨主机才需要 routable IP（见 §四） |
| `infrastructure.networking` | ⚠️ 公网 IP 不够，还要 **NAT 出口 IP 显式声明**，否则节点广播的是内网地址，别人连不上（见 `nat_exit_ip`） |
| `consensus.proof_of_authority` | ✅ Besu Clique / IBFT2 是**联盟链交付的现实首选**，见 `docs/04-选型.md` |

---

## 三、路线选择（先选路，再抄命令）

```text
需要"真实 PoS 语义"（最终性、验证者、多客户端）？
├── 否 → 继续用 anvil（P04–P08 足够，别浪费两周）
└── 是
    ├── 单机演示 / CI 回归 → 本章 §三 A：Kurtosis 本地私有网
    ├── 多台真实主机 / 客户环境 → §四：port_publisher + nat_exit_ip + 防火墙
    └── 客户要的是"我们几家一起记账"的联盟链 → 不要用 PoS，用 Besu Clique PoA 或国产盟链
        （理由：PoS 的准入是"质押换权"，联盟链的准入是"实名+授权"，后者才是政企要买的）
```

### A. 本地起网（最小可跑）

前置：Linux/macOS + Docker 运行中 + Kurtosis CLI。

```bash
# 1) 安装 Kurtosis CLI（官方脚本；执行前自行核对域名，别把远程脚本直接喂给 shell）
sh -c "$(curl -fsSL https://get.kurtosis.com/install)"

# 2) 最小默认配置（1 个 participant，包内默认值）
kurtosis run --enclave my-testnet github.com/ethpandaops/ethereum-package

# 3) 用本仓库的配置（2 节点、多客户端、带监控）
kurtosis run --enclave my-testnet github.com/ethpandaops/ethereum-package --args-file network_params/minimal-2nodes.yaml

# 4) 查看服务与端口
kurtosis enclave inspect my-testnet

# 5) 拆除（enclave 与容器、产物会一直驻留直到显式删除）
kurtosis enclave rm -f my-testnet
```

> 来源：`ethereum-package` README「Quickstart / Run with your own configuration / Tear down」，2026-10-14。
> `sh -c "$(curl -fsSL https://get.kurtosis.com/install)"` 是 Kurtosis 官方安装入口；执行前先自行核对域名，**不要在没核实的情况下把远程脚本喂给 shell**。

### B. 拿到 RPC 与预置账户

```bash
# JSON-RPC：从 inspect 输出里取 EL 服务的 forwarded URL（形如 http://127.0.0.1:<随机端口>）
kurtosis enclave inspect my-testnet | grep -E "geth|nethermind|reth"

# 预置账户私钥：来自包内默认测试助记词（见 §五 红线），派生地址已在 genesis 里预存 ETH
# 用 Foundry 从助记词导出（本机已装 forge/cast）：
export MNEMONIC="giant issue aisle success illegal bike spike question tent bar rely arctic volcano long crawl hungry vocal artwork sniff fantasy very lucky have athlete"
for i in 0 1 2; do cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index $i; done
```

> 助记词字符串逐字来自 README 的 `preregistered_validator_keys_mnemonic` 默认值（2026-10-14）。

---

## 四、部署到互联网（多主机）

这是本章真正难的部分。三个必须显式处理的点：

1. **NAT 出口 IP**：容器里看到的网卡地址不是公网地址。节点把它写进 enode/ENR 广播出去，别人永远连不上。
   ```yaml
   port_publisher:
     nat_exit_ip: 192.168.58.159   # 换成该主机的可路由 IP（或 "auto"）
     el: { enabled: true }
     cl: { enabled: true }
   ```
   README 原文警告：*"without it, every enode in `enodes.txt` points at a docker-internal address that nobody else can reach"*。
2. **网络配置分发**：第二台主机要知道创世块与引导节点。包内置 `nginx` 服务把 `network-config.tar`（enodes/ENR/genesis bundle）挂成 HTTP：
   ```yaml
   additional_services: [nginx]
   ```
   目标主机只需：
   ```yaml
   network_params:
     network: kt-<A-host>:9090     # 从 A 的 nginx 拉配置，自动进入 observer 模式（验证者数自动置 0）
   ```
3. **Geth snap-sync 陷阱**：新 devnet 状态还在长的时候加入会卡 `missing trie node ... layer stale`。
   对策（README 原文两条）：目标端加 `el_extra_params: ["--syncmode=full"]`，或等源端**至少最终化 1 个 epoch** 再起目标端。

完整可抄配置见 `network_params/public-internet.yaml`；防火墙与系统层加固见 `docs/02-公网部署与安全加固.md`。

---

## 五、安全红线（公网部署前逐条签字）

| # | 红线 | 为什么致命 |
|---|------|------------|
| 1 | **必须替换默认测试助记词** | 那串 `giant issue aisle ... athlete` 公开在 README 里，**且与 anvil 默认助记词相同**（0 号地址 `0x8943545177806ED17B9F23F0a21ee5948eCaa776`，本机 `cast wallet address` 实测）。不替换 = 任何人可花你的预存 ETH，并用同助记词派生的验证者密钥**接管链** |
| 2 | EL RPC（8545/8546）与 CL RPC（5052）**永不公网** | 一个开放的 RPC = 别人的免费节点，且能灌交易、伪造 gasPrice 视图 |
| 3 | 只放行 30303(tcp/udp) 与 9000(tcp/udp) | 其余端口一律默认拒绝，见 `scripts/30-firewall.sh` |
| 4 | JWT secret 权限 600，不出现在命令行明文与镜像层 | EL↔CL 私有通道的唯一凭证 |
| 5 | 验证者密钥与节点**分机**（signer / 远程签名） | 主机被拿下时，攻击者只能停你的验证者，不能双签 |
| 6 | `chain_id` / `network_id` 全局唯一并登记 | 与 P01 签名域同理：防跨网重放；两个客户内网撞 chainId 会互相污染 |
| 7 | NTP/chrony 强制同步并告警 | 时钟漂移 → 漏签、掉最终性；这是最难查的一类故障 |
| 8 | 磁盘用 SSD + 监控剩余量 | 状态与 blob 增长撑爆盘 → 节点静默脱网 |
| 9 | 公网链必须有**准入说明**：谁能加入、谁记账、数据是否含个人信息 | 见 `docs/04-选型.md` 与合规边界 |

---

## 六、验收清单（跑通后逐条打勾）

- [ ] `kurtosis enclave inspect` 显示 ≥2 个 participant，EL/CL/VC 全部 `running`
- [ ] 两个不同客户端实现共存（如 geth+lighthouse 与 reth+teku）且**同一链尖**
- [ ] `eth_chainId` 返回你配置的 `network_id`；`eth_blockNumber` 持续增长
- [ ] 部署一个 Counter 合约（复用 P04）并发交易，**等 2 个 epoch 后** `eth_getFinalizedBlock` 前进（这是 anvil 给不了的验收）
- [ ] 杀掉 1 个 participant 再拉起，它自动追平且**不产生永久分叉**（对照 P02 实验 2）
- [ ] 从第二台主机用 `network: kt-<host>:9090` 加入，成为 observer 并同步到同一链尖
- [ ] Prometheus/Grafana 能看到 `beacon_finalized_head`、`validator_monitor` 指标
- [ ] 换掉默认助记词后重新起网，旧助记词地址在 genesis 里**不再有钱**
- [ ] 防火墙规则生效：外网 `nc -zv <ip> 8545` 失败、`30303` 成功

---

## 七、本章与商业线的关系

| 模块 | 本章提供的能力 | 报价含义 |
|------|----------------|----------|
| M1/M2/M4 交付 | 客户自有环境的**私有网部署与运维**（含防火墙、密钥治理、监控、Runbook） | 实施费 + 年维保（报告 §6 模式 1：毛利 40–60%） |
| M4 企业可信档案 | 真实最终性 → 「N 个确认后出证」终于有了可验证的对象（`shared/evidence` 契约的 `anchor.confirmationsRequired`） | 出证 SLA 可量化 |
| G6 lainchain | 把 lainchain 的 chainId 420 硬编码换成 profile，在私有网跑一遍全链路 | 生产化改造清单第 4 项 |
| 合规 | 说清"我们交付的是记账基础设施，不是公链发币平台" | 政企采购答疑必备 |

> **不要为了炫技上 PoS**：政企客户要的准入模型是"实名 + 授权"，那是 Clique/盟链的地盘。
> PoS 私有网的正确用途是：① 研发与 CI 需要真实最终性语义；② 客户明确要"以太坊兼容 + 多机构无中心方"。判断依据见 `docs/04-选型-私有PoS-vs-Clique-vs-盟链.md`。

## 目录

```text
P26-私有PoS以太坊网络/
├── README.md                          本章（决策 + 命令 + 红线 + 验收）
├── network_params/
│   ├── minimal-2nodes.yaml            本地 2 节点多客户端（含监控）
│   ├── public-internet.yaml           跨主机：port_publisher + nat_exit_ip + nginx
│   └── remote-observer.yaml           第二台主机加入为 observer
├── scripts/
│   ├── 00-preflight.sh                依赖/端口/磁盘/时钟/NAT 自检（先跑这个）
│   ├── 10-up-local.sh                 起本地网 + 打印 RPC
│   ├── 20-rpc-check.sh                链 ID/高度/最终性/RPC 暴露面检查
│   └── 30-firewall.sh                 ufw 模板：只开 P2P，关掉一切 RPC
└── docs/
    ├── 01-组件与端口地图.md
    ├── 02-公网部署与安全加固.md
    ├── 03-运维Runbook.md
    └── 04-选型-私有PoS-vs-Clique-vs-盟链.md
```
