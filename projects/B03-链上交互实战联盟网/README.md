# B03 · 链上交互实战（联盟网）

> 状态：**已部署（2026-10-16 服务器实测）+ 全流程 QA 通过（有保留）** ｜ 对应主线：[P03](../P03-链上交互实战基础/README.md) ｜ 网络底座：[shared/consortium-network](../../shared/consortium-network/README.md) ｜ 更新：2026-11-11
> **本机复跑**：Windows/Git Bash 全流程已于 2026-11-11 实跑通（含钱包页六步流水线 6/6），步骤见 [P03 README「运行」](../P03-链上交互实战基础/README.md)；下文服务器形态保留作生产对照。
> 一句话目标：在自建 QBFT 联盟网上完成「建账户 → 授权 → 发交易 → 用内网浏览器逐字段解析」，替代公链浏览器依赖。
> **QA 报告（6 步流水线逐步截图校验）**：docs/QA-2026-10-16/QA报告-钱包流水线全流程.md（属主仓库内容，未随本公开仓库发布）

## 已部署环境（服务器 <YOUR_SERVER_IP> · 2026-10-16 实测）

| 项 | 值 |
|----|----|
| 外网浏览器 | **http://<your-domain.example>/b03/** （nginx 静态页，浏览器直接打开） |
| 外网 RPC | **http://<your-domain.example>/b03-rpc/** （nginx 反代节点池 8551–8554，当前 3 台在线、8554 标 down） |
| 链 | chainId 19880601 · QBFT 4 验证者 · 零 gas（gasPrice=0, baseFee=0）· 出块 5s |
| 节点 | Besu 26.9.0 + Oracle JDK 25，`/root/consortium-network/run/node-1..4`，**systemd 托管 `besu-node@1..4`**（2026-10-16 起，不再是 nohup 孤儿进程） |
| 运行拓扑 | **当前 3/4 验证者在线**（`besu-node@4` disabled）。1.9G 内存与<server-panel>生产栈共存只够 3 台；quorum=⌈2f+1⌉=3 恰好满足，**零容错** |
| 访问入口 | **只认 `<your-domain.example>` / `<your-domain.example>`**。2026-10-19 起 IP 直连已关闭：nginx 加了 `default_server` 兜底块对其它 Host 一律 `return 444`。这不只是下线 IP——没有它的话任何人把域名 A 记录指到本机 IP，用 `Host: 他的域名` 就能原样取到本站内容 |
| HTTPS | **已生效**（2026-10-19）：Let's Encrypt 证书 `CN=<your-domain.example>`，到期 2027-01-17，certbot timer 自动续，零费用。按"**不强制跳转**"配置——80 与 443 并存各自服务，也**没加 HSTS**（HSTS 会让浏览器自动升级，效果等同强制跳转）。443 同样有 `default_server` 兜底，用 `ssl_reject_handshake` 拒绝未知 SNI，避免替别人的域名出示本站证书。曾卡在我是**阿里云安全组**未放行 443（判据：公网打 443 超时而非拒绝），放行后未再改任何配置即生效 |
| 备案号 | 页脚展示 `<ICP备案号>`，链到 `https://beian.miit.gov.cn/`（`/b03` 挂在已备案主域下，工信部要求页面可见）。实测 https 下**混合内容资源为 0** |
| 与现网站关系 | b03 的四个 location 已并入 `<your-domain.example>` 这个 server 块（`include snippets/b03-locations.conf`），`/` 仍反代 :8080 不动。注意主站当前 502 是 `<customer-service-b>` 挂了（启动脚本在 /var/tmp 被清），与本项目无关 |

**复现步骤**（服务器上）：

```bash
export JAVA_HOME=/opt/jdk-25.0.4.1 && export PATH=$JAVA_HOME/bin:$PATH
cd /root/consortium-network
bash scripts/00-preflight.sh
bash scripts/10-genesis.sh ./networkFiles        # genesis 模板已修正为 26.9.0 新格式
bash scripts/21-up-native.sh                     # 只用于首次拉起（幂等，重跑不会洗链）
bash scripts/50-install-systemd.sh               # ← 生产形态：备份→停旧→systemd 托管→断言链高续跑
systemctl status besu-node@{1,2,3}               # 之后一律用 systemd，不要再手跑 21
RPC=http://127.0.0.1:8551 bash scripts/30-smoke-test.sh
```

**部署实测踩坑（已修）**：

1. **Besu 26.9.0 的 generate-blockchain-config 输入格式变了**：`blockchain` 里 `nodes` 不再是 `"4"` 字符串，而是对象 `{"nodes": {"generate": true, "count": 4}}`——旧写法报 `Expected object value but got string`。已修正 `shared/consortium-network/genesis/qbftConfigFile.json.tpl`。
2. **1.9G 内存跑不动 4 节点默认 heap**：未限 Xmx 时 node-1 被 OOM Kill（dmesg 可查），且 `21-up-native.sh` 重启会 **清空 run/ 数据、链头归零**（已重发演示交易）。现在 `BESU_OPTS=-Xmx140m` + 已加 2G swap（/swapfile2）兜底。
3. **nginx 反代 Besu 必须处理两个头**：`Host` 改写为 localhost（Besu `rpc-http-host-allowlist` 默认只认 localhost，否则 403 "Host not authorized"）；剥掉 `Origin/Referer`（Besu 默认 `rpc-http-cors-origins` 为空，带 Origin 的浏览器请求被 403 "CORS Rejected"）。nginx 收到的外部公网请求默认带 Origin，这一步必做。
4. `/root` 是 0700，nginx worker 进不去 → 静态页放 `/var/www/b03-explorer/`（已 `semanage fcontext` 打 httpd 标签）。
5. 未装 Foundry/cast（服务器下载 GitHub release 太慢），演示交易用本机 Node + ethers 直连外网 RPC 发出。
6. **水龙头双 `request` 监听器崩溃（2026-10-16）**：`server.js` 里 `http.createServer(handler)` 之外又挂了第二个 `server.on('request')` 做 `/health`，任何 GET 请求会先被第一个处理器回 404、再被第二个响应 → `ERR_HTTP_HEADERS_SENT` 进程退出 → systemd 无限重启 → nginx 502。已合并为单监听器（`/health` 分支放最前），并在 `json()` 加 `headersSent/writableEnded` 防重复响应兜底；systemd 单元补 `OOMScoreAdjust=-1000` 防 OOM 误杀。
7. **`21-up-native.sh` 会洗掉整条链（2026-10-16 修）**：原第 40 行 `rm -rf "$RUN"`，而 `run/node-N/key` 是链上验证者身份、`run/node-N/data` 是全部区块。重跑一次脚本 = 链归零且**旧链永久不可恢复**。现在幂等续跑，重建要 `FORCE=1` 且只删 `data/`。
8. **4 个验证者在这台机器上不可能稳定运行（容量结论）**：单节点 RSS 实测 335–346 MB，且 `-Xmx140m` 压不住——大头在 metaspace（约 300 个 jar）、Netty/RocksDB 直接内存、线程栈、JFR，不在 Java 堆。同机还常驻 mysqld 285MB + Spring 应用 203MB + <server-panel> + 阿里云盾，非 Besu 基线约 800–900MB。今天 OOM killer 实际杀掉的是**客户的 mysqld（两次）、dockerd、polkitd 甚至 systemd helper**，还顺手杀了我自己的 `systemctl`。结论：**链与 Web 生产栈不要同机**，或给链 ≥4GB。
9. **只起 2/4 时链静默停摆；补节点必须全体同时重启**：2 验证者在线时 RPC 全部正常、peers 正常、高度就是不动（quorum=3 未满足）。而且把第 3 个节点单独加回来后 peers=2 仍不出块，必须 `systemctl restart besu-node@{1,2,3}` 一起重启重置 round 才恢复。排障口诀：**看高度会不会涨，别看进程在不在**。
10. **公网 RPC 白名单曾含 ADMIN（已收）**：`--rpc-http-api` 里的 ADMIN 经 nginx 反代后等于把 `admin_addPeer` 开放给整个互联网。现收敛为 `ETH,NET,WEB3,QBFT`，实测 `admin_nodeInfo` 返回 `-32604 Method not enabled`。

**已验收**：外网浏览器打开绿灯、3 成员账户各 5 笔交易 nonce 互不干扰、每笔交易逐字段解析（selector/nonce/receipt/终结性）、4 节点对同一交易与区块查询结果一致、原 <your-domain.example> 站点不受影响。

## 自建钱包与服务器专属领币（2026-10-16，不依赖任何公链）

私链没有公共 faucet / Etherscan——三件套全部自建，币只来自本链：

| 环节 | 公链（Sepolia）做法 | 本私链做法（已部署） |
|------|--------------------|--------------------|
| 生成地址 | MetaMask / geth / ethers | **[钱包页](http://<your-domain.example>/b03/wallet.html)**（浏览器本地 ethers 生成，secp256k1 不依赖任何链） |
| 领币 | Alchemy/QuickNode 等公共 faucet | **服务器专属水龙头** `POST /b03-faucet/claim`（运营方账户签名，每次 10 B03，地址 60s 冷却）+ genesis `alloc` 预分配兜底 |
| 查余额/交易 | sepolia.etherscan.io | **[/b03/ 解析页](http://<your-domain.example>/b03/)**（支持交易哈希/区块/地址三种查询） |
| 钱包连链 | MetaMask 选 Sepolia | MetaMask 连不了公网 IP 的 http（强制 https，仅 localhost 豁免）→ 用自建钱包页，同源 RPC |

**服务清单**：

- 钱包+领币页：`http://<your-domain.example>/b03/wallet.html`（源码 `explorer/wallet.html|wallet.js`，ethers UMD 同目录本地加载）
  - `explorer/ethers.umd.min.js` 已 vendored 入库（MIT，来自 `ethers@6.17 dist/`，2026-11-11 补——公开仓库剥离时曾缺失，
    导致钱包页 404 静默失效；升级 ethers 时从 `node_modules/ethers/dist/` 重新拷贝）
- 水龙头：`/opt/b03-faucet/server.js`，systemd `b03-faucet.service`（开机自启，MemoryMax=180M），监听 127.0.0.1:8560，nginx `/b03-faucet/` 反代
- 水龙头私钥：**服务器本地生成**（`/opt/b03-faucet/.env`，600 权限，不经网络传输）；资金由运营方账户一次性充值（`faucet/` 里有充值脚本思路，私钥只在本机运行时从 `.env` 读取）
- **衔接 B07 权益凭证（2026-11-13）**：水龙头支持可选回调 `CREDENTIAL_URL`——领币成功后回调 B07 发证服务
  （`projects/B07-NFT市场联盟网/scripts/credential-service.js`，监听 8580），**一次领取同时得到「联盟链余额 + 权益凭证」**：
  发证服务校验「该地址链上有余额」（= 确实领过水）→ 登记为链上成员 → 生成元数据入内网 OSS → 用 P01 出证库算 Merkle 根 → 发行 1 份凭证。
  衔接失败**不阻断领币**（币已经发出去了，不能因为凭证服务挂了让人拿不到钱），钱包页会显示「凭证未发放 + 原因」。
  本机启动：`set CREDENTIAL_URL=http://127.0.0.1:8580 && node faucet/start.js`（私钥从仓库根 `.env` 读，**不进命令行**）。
  实测：一次领取 → 10 B03 + 凭证 #2044（含凭证交易哈希与内网元数据链接）；负例按预期被拒（没领过水 → 429、60s 冷却 → 429）。

**已验收（外网浏览器实测）**：生成钱包 → 领 10 B03 成功（tx 入块）→ 同地址再领 429 冷却生效 → 余额/nonce/gasPrice 显示 → 地址查询在 /b03/ 逐字段展示（含"无索引器"边界说明与多节点一致性自查指引）。

**流水线指引 UI（2026-10-16 补充）**：浏览器首页新增「钱包操作流水线」卡片——①创建钱包 ②提取地址 ③领币 ④填收款地址 ⑤发交易 ⑥浏览器自查，6 步横向流程格。状态实时检测（localStorage 标记 `b03_wallet_addr`/`b03_to`/`b03_last_tx` + `eth_getBalance`/`eth_getTransactionCount`），已完成步绿框、当前待办步蓝框高亮，每步带锚点跳转（`wallet.html#secCreate` 等），底部汇总「已完成 x/6 步 · 下一步：…」并给出动态「去第 N 步」按钮；第 6 步链接直接把交易哈希填入搜索框并滚动到逐字段解析区。钱包页相应新增「复制地址」按钮。**已验收：全流程 0/6 → 6/6 走通，第 6 步点击自动查询 PASS**。

**零 gas 链的语义提醒（2026-10-16 QA 精确化）**：本链 gasPrice=0，"没币就发不了交易"**基本**不成立——但 `--tx-pool-enable-balance-check=false` 免的是**gas 成本**的余额检查，**转账面值仍要求 `balance ≥ value`**：一个余额 0 的全新账户发 `value=1 wei` 会被节点直接拒（`-32004 Insufficient funds for transfer`），发 `value=0` 则畅通无阻（实测两个从未上过链的新账户各发 2 笔全部入块）。
所以准确说法是：**零 gas 免的是手续费，不是本金。** 领币验证的是**资产分发与水龙头治理**语义（运营方 alloc 预存 → 链下 faucet 分发 → 链上余额可查），与公链"领水才能付 gas"不同。

## Etherscan 级私有浏览器（2026-10-16，不依赖任何公网基础设施）

在自有服务器的链与算力上覆盖公网 Etherscan 的核心能力，能力范围：**核心四件套（地址交易历史 / 区块分页 / 全局搜索 / 统计图表）+ ERC-20 代币页**。

| 环节 | 公网 Etherscan 做法 | 本私链做法（已部署） |
|------|--------------------|--------------------|
| 交易/区块/地址索引 | Etherscan 后端索引集群 | **自研轻量索引器 `b03-indexer`**（Node + better-sqlite3，RSS ≈76MB，`MemoryMax=120M` + `OOMScoreAdjust=500`）扫块建索引 |
| 地址交易历史列表 | 索引器按地址倒序翻页 | `/b03-api/api/v1/address/:addr/txs`（收/发/全部过滤 + 翻页） |
| 区块列表分页 | 分页接口 | `/api/v1/blocks?page=`，索引器不可用时前端降级 RPC 直查最近 10 块 |
| 统计图表 | 日交易/活跃地址图 | 手写内联 SVG（零依赖）：每日交易数柱 + 活跃地址折线 |
| ERC-20 代币页 | Token 页 / Holders / Transfers | 索引器识别 Transfer 事件（topic0 `0xddf252ad…`），持仓分布 BigInt 净值聚合（无精度损失） |
| 全局搜索 | 搜索框 | 前端正则分发：tx/地址/区块；命中代币合约显示元数据徽标 |
| 健康检查 | — | `/b03-api/health` 比对游标 vs 链头（探链，非静态 200） |

**服务清单**：

- 索引器：`/opt/b03-indexer/`（源码 `projects/B03-链上交互实战联盟网/indexer/`），systemd `b03-indexer.service`（开机自启，`After=besu-node@1`），SQLite 落 `data/index.db`，游标 `meta.last_scanned` 续扫不清零
- 查询 API：`http://<your-domain.example>/b03-api/`（nginx 反代 127.0.0.1:8570，独立限速 zone `b03_api_ip` 10r/s——**勿复用水龙头 6r/m zone**，会 503）
- 演示代币：`DemoToken`（DEMO）合约 `0x396b26A365DfDd99eaA4Bf0808086Cf138Bf4899`，totalSupply 1,000,000（admin 700k + 3 演示地址各 100k）；源码 `token/DemoToken.sol`，编译产物 `token/DemoToken.artifact.json`，部署脚本 `scripts/01-deploy-demo-token.js`

**关键边界（QA 实测）**：

1. **合约编译须 `evmVersion=paris`**：solc 0.8.26 默认字节码含 `PUSH0`（Shanghai 引入），本链 EVM 不支持 → 部署 `status=0` 烧光 gas。已用 solc JS API 指定 `settings.evmVersion=paris` 重编（见 artifact 的 compiler 字段）。
2. **代币 total_supply 需每批刷新**：scanner 只在代币首次出现时拉元数据会导致 `total_supply` 停在旧快照（mint 后不更新）。现已对每批涉及的代币都 `eth_call` 刷新（mint/transfer 必带 Transfer 事件，故末次刷新值 == 当前供应量）。
3. **水龙头加固（QA 遗留项 3/4 已修）**：冷却记录落盘 `/opt/b03-faucet/data/claims.json`（进程重启不清零）、每日总预算 500 B03（UTC 日切）、`/health` 加 `eth_blockNumber` 3s 超时探链（断链返 503，不再用静态 200 掩盖链故障）。

**已验收（外网浏览器实测，2026-10-16）**：统计图表渲染（柱+折线+图例）、区块分页翻页、地址交易历史（含转出过滤/翻页，水龙头地址 11 笔）、代币页（DemoToken 详情：持仓 700k/3×100k、4 笔 mint 标记）、搜索增强（合约地址显示 ERC-20 徽标 + 元数据）、`?tx=` 深链自动查询、6 步流水线回归。console 无 JS ReferenceError。

## 出证能力（2026-10-16，M4 企业可信档案的落地起点）

给"某件事发生过"生成**第三方可独立复核**的证据包，核心在 `shared/evidence/`（零依赖，只用 `node:crypto`）。

| 环节 | 做法 |
|------|------|
| 批次承诺 | Merkle **v2 indexed-position** 树。v1 的"奇数复制末叶"会让不同规模批次算出等价树（P01 实验证明），v2 把位置绑进每层哈希、奇数补固定 EMPTY 哨兵 |
| 链上锚点 | **不需要合约**：把根写进一笔 `value=0`、`gasPrice=0` 旧式交易的 `input`（`0x45564944` "EVID" + 32 字节根）。之所以成立用的是 B04 结论——零 gas 链上 0 值交易不需要账户有钱，所以签发密钥是专门新生成的一把，**不动运营方水龙头资金** |
| 签发 | 服务器 CLI `evidence-issue.js`。公网 `/b03-api/` 只读：给写入口等于请人拿你的签发身份出假证 |
| 签名 | ECDSA P-256/SHA-256，签**规范化字段子集**（`signedFields` 写在包里，客户看得见被签了什么） |
| 复核 | 8 项：结构 → Merkle 证明 → 披露数据与叶子一致 → 链上锚点存在 → 链上根==包内根 → 链上根==重算根 → 确认数达标 → 验签。`GET /api/v1/evidence/:id/verify` |

**实测（真实数据）**：给 B04 的三笔 Counter 部署交易出批 `b04_deployments_v2`，锚定交易 `0x39a22c2b…`（块 #2757），8 项复核全绿；**9 种篡改全部被拒**（改 subject.id / 改根 / 改披露 data / 改 proof 兄弟 / 换锚点交易哈希 / 降级算法到 v1 / 跨包嫁接 / 把确认要求降成 0 或 1）。

**开发中抓到的三个自身缺陷**（都已修，注释留在代码里）：

1. `commitment()` 返回 Buffer 却被 `unhex()` 走 `String(buffer)`，非法 UTF-8 变 U+FFFD 后按 hex 解析**整段丢弃** → 叶子只哈希位置、完全没哈希数据，`[a,b,c]` 与 `[b,a,c]` 同根。**12 项往返测试全绿也照不出来**，只有"重排批次必须改根"这条对抗断言抓到。教训：证明能自洽往返 ≠ 树是对的。
2. `anchor.confirmationsRequired` 一开始没进签名 → 实测改成 0 就能让刚入块、还在分叉风险里的交易"确认数达标"。现在既进签名，验证方又要传 `MIN_CONFIRMATIONS` 策略下限，取两者较大。**策略字段不能只信包内声明。**
3. 验证器先塞一条占位失败再塞真结果，导致有公钥时也显示一条 FAIL。**重复计数比漏计数更容易骗过看报告的人**；同理"没验"绝不能算"过了"。

## 运维：停链看门狗

`scripts/watchdog.js` + `b03-watchdog.{service,timer}`（每分钟），页面顶部有健康横幅。

存在的理由是一个具体教训：**只起 2/4 验证者时，四个节点 RPC 全部正常、peers 正常、进程都在，
唯独高度不动**（quorum=⌈2f+1⌉=3 未满足）。任何"进程在不在"式检查都会判它健康。所以看门狗
唯一的硬指标是"隔一段时间高度有没有涨"，且连续 3 次无增长才判停链（避开"刚好落在两块之间"）。
五项一起看：高度增长 / 拓扑(在线数·quorum·gasPrice 漂移) / 索引器 lag / 水龙头探链 / 状态文件新鲜度。
CRIT 退出码 2、WARN 1，**故意不吞退出码**——否则 `OnFailure` 永不触发。

实测：注入伪造停滞状态后 CRIT 正常触发，文案直接给出"全体同时重启"的修复命令；正常态显示
WARN「零容错运行」（在线 3 == quorum 3）。

### 上面这段只证明了检测，没证明告警

2026-11-10 处理一次真实停摆后，这一节此前的"已完成"判定被推翻，记在这里防止再被当成结论引用：

- 链实际**停摆 15 天 15 小时**（2026-10-26 00:32:10，块高 #98419），期间 watchdog 正确判出
  **20,833 轮 CRIT**、累计 62,507 行日志 —— 检测一次都没漏。
- 但 `watchdog.js` 的输出语句**只有 `console.log`**，没有任何投递代码（`grep -rnE "webhook|MAILTO|notify|
  telegram|dingtalk|slack|smtp"` 命中 0 条）。journald 和退出码都需要人主动去看，15 天里没人看。
- 更具体的一处：上面那句"故意不吞退出码——否则 `OnFailure` 永不触发"方向是对的，但
  `systemctl show b03-watchdog.service -p OnFailure` 实测 **`OnFailure=` 是空的**。
  退出码保留了下来，**它唯一预设的消费者从未接上**。设计意图和单位文件注释都写对了，
  落地的只有前半截 —— 这类"前半截合了、后半截没合"的缺口，只读 README 是看不出来的。
- 机器上 postfix/sendmail/mail 都装着，通道现成，只是代码里没写。

**所以「停链告警」在补上送达通道之前不算完成。** 判定细节、恢复过程，以及"复发条件此刻仍在累积"
（三个验证者各自 >50% 内存在 swap、邻居服务每天向 tmpfs 泄漏约 4,800 个目录）见
事故记录（属主仓库内容，未随本公开仓库发布）。

## 运维：钱包转账"两边都没变"的真相

用户报"六步流水线最后一步转完，收款方没收到、付款方也没扣"。实测结论是**链没错，界面在说谎**，
而且是三处叠加，只修一处下次还会收到同样的报障：

1. **界面结构上无法回答"对方收到了吗"**：只有一个钱包槽位，看对方余额就得导入对方私钥，
   而导入会覆盖掉自己；发完交易也只回读自己。→ 已加 **⑤ 双向对账**（同时给两侧增量与一致判定）
   和**观察地址**表（核对对方只需要地址，**不需要对方私钥**）。
2. **网关把成功说成失败**：水龙头是"广播后等入块才返回"的同步接口，而 `proxy_read_timeout` 只有 30s；
   实测一次领币被 504 掐断、约 40 秒后仍成功入块，界面只留下一句 `Unexpected token '<'`。
   → 超时改 150s，并且界面**不再把 HTTP 状态当结论**，改为回查链上余额。
3. **链当天三次停止出块**（内存耗尽 → QBFT round 风暴，进程都在、RPC 都通、高度不动），
   交易卡在池里，而原 `tx.wait()` 没有上限。→ 改为 150s 上限 + 链健康 + 用 `pending nonce` 判"是否仍在池中"。

**排障口诀**：`receipt` 为 null 且高度不涨，先怀疑链，别先怀疑钱包；
接口报失败时，**以链上余额为准**，别看界面文案。

另记一条实测副作用：**三台协同重启会把待处理交易从交易池清掉**
（B04 README 原先标为"未证明"的那条，本次抓到了：重启后 pending nonce 回落、receipt 始终为 null）。
恢复手册应加一句"重启全集群后提醒用户重新发起未确认的交易"。

可复跑断言：`scripts/verify-transfer-both-sides.js`（密钥只在内存，不打印不落盘）。
全案、7 项浏览器验收与截图见 WALLET-FIX 验收报告（属主仓库内容，未随本公开仓库发布）。

## 与 P03 的关系

**功能实现一致，环境语义不同。**P03 的全部知识点在本分支都要做一遍，本 README 只记录**差异与新增验收**；
共性差异见 [差异矩阵](../../shared/consortium-network/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。

| 维度 | P03（公链/anvil） | B03（联盟 QBFT） |
|------|------------------------|----------------------|
| 浏览器 | sepolia.etherscan.io | 内网 Blockscout 或自研解析页（P26/B 分支共同的离线交付常态） |
| 领水 | 公共 faucet（有额度与验证码） | 运营方 alloc 预存 或 零 gas 免余额（见 docs/02） |
| 最终性 | 约 2 epoch 才 finalized | 单块终结，但 n=4 挂 2 台会停链 |
| 失败模式 | gas 不足 / nonce 抢跑 | 新增：账户未授权、节点不在白名单、某节点 min-gas-price 漂移导致静默丢单 |

## 知识点

- [x] 自定义 chainId 与 RPC profile（不再用公共节点）
- [x] 无公网浏览器时如何解析交易：input selector、logs/topics、receipt、gasUsed
- [x] QBFT 确定性终结下的「确认数」语义（终结证明 vs N 个确认）—— 出证包里 `confirmationsRequired` 是**策略**，必须由验证方持有并参与签名，否则改成 0 就能蒙过
- [x] 内网可观测：Blockscout 在这台 1.9G 机器上不可行，改为**自研索引器**（RSS ≈76MB）+ 合约登记 + 指纹自证 + 出证 API
- [ ] 账户白名单导致的「交易被拒」新故障类别 —— 移交 B08（本链未启用 permissioning，启用要全链重启，当前零容错不宜冒险）
- [x] RPC 经反向代理后的鉴权与审计日志：ADMIN 已从公网白名单移除（实测 `-32604`）、upstream 容错、水龙头按 IP 限速、`/b03-rpc/` 与 `/b03-api/` 独立 access_log

## 技术栈

- Besu 26.9.0 QBFT 4 验证者（`shared/consortium-network`）
- cast/viem 脚本 + 自建解析页
- 内网 Blockscout（版本相关环境变量部署前核实）

## 环境准备

```bash
cd ../../shared/consortium-network
bash scripts/00-preflight.sh
bash scripts/20-up-docker.sh          # 单机 4 验证者验证；多机见 README §三
RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh
```

## 任务拆解

1. [ ] 复用 P03 的实现，切到联盟网 profile
2. [ ] 多成员账户与 nonce 管理
3. [ ] 零 gas 相关断言与负例
4. [ ] 权限（白名单/角色）正例与负例
5. [ ] 内网可观测（浏览器/日志/审计）
6. [ ] 文档与截图

## 验收

**分支共用四条增量**（B03–B08 一律适用）：

- [x] 多成员：≥2 个成员账户各自发交易，nonce 互不干扰 —— 2026-10-16 QA 复证：两个**全新、余额 0** 的账户各发 2 笔 `value=0`，落入同一批区块（#1782/#1783），nonce 各自 0→2
- [x] 零 gas：`eth_gasPrice == 0` 且 `baseFeePerGas == 0`，交易确实入账 —— 实测 `0x0` / `0x0`，receipt `status=0x1, gasUsed=0x5208, effectiveGasPrice=0x0`
- [x] 终结性：交易所在块在 3 个节点查询一致 —— 三节点同一交易返回体 **md5 完全相同**（`7feac080afe1`），链头 15 秒内三度同步（`0x6fe`→`0x701`）。「5 分钟后仍一致」这一条本轮未单独计时复测
- [ ] 权限负例：未授权账户/节点被拒且留下可审计记录 —— 本轮未测（B08 主题）。相邻证据：公网 RPC 已移除 ADMIN，`admin_nodeInfo` → `-32604 Method not enabled`

**本分支特有**：

- [ ] 3 个不同成员账户各发 5 笔交易，nonce 互不干扰 —— 本轮只复证 2 账户 × 2 笔；上轮记录的 3×5 未重跑
- [x] 每笔交易能在内网浏览器按 hash 查到并逐字段解释 —— 18 字段全解，含 selector / v-r-s 签名恢复 / 回执 / 终结性
- [x] 写清「本链无公网浏览器时客户如何自证」的替代方案 —— 解析页 + `?tx=` 深链 + §六 可复跑断言
- [x] README 可按步骤复现（含联盟网准备步骤）—— 已补 systemd 生产形态与停链恢复口诀
- [ ] 去代币化检查表通过（涉及对外交付时）

## 复盘

- 与 P03 相比最意外的差异：
- 联盟特有故障（静默丢单 / 授权遗漏 / 停链）遇到没有：三类都遇到了，且停链是唯一真实造成损失的 —— 15 天无人发现。
  静默丢单见 B04「卡池交易」实验，授权遗漏见 ADMIN 命名空间，停链全案见
  INCIDENT-2026-11-10（属主仓库内容，未随本公开仓库发布）。

- 对客交付时客户最关心的问题：
