import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/bnna7/Aether/web3_roadmap";
const force = process.argv.includes("--force");

const M = [
  { id: "P02", dir: "P02-MiniChain迷你区块链基础", name: "MiniChain 迷你区块链", tier: "基础", track: "基础", week: "M1·W2", deps: "P01",
    goal: "用多节点本地链证明「区块结构 + 共识 + P2P 广播 + 钱包签名」如何共同产生不可抵赖的账本。",
    kp: ["区块头字段与 Merkle root", "最长链规则与重组", "PoW 与 PoS 简化实现", "P2P 广播与节点同步", "交易签名验证（secp256k1 或 P-256）", "确认数与最终性"],
    stack: ["Node.js（HTTP/WebSocket）或 Spring Boot + Netty", "前端：极简节点面板（可复用 P01 零依赖风格）", "数据：每节点一份 JSON 账本 + 日志"],
    biz: [["M2 设备可信结算", "节点、确认数与最终性直觉 → 设备数据入账需要几个确认", "节点拓扑图 + 重组实验记录"], ["M4 企业可信档案", "多副本 + 锚点：单点台账与分布式台账的分界", "对照表"]],
    lain: "读 `hardhat/contracts/iot/IoTBridgeForMcu.sol`：链上如何表达「已确认」，与 MiniChain 的最终性概念对照",
    accept: ["至少 3 个节点同步出块；杀 1 个节点后能恢复并选最长链", "人为制造分叉，观察重组与已确认交易回滚", "交易签名非法时节点拒绝入块"] },

  { id: "P03", dir: "P03-链上交互实战基础", name: "链上交互实战", tier: "基础", track: "基础", week: "M1·W2", deps: "P01",
    goal: "在测试网完成「建钱包 → 领水 → 转账 → 浏览器逐字段解析」，形成可复用的交易生命周期手册。",
    kp: ["助记词与派生路径", "nonce / gas / gasPrice 与 EIP-1559", "input data 选择器解码", "logs/topics 与事件解码", "交易状态、回执与确认数", "失败交易与 gas 消耗"],
    stack: ["MetaMask（学习钱包）+ Sepolia/Base Sepolia", "viem 或 cast 脚本", "数据：Etherscan API 拉取交易与日志"],
    biz: [["M5 补贴直达/履约支付", "「指令 → 回执 → 对账」三段式与支付通道同构", "对账字段映射表"], ["M2 设备可信结算", "tx hash 作为锚点写入出证包", "出证字段清单"]],
    lain: "读 `hardhat/scripts/deploy.js` 与 `deployments/420.json`：部署录制 + ABI 自动下发前端的工程做法",
    accept: ["手册含 ≥5 笔真实测试网交易的逐字段解析（含 1 笔失败）", "能手工用 cast/viem 复现其中一笔", "截图与 tx hash 可核"] },

  { id: "P04", dir: "P04-HelloContract基础", name: "HelloContract + Foundry", tier: "基础", track: "合约", week: "M1·W3–4", deps: "S0",
    goal: "跑通「写合约 → 单测 → 本地部署 → 测试网部署」最小闭环，建立 Foundry 肌肉记忆。",
    kp: ["Solidity 类型/存储/可见性", "event 与 emit", "error 与 revert（自定义错误省 gas）", "Foundry：forge build/test/deploy/script", "forge test 的 fixture 与 fuzz", "remappings 与依赖管理"],
    stack: ["Solidity 0.8.x + Foundry", "前端：只读调用页面（可选）", "部署：anvil → Sepolia"],
    biz: [["全部模块", "合约工程基线：命名、错误、事件、测试规范", "团队合约规范 v0"]],
    lain: "读 `hardhat/contracts/core/Faucet.sol`：对照自己的 Counter，看真实项目的权限与限流写法",
    accept: ["forge test 全绿且核心函数有边界与 revert 断言", "部署脚本可用 .env profile 切换 anvil/sepolia", "README 他人可 30 分钟复现"] },

  { id: "P05", dir: "P05-ERC20代币基础", name: "ERC20 代币", tier: "基础", track: "合约", week: "M1·W3–4", deps: "P04",
    goal: "实现带权限与 Permit 的 ERC20，理解授权模型的安全含义与「计价载体」的合规选择。",
    kp: ["ERC20 事件与精度（decimals）", "approve/transferFrom 竞态与 decreaseApproval", "EIP-2612 permit 与 EIP-712 域分隔", "Ownable/AccessControl 角色设计", "铸造/销毁与供应量治理", "整数运算与四舍五入方向"],
    stack: ["Solidity + OpenZeppelin v5 + Foundry", "前端：授权/转账演示页（P06 再做完整）", "数据：Transfer 事件表"],
    biz: [["M1 多方分账中台", "分账的计价载体选型：稳定币 / 账面积分 / 法币记账", "载体对比与合规结论"]],
    lain: "读 `hardhat/contracts/core/LainToken.sol` 与 `GameGold.sol`：两个代币的职责差异与 emission 逻辑",
    accept: ["permit 测试含签名重放用例（改 chainId/nonce 必须失败）", "所有外部调用有事件", "forge fuzz 通过"] },

  { id: "P06", dir: "P06-投票DApp基础", name: "投票 DApp", tier: "基础", track: "全栈", week: "M1·W5", deps: "P05",
    goal: "完成合约 + React/Wagmi + 钱包 + 事件刷新的全栈最小闭环，作为后续所有 DApp 的骨架。",
    kp: ["Wagmi/Viem 读写与交易等待", "ABI 自动同步（禁止手写）", "事件驱动列表刷新", "钱包状态与网络校验（chainId 不匹配要拒绝）", "错误处理与用户可读文案", "本地 anvil 与测试网两套配置"],
    stack: ["Next.js/React + Wagmi + Viem + Tailwind", "合约：投票/提案", "数据：合约事件（暂不建索引器）"],
    biz: [["M1/M3/M5", "「审批流 + 链上留痕」交互范式（投票 = 双人复核的原型）", "可复用前端骨架"], ["M4", "出证入口与验证页交互", "页面组件"]],
    lain: "读 `hardhat/contracts/dao/LainGovernor.sol` 的最小提案路径，对照自己的投票合约",
    accept: ["本地 Anvil + MetaMask 全流程可投票并实时刷新", "切换错误网络时给出明确拒绝提示", "交易失败有可诊断信息"] },

  { id: "P07", dir: "P07-NFT市场进阶", name: "NFT 市场", tier: "进阶", track: "全栈", week: "M2·W6–7", deps: "P06",
    goal: "做 ERC721/1155 的铸造—挂单—成交—下架全流程，并吃透 EIP-4907 租期权限分离。",
    kp: ["ERC721/1155 与元数据标准", "IPFS/对象存储与哈希锚定", "签名订单与链下撮合", "版税与 ERC2981 的局限", "EIP-4907 owner/user 双角色", "市场合约的转账安全（safeTransferFrom）"],
    stack: ["Solidity + Foundry", "React 市场前端", "数据：IPFS/Pinata 或客户 OSS + 哈希上链"],
    biz: [["M3 权益与订阅", "权益凭证发行、核销、到期回收", "权益模板合约 + 管理台原型"], ["M4", "元数据哈希存证", "出证字段"]],
    lain: "读 `hardhat/contracts/market/RentalMarket.sol`（331 行）与 `NFTMarketplace.sol`：租期与挂单撮合实现",
    accept: ["完整交易路径截图", "到期后 user 权限自动失效的测试", "二级市场入口默认关闭（合规检查）"] },

  { id: "P08", dir: "P08-合约工程化进阶", name: "合约工程化进阶包", tier: "进阶", track: "合约", week: "M2·W8", deps: "P05",
    goal: "把「贵、能改、可预测地址、批量证明」四件事各做一个可复现实验，形成工程判断力。",
    kp: ["存储布局与 slot 手工计算", "Gas 报告与优化（calldata/packing/缓存）", "Create2 确定性地址", "UUPS/Transparent 代理与升级迁移脚本", "合约端 Merkle proof 验证", "ERC-4337 账户抽象概念落地"],
    stack: ["Solidity + Foundry（forge snapshot/gas-report）", "Slither/Aderyn", "脚本：升级演练"],
    biz: [["M1/M4", "批量分账与出证的链上验证（对数级 Gas）", "verifyProof 合约 + Gas 报告"], ["全部模块", "可控升级与参数治理", "升级 Runbook"]],
    lain: "精读 `hardhat/contracts/defi/LainStaking.sol`（Synthetix 累加器，本金/奖励解耦）与 `market/SplitPayment.sol` 的 `_accPerShare`",
    accept: ["Gas 对比表入 docs/", "代理升级演练含存储槽冲突检查", "合约端 Merkle 验证与 P01 链下实现互相验证通过"] },

  { id: "P09", dir: "P09-链上数据平台进阶", name: "链上数据平台", tier: "进阶", track: "数据", week: "M2·W9", deps: "P07",
    goal: "自建索引器 + BFF + 看板，把链上事件变成可查询、可对账、可出证的 API（你的 Java 主战场）。",
    kp: ["扫块与日志过滤（address/topics）", "区块重组与 confirmations 深度", "幂等写入与游标/分页", "PostgreSQL 表设计（tx/log/asset/holder）", "REST/GraphQL 与鉴权", "Spring Boot + web3j 对接"],
    stack: ["Node worker 或 Spring Boot 4.1 + Java 21 + web3j", "PostgreSQL + Flyway", "看板：React 表格/图表"],
    biz: [["M4 企业可信档案", "出证 API：按 id 返回证据 + proof", "接口契约 + 独立验证器"], ["M1 多方分账中台", "对账报表（链上事件 ↔ 银行回单）", "对账模块"], ["M5", "支付指令与回执三方对平", "对账中心"]],
    lain: "读 `indexer/`（Python + SQLite 手写扫块）与 `backend/`（Ktor MVP）：列出重组处理缺失项，规划 Spring Boot 重写",
    accept: ["事件可查询且分页稳定", "人为制造分叉后索引能回滚重放", "看板按合同号/批次筛选 <1s"] },

  { id: "P10", dir: "P10-预言机与自动化进阶", name: "预言机与自动化", tier: "进阶", track: "合约+数据", week: "M2·W10", deps: "P08",
    goal: "接入价格预言机并实现自动化任务，理解「外部数据进链」的信任与操纵风险。",
    kp: ["Chainlink Aggregator 与心跳/偏差", " TWAP 与操纵抗性", "自建 m-of-n 中位数 + 罚没", "Automation / keeper 与 gas 代付", "离线签名与执行者分离", "数据时效性判定（stale 即拒绝）"],
    stack: ["Solidity + Chainlink（测试网 feed）", "Node/Keeper 服务", "监控：价格延迟与偏差告警"],
    biz: [["M2 设备可信结算", "外部数据校验与多源一致性（设备读数的交叉验证）", "数据质量校验器"], ["M5 补贴直达", "条件判定（资格/发票/验收）作为支付前置", "规则引擎原型"]],
    lain: "精读 `hardhat/contracts/attention/AttentionOracle.sol`（m-of-n 中位数 + 罚没）与 `defi/PriceOracle.sol`",
    accept: ["stale 价格必须拒绝使用（有测试）", "自动化任务失败有重试与告警", "写清操纵攻击面与缓解"] },

  { id: "P11", dir: "P11-多链与L2实战进阶", name: "多链与 L2 实战", tier: "进阶", track: "生态-EVM", week: "M3·W11–12", deps: "P08",
    goal: "一套合约多网络部署，并说清 L1/L2 在成本、确认时间、排序器与数据可用性上的差异。",
    kp: ["部署 profile（chainId/RPC/浏览器/确认数）", "L2 费用结构与 blob 数据", "排序器中心性与强制提现", "跨链地址与合约地址一致性（Create2）", "节点服务与限流（Alchemy/自建）"],
    stack: ["Foundry + 部署脚本（多 profile）", "Base/Arbitrum/Optimism Sepolia", "数据：同一索引器多链"],
    biz: [["M4/M2", "盟链 + 公链锚点双写（root 落公链，明细落盟链/客户库）", "双写适配器"], ["M0", "离岸演示的多网部署", "部署手册"]],
    lain: "对照分析文档 P2 改进项「环境绑死 chainId 420」：把部署配置外置成 profile",
    accept: ["同一份合约 ≥2 个网络部署成功并给出成本对比", "文档说明该链的重组/提现风险", "配置零硬编码"] },

  { id: "P12", dir: "P12-跨链消息Demo进阶", name: "跨链消息 Demo", tier: "进阶", track: "生态-EVM", week: "M3·W11–12", deps: "P11",
    goal: "实现一次跨链消息收发，并写清信任模型：谁验证、被攻破会怎样。",
    kp: ["lock-mint 与 burn-mint 差异", "轻客户端验证 vs 中继信任", "LayerZero/CCIP 消息语义", "重放保护（源链 id + nonce）", "消息延迟与失败补偿", "桥的历史被盗案例复盘"],
    stack: ["Solidity 双链合约", "中继/监听服务（Node）", "数据：消息状态机表"],
    biz: [["M4", "跨链锚定：root 在多条链互为见证", "锚定适配器"], ["M0", "跨境结算演示（港方场景）", "演示脚本"]],
    lain: "对照 lainchain 文档中的 lock-mint / LayerZero 方向，评估是否值得在拆件产品中引入",
    accept: ["消息双向可达且乱序/重复有测试", "安全说明含「假设中继作恶」的后果", "失败补偿路径可演示"] },

  { id: "P13", dir: "P13-BTC脚本UTXO实验室", name: "BTC 脚本 UTXO 实验室", tier: "进阶", track: "生态-BTC", week: "M3·W13（选修）", deps: "S1",
    goal: "用脚本、多签与时间锁做实验，理解 UTXO 模型与「条件支付」的另一种表达。",
    kp: ["UTXO 与账户模型对比", "Script 操作码与 P2PKH/P2WSH", "m-of-n 多签", "CSV/CLTV 时间锁", "PSBT 与离线签名流程", "测试网（signet/testnet4）操作"],
    stack: ["Bitcoin Core + 描述符钱包", "Python/Node 脚本（bitcoinlib / viem 风格）", "数据：UTXO 查询"],
    biz: [["M1/M5", "多签与时间锁 = 资金托管与延迟释放的传统对照", "托管方案对比表"], ["M4", "PoW 链作为最强锚点之一", "锚定选型"]],
    lain: "无对应件；写「EVM vs UTXO 条件支付」对照笔记",
    accept: ["完成 2-of-3 多签与 24h 时间锁各一笔", "PSBT 离线签名流程可复现", "对照笔记 1 篇"] },

  { id: "P14", dir: "P14-BTC资产协议画廊", name: "BTC 资产协议画廊", tier: "进阶", track: "生态-BTC", week: "M3·W13（选修）", deps: "P13",
    goal: "做一个 Ordinals/Runes 小索引工具，理解「在不可执行脚本的链上做资产协议」的取舍。",
    kp: ["inscription/envelope 结构", "Runes 代币与整数除法陷阱", "索引器与链重组", "客户端验证与数据集", "RGB/Atomicals 概念定位"],
    stack: ["Rust 或 Node 索引脚本", "Ord/Runes 解析库", "数据：PostgreSQL + 查询 API"],
    biz: [["M4", "链上锚点的另一种载体（比特币锚定）", "选型附录"]],
    lain: "对照 `indexer/` 的扫块模型，写「BTC 索引 vs EVM 日志索引」差异",
    accept: ["能索引并查询 ≥100 条 inscription", "文档说明该协议的信任假设", "选修结论：是否继续投入"] },

  { id: "P15", dir: "P15-Solana代币DApp", name: "Solana 代币 DApp", tier: "进阶", track: "生态-Solana", week: "M3·W13（选修）", deps: "S2 或并行",
    goal: "用 Anchor 写一个 SPL 代币 + PDA 程序并接前端，体会账户模型与高吞吐的代价。",
    kp: ["账户模型与 rent", "PDA 派生与约束", "CPI 与程序升级", "Token-2022 扩展", "交易确认与 finality", "Rust 所有权在合约里的体现"],
    stack: ["Rust + Anchor + SPL", "wallet-adapter + Next.js", "数据：Helius/getProgramAccounts 或自建索引"],
    biz: [["M2", "高吞吐设备数据的备选底座（评估结论）", "选型对比表"]],
    lain: "无对应件；写「EVM 合约 vs Solana 程序」状态模型对照",
    accept: ["devnet 程序 + 前端全流程", "PDA 权限边界有测试", "选修结论 1 篇"] },

  { id: "P16", dir: "P16-Move资产DApp", name: "Move 资产 DApp", tier: "进阶", track: "生态-Sui", week: "M3·W13（选修）", deps: "S2 或并行",
    goal: "用 Move 的资源模型表达「权益/凭证」，理解对象所有权与 Capability 对权限建模的简化。",
    kp: ["Move 资源与 copy/drop 能力", "Sui 对象模型与所有权", "Capability 授权模式", "泛型与集合", "Transfer/Dewy 式市场", "Sui SDK / dApp Kit 前端"],
    stack: ["Move + Sui CLI / Aptos", "Sui dApp Kit + React", "数据：Sui Indexer / RPC"],
    biz: [["M3 权益与订阅", "对象即权益凭证：转移/冻结/到期建模更自然", "权益模型对照（EVM vs Move）"]],
    lain: "无对应件；对照 `SubscriptionNFT.sol` 写「NFT 权益 vs Move 对象权益」",
    accept: ["devnet 发行 + 转授权 + 过期演示", "权限模型对照笔记", "选修结论 1 篇"] },

  { id: "P17", dir: "P17-MiniAMM高级", name: "Mini AMM", tier: "高级", track: "DeFi", week: "M4·W14–15", deps: "P08",
    goal: "实现恒定乘积兑换与 LP 份额，理解滑点、手续费与无常损失（**仅研发演示，不作内地收入**）。",
    kp: ["x·y=k 与价格影响", "LP token 份额与铸造/销毁", "手续费累加与精度处理", "预言机操纵与 TWAP", "无常损失量化", "闪电贷在本池上的利用"],
    stack: ["Solidity + Foundry（含 fork 测试）", "前端：兑换页", "数据：池子快照索引"],
    biz: [["M0 演示轨", "协议能力展示与教学", "测试网演示 + 风险说明"]],
    lain: "精读 `hardhat/contracts/dex/LainPair.sol`、`LainRouter.sol`，再读 `LainOrderBook.sol` 做撮合对照",
    accept: ["核心函数有 fuzz + invariant（储备非负、份额守恒）", "fork 测试含操纵攻击场景", "M0 边界声明写入 README"] },

  { id: "P18", dir: "P18-借贷质押协议高级", name: "借贷质押协议", tier: "高级", track: "DeFi", week: "M4·W14–15", deps: "P17",
    goal: "实现存借/清算/利率模型，把「不变式」当成一等公民（**仅研发演示**）。",
    kp: ["borrowIndex 懒结算", "健康因子与清算激励", "利率模型（利用率驱动）", "预言机依赖与操纵", "坏账与偿付隔离（treasury vs lockedStake）", "不变式测试"],
    stack: ["Solidity + Foundry invariant", "前端：仓位与清算面板", "数据：风险指标看板"],
    biz: [["M4/M5", "风控与信用建模的思路迁移（不放贷，只做履约评分口径）", "风控指标定义表"], ["M0", "协议能力展示", "测试网演示"]],
    lain: "以 `hardhat/contracts/defi/LainLendingPool.sol` 为主教材精读，并复现其 `Invariant.t.sol`",
    accept: ["不变式 `Σ debt ≤ Σ supply`、`totalStaked == Σ balances` 挂进 CI", "清算路径有集成测试", "利率模型有数值表与边界测试"] },

  { id: "P19", dir: "P19-DAO治理金库高级", name: "DAO 治理金库", tier: "高级", track: "治理", week: "M4·W16", deps: "P17",
    goal: "打通提案—投票—时间锁—金库执行全链路，并把它改造成企业可用的「多签 + 延迟」治理。",
    kp: [" Governor 参数与投票窗口", "Timelock 与延迟执行", "多签（Safe）与角色分离", "Merkle 空投/领取", "累加器分账与金库会计", "治理攻击（闪电贷投票）防御"],
    stack: ["Solidity + Foundry", "前端：提案与执行面板", "数据：治理事件索引"],
    biz: [["M1 多方分账中台", "分成比例变更 = 审批流 + 生效延迟（去币治化）", "治理参数规范"], ["M4/M5", "所有权移交与双人复核", "Runbook"]],
    lain: "精读 `dao/LainGovernor.sol` + `LainTimelock.sol` + `LainTreasury.sol`，以及 `market/SplitPayment.sol` 的累加器",
    accept: ["提案到执行全链路可演示（含时间锁等待）", "部署即移交所有权的演练脚本", "闪电贷投票攻击有防御测试"] },

  { id: "P20", dir: "P20-安全审计实战营高级", name: "安全审计实战营", tier: "高级", track: "安全", week: "M4·W17", deps: "P08",
    goal: "复现并修复 8 大漏洞，产出一份能对外交付的审计报告模板（这是投标与安评的硬通货）。",
    kp: ["重入（含跨合约）", "权限缺失与初始化暴露", "整数精度与舍入方向", "签名重放与域分隔", "预言机操纵", "闪电贷治理攻击", "delegatecall 存储碰撞", "静态分析：Slither/Aderyn"],
    stack: ["Foundry（攻击脚本 + 修复回归）", "Slither / Aderyn", "报告：Markdown + 威胁矩阵"],
    biz: [["全部模块", "安评材料与第三方信任", "审计报告模板 + 检查表"], ["M0", "对 lainchain 本体做一次真实审计", "报告 1 份"]],
    lain: "以 `lainchain-defi/docs/` 安全模型（信任边界 / STRIDE / 不变式 / 历史修复）为骨架，反向做一次独立审计",
    accept: ["8 个漏洞各有 PoC + 修复 + 回归测试", "Slither/Aderyn 零高危进入 CI", "报告含风险定级与修复优先级"] },

  { id: "P21", dir: "P21-合约监控应急高级", name: "合约监控与应急", tier: "高级", track: "运维", week: "M4·W17", deps: "P10",
    goal: "建立事件监听告警 + 暂停/升级应急演练，让「维保」成为可报价的服务能力。",
    kp: ["关键指标（TVL、异常提现、权限变更、预言机延迟）", "告警分级与值班", "Pausable 与熔断", "应急 Runbook 与演练", "备份密钥与恢复路径", "链上/链下一致性巡检"],
    stack: ["Node/Spring Boot 监控服务 + Prometheus/Grafana", "合约：Pausable/角色", "通知：企业微信/钉钉/邮件"],
    biz: [["M2/M5", "运维 SLA 与维保收入（交付后持续收费的依据）", "监控面板 + Runbook"], ["全部模块", "事故响应能力", "演练记录"]],
    lain: "对照改进清单：lainchain 无监控体系 → 设计事件告警并作为 G6 交付项",
    accept: ["至少 6 类告警可触发并送达", "一次暂停 + 一次升级演练有录像/截图", "MTTR 目标与值班表"] },

  { id: "P22", dir: "P22-Geth-Reth改造专家", name: "Geth/Reth 改造", tier: "专家", track: "链开发", week: "M5 选修", deps: "选修 Go/Rust",
    goal: "给客户端加一个自定义 RPC 或日志字段，理解节点内部数据流与共识/执行边界。",
    kp: ["Geth 服务架构与 API 注册", "Reth 的模块化与任务流", "状态数据库与快照", "交易池与打包", "私有链/联盟链 genesis 与权限"],
    stack: ["Go（Geth）或 Rust（Reth）", "自定义 RPC + 集成测试", "数据：私有 devnet"],
    biz: [["M4/M2", "盟链定制与私有运维能力（客户自建链场景）", "定制节点说明"]],
    lain: "无对应件；写「为什么盟链交付常需要改客户端」判断笔记",
    accept: ["自定义 RPC 在 devnet 可用并有测试", "文档说明改动点与升级风险", "选修结论"] },

  { id: "P23", dir: "P23-CosmosAppChain专家", name: "Cosmos AppChain", tier: "专家", track: "链开发", week: "M5 选修", deps: "选修",
    goal: "用 Cosmos SDK 起一条本地 devnet，实现一个自定义模块（例如资产登记），体会应用链的开发成本。",
    kp: ["Tendermint/CometBFT 共识", "SDK 模块与 keeper 模式", "消息与状态机", "IBC 概念", "链参数治理与升级"],
    stack: ["Go + Cosmos SDK", "本地 devnet 脚本", "数据：链上查询 CLI"],
    biz: [["M2", "行业链/专有链的可行性与成本评估", "选型报告"]],
    lain: "无对应件；写「EVM 盟链 vs 应用链」成本对照",
    accept: ["devnet 起链 + 自定义模块可读写", "一次链升级演练", "选型结论 1 篇"] },

  { id: "P24", dir: "P24-OPStack-L2专家", name: "OP Stack / L2", tier: "专家", track: "链开发", week: "M5 选修", deps: "P11",
    goal: "本地起一条 OP-Stack devnet 并部署合约，说清排序器、数据可用性与强制提现。",
    kp: ["L2 执行与结算分层", "批次提交与 DA", "挑战期与欺诈证明", "排序器中心性与故障", "跨层消息与提现路径"],
    stack: ["OP Stack（Docker）+ Foundry", "本地 devnet", "数据：L1/L2 消息追踪"],
    biz: [["M4/M1", "低成本批量锚定与结算的容量测算", "成本模型"]],
    lain: "无对应件；写「存证锚定放 L1 还是 L2」决策依据",
    accept: ["devnet 可部署合约并完成一次跨层提现", "故障场景（排序器停机）有实验记录", "成本模型 1 份"] },

  { id: "P25", dir: "P25-ZK电路实验专家", name: "ZK 电路实验", tier: "专家", track: "前沿", week: "M5 选修", deps: "选修",
    goal: "写一个简单电路（哈希预映像 / 范围证明）并在链上验证，理解隐私存证的工程边界。",
    kp: ["约束系统与算术化", "Circom 或 Noir 基础", "可信设置与证明体积", "链上验证器 Gas", "隐私与合规的张力（可审计的匿名）"],
    stack: ["Circom/Noir + snarkjs", "Solidity 验证器", "数据：证明耗时统计"],
    biz: [["M4", "「原文不出域仍可证真」的隐私存证路线", "可行性实验报告"], ["M2", "数据最小化的高级形态", "实验笔记"]],
    lain: "对照 lainchain 文档中「ZK 真实注意力」方向，评估是否值得投入",
    accept: ["本地生成证明 + 链上验证通过", "证明/验证耗时与体积有数据", "隐私存证可行性结论"] },

  { id: "G1", dir: "G1-全栈NFT游戏市场毕业", name: "全栈 NFT / 游戏市场", tier: "毕业", track: "综合", week: "M6", deps: "P07 + P09 + P21",
    goal: "作品集级完整产品：铸造、交易、版税、索引、监控一条链路全部可演示。",
    kp: ["产品 PRD 与架构图", "全栈工程化与部署", "数据看板与运维"],
    stack: ["Solidity + Next.js + 索引器 + 监控", "部署：测试网 + 前端托管", "文档：PRD/架构/复盘"],
    biz: [["M3 权益与订阅", "权益市场形态的产品原型", "可演示产品 + 文档"]],
    lain: "对照 `game/*`（LainHero/LainItem/GameCore/Crafting/Guild）与 `market/NFTMarketplace.sol`",
    accept: ["核心流程可演示并部署测试网", "README 可复现", "3 条 STAR 简历描述"] },

  { id: "G2", dir: "G2-小型DeFi协议毕业", name: "小型 DeFi 协议", tier: "毕业", track: "综合", week: "M6", deps: "P17/P18 + P20 + P12",
    goal: "一个 DEX 或借贷协议的完整交付：设计、测试、审计、部署、监控（**归 M0 演示轨，不作内地收入**）。",
    kp: ["协议设计与经济参数", "不变式与形式化直觉", "审计报告与修复", "跨链部署"],
    stack: ["Solidity + Foundry invariant + Slither", "前端 + 风险看板", "部署：多测试网"],
    biz: [["M0 演示轨", "协议能力展示与教学", "审计报告 + 演示"]],
    lain: "以 `defi/LainLendingPool.sol` + `dex/*` 为基线做重构与加固",
    accept: ["不变式 CI 常驻", "对外审计报告 1 份", "M0 边界声明（不面向境内公众运营）"] },

  { id: "G3", dir: "G3-BTC生态应用毕业", name: "BTC 生态应用", tier: "毕业", track: "综合", week: "M6", deps: "P13 + P14 + 前端",
    goal: "Ordinals/Runes 工具型产品（索引 + 查询 + 出证），证明跨生态工程能力。",
    kp: ["BTC 索引与重组", "PSBT 与离线签名", "工具型产品交互"],
    stack: ["Rust/Node + PostgreSQL", "前端查询界面", "部署：testnet"],
    biz: [["M4", "比特币锚定作为最强见证之一", "锚定方案附录"]],
    lain: "无对应件",
    accept: ["工具可公开试用", "索引数据与浏览器一致", "作品集文档"] },

  { id: "G4", dir: "G4-多链身份声誉空投平台毕业", name: "多链身份 / 声誉 / 空投平台", tier: "毕业", track: "综合", week: "M6", deps: "P09 + P12 + P19",
    goal: "**M4 企业可信档案的毕业形态**：身份(SBT) + 履约声誉 + Merkle 批量发放 + 出证 API。",
    kp: ["SBT/不可转让身份", "声誉口径设计与可撤销", "Merkle 批量发放", "跨链锚定与出证", "合规：不碰征信与个人信用评分"],
    stack: ["Solidity + Spring Boot BFF + PostgreSQL", "前端：企业后台与核验页", "部署：盟链 + 公链锚点"],
    biz: [["M4 企业可信档案", "产品原型 + 出证接口 + 独立验证器", "可报价的模块 v0"], ["M1", "批量发放复用同一 Merkle 内核", "复用说明"]],
    lain: "精读 `identity/LainID.sol`（260）、`ReputationRegistry.sol`（249）、`CPHSRegistry.sol`（285），并做去代币化改造",
    accept: ["≥3 家真实/模拟主体存证并出证", "第三方离线验证器可用", "合规检查表通过（声誉不做征信结论）"] },

  { id: "G5", dir: "G5-Web3xAI毕业", name: "Web3 × AI", tier: "毕业", track: "综合", week: "M6", deps: "合约 + AI 服务 + 索引",
    goal: "链上 Agent 资产与行为存证：AI 决策留痕、可审计、可追责（与 LangChain4j 技术栈衔接）。",
    kp: ["Agent 身份与授权边界", "行为日志上链与哈希锚定", "模型输出可验证性（含 ZK 远期）", "AI 调用成本与链上结算"],
    stack: ["Spring Boot + LangChain4j", "Solidity（AgentNFT/存证）", "数据：调用日志索引"],
    biz: [["M4", "AI 行为可审计档案（新场景）", "概念验证"], ["M3", "Agent 权益与配额凭证", "原型"]],
    lain: "精读 `identity/AgentNFT.sol` 与 `attention/*`（多源验证、反女巫）",
    accept: ["一次 AI 任务全链路留痕并可出证", "权限边界测试（Agent 不能越权花钱）", "复盘：哪些是噱头、哪些真有用"] },

  { id: "G6", dir: "G6-LainChain实体经济平台生产化", name: "LainChain 生产化改造（旗舰）", tier: "毕业", track: "综合", week: "M6", deps: "全部主线",
    goal: "**把 lainchain-defi 当零件库做生产化改造**：仓库净化 → 静态分析门禁 → Spring Boot BFF → 索引重组处理 → 测试网部署 → 拆件产出 M1/M2/M3。",
    kp: ["仓库卫生与脚本分层（scripts vs scripts/debug）", "质量门禁 verify：forge + invariant + e2e + build + Slither", "BFF 生产化（web3j + 部署产物驱动）", "索引器重组与确认深度", "多签与所有权移交", "去代币化改造"],
    stack: ["Solidity + Foundry + Slither/Aderyn", "Spring Boot 4.1 + Java 21 + web3j", "Next.js 前端 + PostgreSQL 索引"],
    biz: [["M1 多方分账中台", "SplitPayment 净化版 + 对账 BFF", "可独立编译交付件"], ["M2 设备可信结算", "IoTBridgeForMcu + 固件 + 网关", "一体机方案"], ["M3 权益与订阅", "SubscriptionNFT / RentalMarket 净化版", "权益模板"]],
    lain: "全项目本体：按 `lainchain-defi-分析与并入路线.md` 的 P0/P1/P2 改进清单逐条落地",
    accept: ["5 个立刻可做改造任务全部有 PR 级记录", "verify 门禁常驻", "M1/M2 拆件可脱离原仓库编译", "Sepolia 部署 + 监控 + 出证演示"] },
];

const STAGES = [
  [/^P0[123]$/, "S1-区块链基础"],
  [/^P0[456]$/, "S2-智能合约入门"],
  [/^P(0[789]|10)$/, "S3-合约进阶与数据"],
  [/^P1[1-6]$/, "S4-生态专项"],
  [/^P1[7-9]$|^P2[01]$/, "S5-高级应用"],
  [/^P2[2-5]$/, "S6-链开发与前沿"],
  [/^G\d$/, "S7-毕业项目"],
];
const stageOf = (id) => STAGES.filter(([re]) => re.test(id)).map(([, s]) => s).find(Boolean) ?? "S7-毕业项目";

const render = (p) => `# ${p.id} · ${p.name}（${p.tier}）

> 状态：未开始 ｜ 里程碑：${p.week} ｜ 层级：${p.tier} ｜ 主线：${p.track} ｜ 依赖：${p.deps}
> 一句话目标：${p.goal}

## 目标

${p.goal}

出口能力：见 [开发计划.md](../../开发计划.md) §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

${p.kp.map((k) => `- [ ] ${k}`).join("\n")}

## 技术栈

${p.stack.map((s) => `- ${s}`).join("\n")}

## 目录（开工时再建）

\`README.md\` + \`contracts/\` + \`frontend/\` + \`backend/\` + \`docs/\` + \`screenshots/\`（按需，不预铺空壳）

## 商业落点（合规模块）

| 模块 | 本项目提供什么 | 交付形态 |
|------|----------------|----------|
${p.biz.map(([m, what, form]) => `| ${m} | ${what} | ${form} |`).join("\n")}

> 模块定义与合规边界：[合规模块产品线](../../docs/00-预备/合规模块产品线.md)

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] ${p.lain}
- 输出：\`docs/${stageOf(p.id)}/lainchain对照-${p.id}.md\`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

${p.accept.map((a) => `- [ ] ${a}`).join("\n")}
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；\`.env\` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
`;

let created = 0, skipped = 0;
for (const p of M) {
  const dir = path.join(ROOT, "projects", p.dir);
  const file = path.join(dir, "README.md");
  if (existsSync(file) && !force) { skipped++; continue; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, render(p), "utf8");
  created++;
}
console.log(`生成 ${created} 个，跳过（已存在）${skipped} 个`);
