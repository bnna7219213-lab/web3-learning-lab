# 02 · MetaMask 真实扩展验收（2026-11-12）

> 被测对象：`projects/P07-NFT市场进阶/frontend`（Vite + React18 + wagmi2 + viem2）
> 真实钱包：**MetaMask 扩展 v13.x**（Edge 157 + `--load-extension` 解包加载 + 原始 CDP 驱动真实审批窗）
> 链：anvil `127.0.0.1:8545`，chainId 31337；NFT `0x9A67…7508` · Editions `0x0B30…7016` · Market `0x9599…07B1`
> 账户：Admin `0xf39Fd…2266`（owner / 卖家）、Huilerie `0x3C44C…93BC`（买家 / 签名方）
> 结论：**通过**（铸造→挂单→跨账户购买→4907 租期→EIP-712 签名→fillOrder 成交，全链路真实扩展签名）

---

## 1. 环境与打法

沿用 P06 已验证的「Edge + `--load-extension` + 原始 CDP」打法（详见 `P06/docs/02-MetaMask真实扩展验收.md`）：

| 项 | 取值 |
|----|------|
| 浏览器 | Edge 157，`--load-extension=C:\Users\bnna7\tools\metamask-extension` |
| profile | `C:\Users\bnna7\tools\mm-edge-r1`（已导入 anvil 默认测试助记词；解锁口令属本机工具目录配置，不入库） |
| DApp | `http://127.0.0.1:5174/`（vite dev） |
| IPFS | kubo 0.43.1，API 5001 / 网关 8088（`--offline`） |
| 脚本 | `C:\Users\bnna7\tools\mm-accept\mm-p07.js`（端到端）+ `mm-probe2/3/4.js`（定向探针） |

**为什么不能用演示钱包代跑**：P07 的 E2E 已用演示钱包（anvil 代签）覆盖过；本轮要验的是
**真实扩展的签名能力**——MetaMask 内的私钥签名、审批窗交互、EIP-712 签名请求。

---

## 2. 本轮新踩到的六个坑（全部与 P06 不重叠）

### 坑 1：MetaMask 的「选中账户」与「站点被授权账户」是两回事

切账户只改了扩展的选中账户，但站点 `eth_accounts` 仍返回旧账户——**站点权限是独立的**。
症状：脚本以为切好了，实际上后续交易仍由旧账户发起（或者根本没发）。

正确顺序：**切扩展选中账户 → `wallet_revokePermissions` → `eth_requestAccounts` → 批准授权窗**，
批准时授权落在「当前选中账户」上。

### 坑 2：重新授权后必须 reload DApp 页

revoke 之前页面里的 provider 实例是旧授权态。重新授权后若不 reload，
viem 的 `sendTransaction` 会卡在 `getAccount`（`eth_accounts`）上，**交易永远发不出去**——
表现为 `eth_chainId` 成功后无下文，且**没有任何弹窗**。

定位手法（页面侧钩子，记录每个 RPC 的进出会话）：

```js
// 在页面里包一层 provider.request，记录 → 与 ✓/✗
window.__reqlog = [];
const p = window.ethereum, orig = p.request.bind(p);
p.request = (a) => { window.__reqlog.push('→ ' + a.method);
  return orig(a).then(r => (window.__reqlog.push('  ✓ ' + a.method), r)); };
```

### 坑 3：账户行的可点元素是「账户名标签」，不是地址

MetaMask 13.x 账户列表里，每行结构为

```html
<div id="multichain-account-cell-entropy:<entropy>/<idx>">
  … <p data-testid="multichain-account-cell-name-Huilerie">Huilerie</p>
  … <div id="multichain-account-cell-hovered-addresses">0x3C44C…293BC</div>
</div>
```

点地址 `<p>` / 点单元格 / 点地址芯片 **都不会切账户**（芯片是「地址菜单」入口），
只有点 **账户名标签**（`data-testid^=multichain-account-cell-name-`）才会切。
地址在 DOM 里是截断的（`0x3C44C…293BC`），匹配要用前 6 位前缀。

### 坑 4：React 受控输入框的 setter 要沿原型链取

`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` 在本页会抛
**`Illegal invocation`**（元素原型不匹配）。正确做法是沿元素原型链找 `value` 的 setter：

```js
var p = Object.getPrototypeOf(e), desc = null;
while (p && !desc) { desc = Object.getOwnPropertyDescriptor(p, 'value'); p = Object.getPrototypeOf(p); }
desc.set.call(e, value);            // 再 dispatchEvent(new Event('input', {bubbles:true}))
```

另：**同一页有多个同类输入框时必须指定索引**（画廊里每张卡片都有 `size=8` 的挂单价输入框），
否则会填到别的卡片上——这曾导致「挂单挂错 token」。

### 坑 5：签名状态在 React 里，revoke 断连会把它冲掉

DApp 的「签名卖单」面板把 `order`/`sig` 放在组件 state。跨账户成交必须先 revoke → 站点断连 →
面板重挂载 → **签名与订单一起丢失**，`以当前账户成交该卖单` 按钮直接消失。

本轮的处理：**用钩子把 `eth_signTypedData_v4` 的入参与结果捕获到脚本侧**，
撤销后用捕获的签名**直接发 `fillOrder` 交易**（仍走 MetaMask 的真实交易审批窗），
链上结果与「面板点击」等价。

### 坑 6：手写 ABI 编码要跟 `cast calldata` 对齐

`fillOrder((address,address,uint256,uint256,uint256,uint256,uint256),bytes)` 的编码有两处易错：
- 数值是**十进制字符串**入参，要 `BigInt(v).toString(16)` 再左补零（当字符串补会得到错误值）；
- 外层 head = 7 个元组字 + **1 个偏移字**，因此 bytes 的偏移是 `8*32 = 0x100`（不是 0xe0）。

已用 `cast calldata` 交叉验证字节级一致后才允许上链。

---

## 3. 验收结果

| 环节 | 结果 | 链上/日志证据 |
|------|------|--------------|
| 连接授权 | ✅ | 授权窗 `notification.html#/connect/<id>` → `连接[confirm-btn]` → `eth_requestAccounts -> success` |
| 目标链 | ✅ | `chain 31337`，无网络不匹配横幅 |
| 铸造 721（含 IPFS 自动 pin） | ✅ | `nextId` 递增；`tokenURI = ipfs://…`；`铸造 721` → 交易弹窗批准 |
| 挂单（自动补 `setApprovalForAll` → 托管 `list`） | ✅ | `listingCount` 递增；两笔交易各自审批 |
| 切账户 + 重新授权 + reload 重连 | ✅ | 扩展选中账户 `Huilerie`；站点 `eth_accounts` 变为 `0x3C44C…93BC` |
| 跨账户购买 | ✅ | 买家 ACC2 支付 0.5 ETH；`ownerOf(token)` 变为 `0x3C44C…93BC` |
| EIP-4907 租期 | ✅ | `userOf(token) = 0xf39Fd…2266`，`userExpires > now` |
| EIP-712 签名卖单 | ✅ | 签名窗 `notification.html#/signature-request` → `确认[confirm-footer-button]` → `eth_signTypedData_v4 -> success` |
| fillOrder 成交 | ✅ | 用捕获的签名发 `fillOrder` → 交易弹窗批准 → `ownerOf(token#0) = 0xf39Fd…2266` |

链上独立取证（`cast`，不经过 DApp UI）：

```text
$ cast call <market> "listingCount()(uint256)" --rpc-url http://127.0.0.1:8545
$ cast call <nft> "ownerOf(uint256)(address)" <id> --rpc-url http://127.0.0.1:8545
$ cast call <nft> "userOf(uint256)(address)"  <id> --rpc-url http://127.0.0.1:8545
$ cast call <market> "tally(uint256)((uint256,uint256))" <id> --rpc-url http://127.0.0.1:8545
```

### 证据截图

| 文件 | 内容 |
|------|------|
| `02-MetaMask连接授权窗.png` | 连接授权窗（`连接[confirm-btn]`） |
| `03-MetaMask交易确认窗-铸造.png` | 铸造交易确认窗（网络 Anvil / 来源 `HTTP 127.0.0.1:5174` / 交互合约 `0x9A67…7508`） |
| `04-MetaMask交易确认窗-挂单.png` | 挂单（托管）交易确认窗 |
| `05-MetaMask购买成交.png` | 跨账户购买后的 DApp 状态 |
| `06-MetaMask租期4907.png` | 设置租期（4907）后的卡片状态 |
| `07-MetaMask签名请求窗.png` | EIP-712 签名请求窗（`确认[confirm-footer-button]`） |

---

## 4. 可复用清单（给 P08+ 直接照搬）

1. `launchPersistentContext` 必须 `ignoreDefaultArgs:["--disable-extensions"]`，否则压过 `--load-extension`；
2. 全程不 `context.close()`，结束 `process.exit`；
3. 扩展页与审批窗一律**原始 CDP**：`Target.getTargets` → attach(flatten) → `Runtime.evaluate`；
4. 审批窗匹配 = **带路由的 `notification.html#/`** + **testid 优先** + **文案精确相等** + **匹配与点击原子化**；
5. 切账户三步：切扩展选中账户（点账户名标签）→ revoke → `eth_requestAccounts` 批准；
6. **任何 revoke/re-authorize 之后都要 reload DApp 页**，否则 viem 卡在 `getAccount`；
7. React 受控输入：沿原型链取 setter + `input` 事件；**多输入框必须指定索引**；
8. 页面侧包一层 `provider.request` 记录 RPC 轨迹 —— 卡点定位最快的手段；
9. 跨账户的链上状态（订单/签名）不要依赖 React state，捕获到脚本侧再用；
10. 手写 ABI 编码必须与 `cast calldata` 字节级比对后再上链。

## 5. 复盘

- **扩展自动化的难点不在浏览器，而在钱包的语义层**：权限（站点被授权账户）≠ 选中账户（扩展当前账户）、
  弹窗形态（通知窗 vs 侧栏 vs 主页）、授权作用域（按链）——这三条叠加时症状高度相似（都是「点了没反应」）。
- **把「请求有没有到扩展」钉死**是最高性价比的排查动作：挂 service worker 抓 console，
  一行 `RPC (origin): eth_sendTransaction -> error/success` 就能把范围砍掉一半。
- 交易类 DApp 的验收脚本必须显式区分「哪些状态在链上、哪些在页面里」：
  跨账户场景下页面 state 会随 revoke 丢失，**链上事实才是断言基准**。
