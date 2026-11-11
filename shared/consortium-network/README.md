# shared/consortium-network · Besu QBFT 联盟链网络层

> 定位：B03–B08 分支项目的**共用网络底座**。P 分支用 anvil/Sepolia，B 分支全部指向这里。
> 状态：**服务器已装 Besu 26.9.0（Oracle JDK 25.0.4.1 LTS，/opt/besu/bin/besu）**；
> **2026-11-11 起 Windows/Git Bash 开发机也已实跑通**（4 验证者、冒烟 5/5，P03/P04/P05 均部署实测）。
> Windows 两处注意：`JAVA_HOME` 必须指向 JDK 25+（Besu 启动器认它而非 PATH）；
> `21-up-native.sh` 已改传 bootnodes 文件绕过 Besu 26.9.0 的 Windows enode 路径解析崩溃。
> 校准依据：Besu 26.9.0 官方文档 + 服务器实测反馈，2026-10-14；Windows 实跑修正 2026-11-11。逐条判定见 `docs/01-方案校准清单.md`。

## 〇、环境要求（实测修正）

| 项 | 值 | 来源 |
|----|----|------|
| Besu | **26.9.0**（`besu-26.9.0.tar.gz` + `.sha256`，GitHub Releases） | 实测：consensys artifacts 老路径已 404 |
| Java | **25+**（服务器用 Oracle JDK 25.0.4.1 LTS） | 实测：26.9.0 要求 Java 25，官方 system-requirements 未写死版本 |
| 共识 | QBFT（由 genesis 的 `"qbft"` 段启用；**没有 `--qbft-enabled` 选项**） | 官方文档 |

## 一、这套网络是什么

| 维度 | 取值 | 说明 |
|------|------|------|
| 客户端 | Hyperledger Besu 26.9.0 | 完全 EVM 兼容，Solidity 合约零改动 |
| 共识 | **QBFT**（不是 IBFT 2.0） | 官方："QBFT is the recommended enterprise-grade consensus protocol for private networks" |
| 验证者 | 4（n=3f+1 → f=1，quorum=3） | 挂 1 台正常，**挂 2 台停链**；要容忍挂 2 台需 n=7 |
| 终结性 | 单块确定性终结 | 无回滚（但见 `docs/03` 的可用性边界） |
| gas | 零 gas（free gas 六步全配） | `min-gas-price=0` + `zeroBaseFee=true` + `tx-pool-enable-balance-check=false` |
| 准入 | 节点白名单 + 账户白名单（可选链上合约） | 联盟成员"去中心化接入但受名管控"的落点 |
| 链 ID | 19880601（示例） | 必须全局唯一并登记 |

## 二、目录

```text
consortium-network/
├── README.md
├── genesis/
│   ├── qbftConfigFile.json.tpl     besu operator generate-blockchain-config 的输入
│   └── qbft-genesis.json.tpl       成品创世模板（含逐项注释）
├── config/
│   ├── validator.toml              验证者（RPC 只绑 127.0.0.1）
│   ├── rpc.toml                    对外接入节点（限源 + gas cap）
│   └── permissions_config.toml     节点/账户双白名单
├── docker/
│   ├── docker-compose.yml          单机 4 验证者（每节点独立密钥 + BOOTNODES 注入）
│   └── prometheus.yml              指标采集
├── scripts/
│   ├── 00-preflight.sh             JDK25/besu/时钟/磁盘/内存 + QBFT 容错计算
│   ├── 10-genesis.sh               生成创世与 4 套节点密钥
│   ├── 20-up-docker.sh             单机 4 验证者（需 Docker）
│   ├── 21-up-native.sh             单机 4 验证者（**原生 Besu，无需 Docker**）← 首次拉起用；已去掉洗链的 rm -rf
│   ├── 29-stop-native.sh           停止原生节点
│   ├── 30-smoke-test.sh            7 项冒烟（peer 数、gasPrice=0、baseFee=0、验证者=4）
│   ├── 40-add-member.sh            成员接入：写白名单 + 热加载 + 三条排障
│   ├── run-node.sh                 单验证者前台启动器（给 systemd 用；JVM 参数走 BESU_OPTS）
│   └── 50-install-systemd.sh       nohup 形态 → systemd 托管（备份→停旧→装单元→断言链高续跑）
├── systemd/
│   ├── besu-node@.service          Restart=always + MemoryHigh=340M + 引号正确的 Environment
│   └── b03-faucet.service          水龙头（服务器实际在跑的那份，纳入仓库）
├── nginx/
│   └── b03-chain.conf              对外反代：upstream 容错 + keepalive + faucet 按 IP 限速
└── docs/
    ├── 01-方案校准清单.md           ← 先读这个
    ├── 02-零gas与交易池配置.md
    ├── 03-成员接入与权限治理.md
    └── 04-差异矩阵-P03-P08-vs-B03-B08.md
```

## 三、上手（服务器已装原生 Besu → 走 A）

```bash
bash scripts/00-preflight.sh                      # 先自检（JDK 25 / besu / 时钟 / 容错计算）

cp genesis/qbftConfigFile.json.tpl genesis/qbftConfigFile.json
#   编辑：把 chainId 改成你登记过的唯一值；把 REPLACE_ADMIN_ADDRESS_NO_0X_PREFIX 换成真实地址（不带 0x）
bash scripts/10-genesis.sh ./networkFiles         # 生成 genesis.json + 4 套节点密钥

# A. 原生 Besu 单机 4 验证者（推荐，无需 Docker）
bash scripts/21-up-native.sh                      # 首次拉起 + 25 秒后自动冒烟（幂等，重跑不洗链）
bash scripts/29-stop-native.sh                    # 停止
#    跨主机：P2P_IP=<本机可路由内网IP> bash scripts/21-up-native.sh

# A+. 生产形态：交给 systemd（**做完 A 之后必须走这步**，否则重启机器/进程被 OOM 杀掉链就不回来了）
bash scripts/50-install-systemd.sh                # 自动备份密钥与 genesis，并断言链高是"接着涨"而非归零
systemctl status besu-node@{1,2,3,4}
journalctl -u besu-node@1 -f
#    停链后恢复出块：必须一起重启，单个补起会因 round 不一致继续不动块
#    systemctl restart besu-node@{1,2,3,4}

# B. Docker 路径（本机有 Docker 时）
bash scripts/20-up-docker.sh

# 手动冒烟
RPC=http://127.0.0.1:8551 bash scripts/30-smoke-test.sh     # 原生路径端口 8551..8554
RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh     # Docker 路径
```

多机生产（4 台 RedHat + systemd）：每台拷 `/etc/besu/{genesis.json,key,config.toml,permissions_config.toml}`，
`p2p-host` 填各自主机 IP，`bootnodes` 用真实 enode，RPC 只对成员子网开放。

## 四、与 P 分支的关系（一句话）

**合约与前端代码不变，变的是"谁在记账、谁能接入、谁付 gas、出问题找谁"。**
逐项差异与验收口径见 `docs/04-差异矩阵-P03-P08-vs-B03-B08.md`；B03–B08 各自的项目说明在 `projects/B0x-*/README.md`。

## 五、上手前必须知道的五件事

1. **零 gas 不是"改一个参数"**：六步少任何一步都会出现"交易静默消失"或"部署要 gas 却没钱"。见 `docs/02`。
   另有一条今天才测清的边界：`tx-pool-enable-balance-check=false` 免的是 **gas 成本**检查，**转账面值仍要求 `balance ≥ value`** —— 余额 0 的新账户发 `value=0` 畅通，发 `value=1` 被节点拒（`-32004`）。**零 gas 免手续费，不免本金。**
2. **4 验证者的容错只有 1 台**：n=4 → f=1 → quorum=⌈2f+1⌉=**3**。停 1 台照常出块，停 2 台**立刻停链**。滚动升级一次只能停 1 台，写进 SLA。
3. **白名单挡的是 P2P，不挡 RPC 直连**：只配 `nodes-allowlist` 时，任何能连到 8545 的人仍可提交交易。要么 `accounts-allowlist`，要么 RPC 限源 + 反向代理认证。见 `docs/03`。
4. **`--rpc-http-api` 里的 ADMIN 会随反代暴露到公网**：`admin_addPeer` 谁都能调就是事故。对外端口只留 `ETH,NET,WEB3,QBFT`；权限治理（B08）走本机端口或 SSH。
5. **内存按"每验证者 335 MB"预算，不是按 `-Xmx`**：实测 `-Xmx140m` 时单节点 RSS 仍 335–346 MB（metaspace 约 300 个 jar + Netty/RocksDB 直接内存 + 线程栈 + JFR 才是主体，且 JVM 瘦身参数全上后只降约 5%）。**4 验证者需 ≈1.4 GB 纯 Besu**，与 Web 生产栈（mysqld/Spring/<server-panel>/云盾基线 800–900 MB）挤在 1.9 GB 一台机器上会让 OOM killer 去杀客户的数据库。结论：**链与 Web 不同机**，或给链 ≥4 GB。
