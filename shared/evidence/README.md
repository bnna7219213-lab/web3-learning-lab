# shared/evidence · 出证核心（M4 企业可信档案）

给"某件事发生过"生成一份**第三方可独立复核**的证据包。不是"我们内部系统记录过"，
而是"任何人拿公钥 + 一个 RPC 地址就能重算并确认"。

## 组成

| 文件 | 职责 |
|------|------|
| `lib/merkle-indexed.js` | v2 索引化 Merkle 树（`variant: v2-indexed`） |
| `lib/sign.js` | ECDSA P-256/SHA-256 对**规范化字段子集**签名 |
| `lib/verify.js` | 完整复核：结构 → 证明 → 披露一致 → 链上锚点 → 签名 → 有效期 → 作废 |
| `schema/evidence-package.schema.json` | 包格式（JSON Schema 2020-12） |
| `test/merkle-indexed.test.js` | 12 项性质测试，含对抗性断言 |

零依赖：只用 `node:crypto`。出证是要交给客户跑的，多一个 npm 依赖就多一个他们装不出来的理由。

跑测试：`node --test`（在本网关目录下自动发现；**注意 `node --test test/` 这种传目录的写法在 Windows 上会失败**，用 `node --test` 或 `node --test "test/*.test.js"`）。

## 为什么是 v2 而不是 v1

v1 用"奇数叶子就复制最后一个"补齐。P01 的实验证明这会让**不同规模的批次算出等价的树**——
拿到 `[A,B,C,C]` 证明的人可以声称那是 4 条记录的批次。出证场景里这等于"一张证明冒充另一批数据"。

v2 两处改动：叶子和内部节点都绑定**位置**（index / level+index）；奇数右侧补固定 EMPTY 哨兵。

## 三条踩过才知道的教训

1. **"证明能自洽往返"不等于树是对的。** 早期版本里 `commitment()` 返回 Buffer，`leafAt()` 又对它调
   `unhex()`，而 `unhex` 走 `String(buffer)` —— 非法 UTF-8 序列全变 U+FFFD，再按 hex 解析时
   **整段被丢掉**。结果叶子只哈希了位置、完全没哈希数据，`[a,b,c]` 与 `[b,a,c]` 同根。
   往返测试照样全绿，只有"重排批次必须改根"这条对抗性断言抓得到。
2. **策略字段必须参与签名，或由验证方持有。** `anchor.confirmationsRequired` 一开始没进签名，
   实测把它改成 0 就能让刚入块、还在分叉风险里的交易"确认数达标"。现在它既进签名，
   验证方又要传 `minConfirmations` 策略下限，两者取大。
3. **"没验"不能算"过了"。** 没公钥时验证器必须明确判失败。同理，验证器里不要先塞一条占位失败
   再塞真结果——那会让有公钥时也显示一条 FAIL，重复计数比漏计数更容易骗过看报告的人。

## 签名对象

签的是 `issuer.signedFields` 列出的字段子集（按字段名字典序规范化），不是整包：
`signature` 自己不能进签名；`status`/`void` 这类会随时间变的字段也不该进，否则作废操作会
让自己刚签的签名失效。哪些字段被签，包里写明了，客户看得见。

## 与链的耦合方式

`verify.js` 不认识任何具体链——链上部分通过注入的 `fetchAnchor(anchor)` 回调完成。
具体适配器见 `projects/B03-…/indexer/evidence.js`（联盟链：把根写进一笔零 gas、value=0
交易的 input 里，不需要部署合约；签发走服务器上的 CLI，公网 API 只读）。
