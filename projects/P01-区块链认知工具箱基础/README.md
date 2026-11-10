# P01 · 区块链认知工具箱（基础）

> 状态：**脚手架就绪，可运行** ｜ 里程碑：M1·W1 ｜ 层级：基础 ｜ 依赖：无 ｜ 更新：2026-10-13
> 一句话：用一个零依赖网页 + 5 个命令行演示，把「区块链为什么可信」拆成能亲手验证的四件事：哈希、哈希链、Merkle、签名与共识成本。

## 运行（不需要 npm install）

```bash
# 1) 网页版（推荐，交互最强）
node tools/serve.mjs            # 在仓库根目录执行
# 打开 http://127.0.0.1:8787/projects/P01-区块链认知工具箱基础/frontend/

# 2) 命令行版（无浏览器也能复现，可直接进 CI）
cd projects/P01-区块链认知工具箱基础
node demos/avalanche.mjs
node demos/hash-chain.mjs
node demos/merkle-proof.mjs
node demos/device-signature.mjs
node demos/pow-mining.mjs

# 3) 单测（19 项，全部通过）
node --test "test/*.test.mjs"
```

> 为什么必须用 `serve.mjs` 而不是双击 `index.html`：`crypto.subtle` 只在安全上下文可用，`http://127.0.0.1` 属于可信来源，`file://` 在部分浏览器会禁用 Web Crypto。

## 目录

```text
P01-区块链认知工具箱基础/
├── README.md
├── package.json            # type=module，让同一份 lib 在浏览器与 Node 通用
├── frontend/
│   ├── index.html · styles.css · app.js（哈希路由，无框架）
│   ├── lib/  crypto.js · hashchain.js · merkle.js · sign.js · pow.js · ui.js
│   └── views/ overview.js · hash.js · chain.js · merkle.js · signature.js · pow.js
├── demos/                  # 5 个 Node CLI 演示，异常即 exit 1
├── test/                   # node:test 单测（哈希向量/雪崩/链审计/Merkle/签名/PoW）
├── docs/                   # 5 篇原理短文（W1 交付物）
└── screenshots/            # 验收截图
```

设计取舍：**同一份 `lib/*.js` 同时被浏览器与 Node 使用**，网页演示与命令行复现不会出现两套实现。

## 知识点（对应 知识点思维导图.md §2）

- [x] Hash 算法：定长 / 单向 / 雪崩（实测均值 130.0/256 比特翻转）
- [x] 哈希链与篡改检测：自洽 + 链接两处独立检查
- [x] 外部锚点：整段重算能骗过本地校验，骗不过锚点（本项目的核心洞察）
- [x] Merkle 树：对数长度证明、批量出证、复制末尾叶子的等价树弱点
- [x] 非对称加密与椭圆曲线：ECDSA 签名/验签、65 字节非压缩公钥、地址派生
- [x] 对称加密与 AEAD：AES-256-GCM 篡改即拒绝
- [x] 防重放：签名域含 chainId/合约地址 + 序号单调
- [x] 共识成本：难度 +1 → 尝试 ×16；挖矿贵、复验便宜
- [ ] P2P 网络与分布式账本（放到 P02 MiniChain 实现）
- [ ] Why：与中心化系统的对照（`docs/01-什么是区块链-一页纸.md` 已有讲稿，待现场讲一次后修订）

## 技术栈

- 前端：原生 ES Module + 手写哈希路由（无框架、无构建）——刻意保持「打开即懂」，把框架留给 P06 的 React/Wagmi。
- 密码学：浏览器/Node 内置 Web Crypto（SHA-256、AES-256-GCM、ECDSA P-256）。
- 测试：`node:test` + `node:assert/strict`。
- 后端/合约：本项目无（P02 起）。

## 任务拆解

1. [x] 脚手架与目录
2. [x] 5 个 Demo 的核心逻辑（lib）
3. [x] 单测 19 项（含把「等价树」「整段重算」两个坑固化为断言）
4. [x] 前端页面与交互
5. [x] 命令行演示（可进 CI）
6. [x] 5 篇原理短文初稿
7. [ ] 截图补齐（已有 5 张，缺 overview 与讲解动图）
8. [ ] 现场讲一次并修订（W1 验收：能讲 what/How/Why）

## 验收（对齐开发计划 §五 质量门禁）

- [x] 功能路径可演示：5 个 Demo 全部在浏览器实测通过（见 `screenshots/`）
- [x] 测试通过：`node --test "test/*.test.mjs"` → 19 passed / 0 failed
- [x] README 可按步骤复现（他人 30 分钟内跑起来，零依赖）
- [x] 仓库零私钥（演示密钥全部内存生成，不落盘）
- [x] 去代币化检查：本项目不含任何代币/交易功能
- [ ] `forge fmt`/solhint：不适用（无合约）

### 实测记录（2026-10-13，浏览器 + Node）

| 检查 | 结果 |
|------|------|
| 雪崩效应 | 59 处单位改动，平均 130.0、最小 115、最大 161 比特翻转 |
| 3 位前缀碰撞 | 88 次尝试命中（生日界 ≈ 1.2×16^1.5≈47，量级一致） |
| 只改数据不重算 | 本地审计 `valid=false brokenAt=1` |
| 改完整段重算 | 本地审计**通过**，外部锚点**不一致**（核心教学点） |
| Merkle 13 份 | 树形 `13→7→4→2→1`，证明 4 层；伪造后复算根 ≠ 链上根 |
| 等价树弱点 | `["A","B","C"]` 与 `["A","B","C","C"]` 同根（已固化为单测） |
| 签名四检查 | 正常通过 / 篡改失败 / 冒名失败 / 跨链重放失败 |
| 网关防重放 | `42入账 → 42丢弃 → 43入账 → 回退丢弃` |
| PoW 难度 1→4 | 尝试 9 / 266 / 4083 / 20290，复验一次哈希通过 |

## lainchain 对照精读（本阶段 1 篇）

- [ ] `docs/S1-区块链基础/lainchain对照-CPHSRegistry.md`：读 `lainchain-defi/hardhat/contracts/identity/CPHSRegistry.sol`（285 行），对照本项目 Merkle/哈希部分，记录它的存证结构与差异。

## 复盘

- 卡住的点：
  - Node 的 `node --test <dir>` 在本机把目录当入口脚本执行（`MODULE_NOT_FOUND`），改用 glob `"test/*.test.mjs"` 才通过。
  - `??` 与 `||` 混用是语法错误（`seq ?? Number(x) || 1`），必须加括号——浏览器页面白屏才暴露出来，说明「页面也要有验收步骤」。
- 与 Java/传统后端的对照：哈希链 ≈ 只追加的审计日志（append-only + 前序校验），但缺少「外部锚点」时它和普通的 `oldValue/newValue` 日志一样可被内部人重写；这一点传统后端从来不需要面对。
- 下次可压缩的时间：DOM 助手（`ui.js`）与哈希路由一次写对，可沉淀进 `shared/frontend-lib/`。
