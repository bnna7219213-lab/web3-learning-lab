# P07 · NFT 市场（进阶 · S3 起点）

> 状态：**已完成，本机实测通过（anvil + 本地 IPFS + 浏览器 E2E）** ｜ 里程碑：M2·W6–7 ｜ 层级：进阶 ｜ 主线：全栈 ｜ 依赖：P06 ｜ 更新：2026-11-11
> 一句话目标：做 ERC721/1155 的铸造—挂单—成交—下架全流程，并吃透 EIP-4907 租期权限分离。
> 合规：二级市场入口 `tradingEnabled` **默认关闭**；LAB 系 NFT 为零价值学习凭证。

## 运行

```bash
# 0) 本地 IPFS（一次性；Windows Git Bash 注意 MSYS_NO_PATHCONV，见下）
export IPFS_PATH="C:/Users/<you>/tools/ipfs-repo"
ipfs init                                   # kubo v0.43.1，解压自 GitHub Releases
MSYS_NO_PATHCONV=1 ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/8088"   # 避开 8080 的 serve-lab
MSYS_NO_PATHCONV=1 ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs daemon --offline                       # API 5001 / 网关 8088，不连公网 swarm

# 1) 合约
cd projects/P07-NFT市场进阶
forge test                                  # 35 项（fuzz + invariant）
anvil                                       # 另开终端
bash script/deploy.sh anvil                 # 三件套 + ABI + 部署记录（trading 默认 OFF）

# 2) 元数据 pin（可选，前端铸造也会自动 pin）
node scripts/pin-metadata.mjs --name "Lab NFT #0" --image assets/lab-nft-0.svg

# 3) 前端
cd frontend && npm install && npm run dev   # → http://127.0.0.1:5174
```

浏览器：演示钱包（anvil 解锁账户，零私钥）或 MetaMask（添加 Anvil 31337）。
admin 面板显式开启二级市场入口后：铸造（自动 pin IPFS）→ 挂单（自动补授权）→ 换账户购买 → 下架 →
租期设置 → 签名卖单/填单。事件流实时刷新。

## 目录

```text
P07-NFT市场进阶/
├── src/LabNFT.sol          ERC721+URIStorage+Burnable+ERC2981+EIP-4907（转让清租约）
├── src/LabEditions.sol     ERC1155+URIStorage+ERC2981（多份凭证）
├── src/NFTMarket.sol       托管挂单/成交/下架 + EIP-712 签名订单 + 合规开关 + 重入防护 + 接收钩子
├── test/                   35 项：4907 到期/合规默认关/版税守恒/签名五负例/重入/托管 invariant
├── script/Deploy.s.sol     三件套部署 + Recorder（含 tradingEnabled 默认状态落盘）
├── scripts/pin-metadata.mjs  元数据/图片 pin + 读回逐字节自证
├── assets/lab-nft-0.svg    演示图片
├── frontend/               Vite+React+wagmi：画廊/铸造/挂单/购买/下架/租期/签名订单/事件流
├── abi/ · deployments/     自动导出；deployments/31337/P07.json
├── docs/01-租期版税撮合与合规开关.md
└── screenshots/01-市场全流程与事件流.png
```

## 知识点

- [x] ERC721/1155 与元数据标准（URIStorage、tuple 返回、接收钩子）
- [x] IPFS 与哈希锚定（CIDv1=内容哈希；读回自证；离线可复跑）
- [x] 签名订单与链下撮合（EIP-712 SellOrder；nonce/deadline/域分隔；与托管路径取舍见 docs/01 §3）
- [x] 版税与 ERC2981 局限（报价非强制；市场内强制分配；超额防御；守恒 fuzz）
- [x] EIP-4907 owner/user 双角色（到期自动失效；转让清租约；事件可观察）
- [x] 市场转账安全（safeTransferFrom + nonReentrant + CEI + sendValue；重入 PoC 测试）

## 验收（实测记录，2026-11-11）

| 项 | 结果 |
|----|------|
| forge test | **35 passed / 0 failed**；覆盖率 LabNFT/LabEditions 100%，NFTMarket 91.4% 行 |
| 部署 | nft `0x9A67…7508` · editions `0x0B30…7016` · market `0x9599…07B1`；**tradingEnabled=false 落盘** |
| 合规默认关闭 | list/buy/fill 默认 revert TradingDisabled；admin 开启后才可交易；cancel 不受开关限制 ✓ |
| IPFS | 图片 CID `bafkreicmh5…uzq` / 元数据 CID `bafkreihbl2…k7ym`；readback=IDENTICAL；画廊从网关读回渲染 |
| 721 全流程 | 铸造→挂单（托管 owner=market，tx `0xeb296622…` #26）→#1 购买（Sold 事件）→#1 再挂→下架取回 ✓ |
| 4907 | #1 设租给 #2（tx `0x3289119f…` #28）userOf 显示；转让后 UpdateUser(0x0,0) 清租约 ✓；到期失效由测试钉死 |
| 签名订单 | #1 签名（eth_signTypedData_v4）→#2 填单成交 → OrderFilled `0xabd8f6e2…`，owner=#2 ✓ |
| 1155 | 铸 10 份→挂 4 份 @2ETH→#1 购买；链上余额 4/6 核对 ✓ |
| 事件流 | Listed/Sold/Cancelled/OrderFilled/UpdateUser 实时入流（新订阅 4s 内到达） |
| 完整路径截图 | screenshots/01-市场全流程与事件流.png |
| 仓库零私钥 | 演示钱包节点代签；env 无密钥 |

## 过程中修掉的真实缺陷（详见 docs/01 §7）

1. 市场未实现 721/1155 接收钩子 → 托管 safeTransferFrom 被拒（ERC721InvalidReceiver）。
2. 前端挂单未先授权 → 补 isApprovedForAll 检测 + 自动 setApprovalForAll（nonce 顺序保证）。
3. useReadContracts tuple 返回按对象 spread 丢字段 → 挂单板空白；改数组解构。
4. Git Bash MSYS 把 multiaddr 参数转成 Windows 路径 → kubo 网关配置损坏；MSYS_NO_PATHCONV=1 修正。

## lainchain 对照精读

- [ ] 读 `hardhat/contracts/market/RentalMarket.sol`（331 行）与 `NFTMarketplace.sol`：租期与挂单撮合实现
- **待源件**：lainchain-defi 不在本机，不凭印象写对照；源件可得后补 `docs/S3-合约进阶与数据/lainchain对照-P07.md`。

## 复盘

- 卡住的点：托管接收钩子与授权前置是"合约对了前端才跑得通"的典型——**市场类合约的集成测试必须带真实接收方**。
- 与 Java/传统后端的对照：escrow≈第三方担保交易账户；签名订单≈带签名的报价单（离线撮合所）；
  4907≈带 TTL 的授权令牌；ERC2981≈行业自律分成协议（不具强制力）。
- 下次可压缩的时间：钱包 shim/事件流/回执轮询骨架复用 P06，前端只写业务面板；IPFS 脚本一次成型。