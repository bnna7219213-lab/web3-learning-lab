# 02 · MetaMask 真实扩展验收（2026-11-12）

> 被测对象：`projects/P06-投票DApp基础/frontend`（Vite + React18 + wagmi2 + viem2）
> 真实钱包：**MetaMask 扩展 v13.x**（Edge 157 + `--load-extension` 解包加载 + CDP 原始协议驱动）
> 链：anvil `127.0.0.1:8545`，chainId 31337；合约 `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`，owner = MetaMask 账户
> 结论：**通过**（连接 / 建提案 / 投票全链路，真实扩展签名，两次独立复现 + 链上 `cast` 独立核验）

---

## 1. 验收环境与打法

| 项 | 取值 |
|----|------|
| 浏览器 | Edge 157（`msedge.exe`），`--load-extension=C:\Users\bnna7\tools\metamask-extension` |
| profile | `C:\Users\bnna7\tools\mm-edge-r1`（本地自动化 profile：已导入 anvil 默认测试助记词——公开测试材料、零真实资产；解锁口令属本机工具目录配置，不入库） |
| 调试端口 | `--remote-debugging-port=9360`（9340/9350 等为历史遗留） |
| DApp | `http://127.0.0.1:5173/`（vite dev） |
| 驱动方式 | `playwright-core` 只负责**启动** Edge；**扩展页与确认弹窗一律用原始 CDP**（`Target.getTargets` / `Runtime.evaluate` / `Input.insertText` / `Page.captureScreenshot`） |

**为什么不用 Playwright 的 page API 驱动扩展页**：`chrome-extension://` 的页面属于浏览器扩展的独立 target，
Playwright 既不暴露、也禁止从外部 `page.goto` 进入（Chrome 报 `ERR_BLOCKED_BY_CLIENT`）。
用浏览器级 CDP 拿 target 列表 + attach + `Runtime.evaluate` 就能全程驱动。

**Edge 与 Chrome 的取舍**：Chrome 137+ 已弱化 `--load-extension`（解包扩展默认不加载，
`chrome.developerPrivate.loadUnpacked` 也去掉了 `path` 参数，只能弹文件框，无法自动化），
**Edge 仍支持命令行加载解包扩展**，所以本轮用 Edge。
注意 Edge 里的 `ERR_BLOCKED_BY_CLIENT` 只发生在「从外部 goto 扩展页」时，**不代表扩展被禁用**——
用 CDP `Page.navigate` 打开扩展页一切正常。

---

## 2. 三个真根因（都是先前的误判，逐个证伪）

### 根因 A：站点授权是**按链作用域**的 —— 这才是 4100 的真凶

现象：`eth_sendTransaction` 秒失败，`code=4100`
`The requested account and/or method has not been authorized by the user.`，且**不弹任何确认窗**。

曾先后误判为「MetaMask 处于 `#/unlock` 锁定态」「MV3 service worker 重启导致解锁态丢失」「授权态漂移」。
逐条证伪：

| 假设 | 证伪方式 | 结果 |
|------|----------|------|
| 钱包锁着 | 解锁后 UI 显示 `Admin 0xf39Fd…92266` | 排除 |
| 页面 provider 状态陈旧 | 解锁后 reload DApp 页再发交易 | 仍然 4100 |
| 请求没到扩展 | 挂 service worker target 抓后台 console | 后台明确打出 `RPC (http://127.0.0.1:5173): eth_sendTransaction -> error`，**请求到了，是后台拒的** |
| 权限不足 | 检索扩展源码：错误串是 EIP-1193 `4100 = unauthorized` 标准文案；连接页 UI 组件带 `requestedChainIds` 字段 | **账户批准按链作用域** → 对上 |

修法（已在脚本里固化）：

1. `wallet_switchEthereumChain` 先切到 **31337**；
2. `wallet_revokePermissions({eth_accounts:{}})` 撤销**上一轮在 chain 1 上留下的**授权；
3. `eth_requestAccounts` → 弹出连接授权窗 → 批准 → 此时批准落在 **31337** 上；
4. 之后 `eth_sendTransaction` 立刻放行（错误从 4100 变为可弹出确认窗）。

> 关键证据：修完后错误码从 `4100 unauthorized` 变成 `-32602 Invalid params`——那是我探针自己
> 少传 `from`（账户还没授权完）造成的，与权限无关。

### 根因 B：确认框在 `notification.html`，且**裸 URL 阶段渲染的是钱包主页**

MetaMask 13.x 的审批弹窗是独立窗口 `notification.html`，URL 形如：

- 连接授权：`notification.html#/connect/<requestId>` → 按钮 `连接`（`data-testid=confirm-btn`）
- 交易确认：`notification.html#/transaction/<txId>` → 按钮 `确认`（`data-testid=confirm-footer-button`），
  取消按钮是 `confirm-footer-cancel-button`

**陷阱**：`notification.html`（URL 还没带路由）的瞬间，窗口里渲染的是**钱包主页**，
按钮是 `买入 / 兑换 / 发送 / 收款`。按文案子串匹配去点会点到「发送」，
于是授权请求永远 pending（表现为「点了连接、账户一直为空」）。

因此匹配规则必须同时满足：

1. target URL **带路由**（`notification.html#/...`、`sidepanel.html#/...`、`popup.html#/...`），
   排除裸 `notification.html`；
2. 按钮按 **testid 优先**（`confirm-btn` / `confirm-footer-button` / `page-container-footer-button` /
   `txn-button` / `approve-button`），文案只做**精确相等**匹配（`连接`/`确认`/`批准`/`签名`/`Confirm`…），
   绝不用子串（子串会误伤钱包主页按钮）；
3. **点击必须与匹配原子化**：弹窗仍在渲染时按钮列表会变，用旧下标点会返回 `gone`。
   正确写法是在同一次 `Runtime.evaluate` 里按 testid/文案重新查找并 `.click()`。

### 根因 C：前端取值与元素假设（不是钱包问题，但会让脚本误判）

| 现象 | 真因 | 处理 |
|------|------|------|
| React 受控输入框「填了没反应」，按钮恒 disabled | `Object.getOwnPropertyDescriptor` 赋值绕过 React state | CDP `Input.insertText`（真实键盘事件）；不生效再退回「原生 setter + `dispatchEvent(new Event('input'))`」 |
| 提案计数一直读成 `?` | DApp 用的是**全角括号** `提案（3）` | 正则改为 `/提案[（(]\s*(\d+)/` |
| `RESULT: no-main` | DApp 根节点是 `div.wrap`，**没有 `<main>`** | 改读 `document.body.innerText` |
| 表单填了又被清空 | 连接态变化会重挂载 CreateForm | 每次尝试前重填表单 |
| `eth_sendTransaction` 报 `Invalid params` | 探针少传 `from`（账户未授权完） | 先 `waitAccounts` 再发 |
| MetaMask 不支持 `eth_maxPriorityFeePerGas` | viem 的 EIP-1559 费用估算会自动回退到 `gasPrice - baseFeePerGas` | **不阻塞**，无需处理 |

---

## 3. 验收结果（两轮独立复现）

| 环节 | 第 1 轮 | 第 2 轮 |
|------|---------|---------|
| 扩展加载 + 解锁 | ✅ `Admin 0xf39Fd…2266` | ✅ 同 |
| 连接 DApp | ✅ `eth_requestAccounts` → 授权窗批准 | ✅ |
| 目标链 | ✅ chain 31337，无网络不匹配横幅 | ✅ |
| 裸交易探针（独立验证签名链路） | ✅ tx `0x89263ead…` 上链 | ✅ tx `0x457332df…` 上链 |
| 创建提案 | ✅ tx `0x811730c7…` 入块 #42 status=1，提案 2→3 | ✅ tx `0xa27ab77e…` 入块 #45 status=1，提案 3→4 |
| 投票 | ✅ tx `0x6bc01067…` 入块 #43 status=1，赞成 1/反对 0 | ✅ tx `0x57df78b8…` 入块 #46 status=1 |
| 事件流 | ✅ `Voted {id:2, voter:0xf39Fd…, support:true}` 实时出现 | ✅ `Voted {id:3, …}` |
| UI 状态 | ✅ 「（你已投票）」+ 截止 2126/10/19（876000h 窗口） | ✅ |

### 链上独立取证（`cast`，不经过 DApp UI）

```text
$ cast call 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 "proposalCount()(uint256)" --rpc-url http://127.0.0.1:8545
3
$ cast call 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 "tally(uint256)((uint256,uint256))" 2 --rpc-url http://127.0.0.1:8545
(1, 0)
$ cast call 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 "hasVoted(uint256,address)(bool)" 2 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545
true
$ cast call 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 "owner()(address)" --rpc-url http://127.0.0.1:8545
0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

`owner` 与 MetaMask 账户一致 → 该账户确实有建提案权限（不是靠演示钱包 shim 代签）。

### 证据截图（`projects/P06-投票DApp基础/screenshots/`）

| 文件 | 内容 |
|------|------|
| `02-MetaMask连接授权弹窗.png` | MetaMask 连接授权窗（`notification.html#/connect/<id>`，按钮 `连接`） |
| `03-MetaMask交易确认弹窗.png` | MetaMask「交易请求」窗：网络 Anvil、来源 `HTTP 127.0.0.1:5173`、交互合约 `0x2279B…2eBe6`、费用 US$0.17、按钮 `取消/确认` |
| `04-MetaMask建提案回执.png` | DApp：`tx 0x811730c775bf… 入块 #42 status=1` + `提案（3）` |
| `05-MetaMask投票结果与事件流.png` | 提案 #2/#3 卡片：`赞成 1 · 反对 0 （你已投票）` |

---

## 4. 产物与复用

| 产物 | 路径 |
|------|------|
| 主验收脚本（端到端：解锁→授权→切链→创建→投票→取证） | `C:\Users\bnna7\tools\mm-accept\mm-tx3.js` |
| 诊断脚本（逐个 RPC 探测 + DApp console 抓取） | `C:\Users\bnna7\tools\mm-accept\mm-diag3.js` |
| 源码检索工具（压缩产物字符级上下文提取） | `C:\Users\bnna7\tools\mm-accept\mm-grep2.js` |
| 日志 / 截图 | `C:\Users\bnna7\tools\mm-accept\mm-tx3.log`、`mm3-*.png` |

脚本里已固化的踩坑修复（后续 P07 等项目可直接复用）：

1. `launchPersistentContext` 必须带 `ignoreDefaultArgs:["--disable-extensions"]`，否则压过 `--load-extension`；
2. 全程**不调用 `context.close()`**（会杀掉整个浏览器），结束时 `process.exit`；
3. 扩展页/弹窗一律走**原始 CDP**，不用 Playwright `page.goto`；
4. 弹窗匹配 = **带路由的 notification/sidepanel/popup target** + **testid 优先** + **文案精确匹配** + **原子化点击**；
5. 写操作前 `waitAccounts`，别拿空 `accounts` 去发交易；
6. React 受控表单用真实键盘事件填，必要时叠加原生 setter 兜底；
7. 挂 service worker target 抓后台 console，是定位「请求有没有到扩展」的最快手段。

---

## 5. 复盘

- **真正的卡点从来不是「自动化浏览器装不上扩展」**，而是**钱包的授权语义**：账户批准按链作用域、
  批准动作发生在独立的弹窗窗口里、弹窗在渲染初期会伪装成钱包主页。
  这三条叠加时，症状统一表现为「点了连接/创建，什么都没发生」，极易被误判成脚本 bug 或浏览器限制。
- **把「请求有没有到达扩展」这一层先钉死，再谈业务逻辑**，能省掉大量猜测：
  挂 service worker 抓 console 一行 `RPC (origin): eth_sendTransaction -> error` 就把范围砍掉一半。
- 弹窗类 UI 自动化，**匹配与点击必须原子化**；用「上一步的下标」点下一步的按钮，是这类脚本最隐蔽的失败源。
- 前端断言要贴着真实 DOM 写：全角括号、没有 `<main>`、受控输入框——**脚本读到的和用户看到的是两回事**。

