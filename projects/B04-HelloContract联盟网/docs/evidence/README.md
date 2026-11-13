# B04 证据：卡单观测与替换处置

本目录存放「卡单」故障的**受控实验**证据。两组实验：

| 实验 | 时间 | 链 | 结论 |
|------|------|-----|------|
| A. 卡单 15 分钟观测（两阶段含重启对照） | 2026-10-23 | 服务器联盟链 | 卡单不自行消失；重启单节点仅临时清池，gossip 几分钟内回填 |
| B. 同 nonce 替换处置 | 2026-10-23 | 服务器联盟链 | 注入最小余额 + 同 nonce 更高价更省 gas 的空交易 → 原卡单被顶掉 |
| C. 本地一键复现（make → observe → replace） | 2026-11-13 | 本地联盟链（4 验证者） | 三个脚本首尾贯通，替换成立判定全绿 |

## 复现三步（本地联盟链，约 5 分钟）

```bash
cd projects/B04-HelloContract联盟网
npm install                                  # 只装 ethers（签名替换交易用）

# 1) 制造卡单：零余额账户发 legacy / gasPrice=1 / gas=505440 / value=0 的交易
node scripts/make-stuck-tx.js
#   → 打印 txHash；账户私钥仅写 docs/evidence/*key*.json（0600、gitignore，不打印、不入库）
#     可用 --key-out 指定新文件；已有文件拒绝覆盖。

# 2) 观测（只读）：多节点按间隔采样 in_pool / receipt / nonce 缺口
node scripts/observe-stuck-tx.js <txHash> --minutes 2 --interval 30
#   → docs/evidence/observe-<hash前10>-<ts>.jsonl

# 3) 处置：窗口校验 → 注入最小余额 → 同 nonce 替换 → 断言
node scripts/verify-stuck-tx-replacement.js <txHash> --inject 100000 --execute \
     --inject-key <有余额账户的私钥>          # 用 --dry-run 先看计划
```

## 本地实测记录（2026-11-13）

**观测**（`observe-0x8bfc38a2-*.jsonl`，3 节点 × 4 轮 / 30s）：

```
8551 head=28807→28825 in_pool=true receipt=null nonce=0/1 pending_blk=false   （链高照常推进）
8552/8553 同上——三节点同见卡单，"链没停、单没走"
```

**处置**（第一轮 0x8bfc…7494，第二轮 0xbb5c…2ee5）：

```
卡单成本 = 505440 × 1 = 505440 wei
替换成本 = 21000 × 2 = 42000 wei
注入额   = 100000 wei        ✓ 窗口校验通过（42000 ≤ 100000 < 505440）
替换交易 0xa2e1…3cd4：status=1 block=28844 gasUsed=21000
原卡单：已从池中消失 receipt=null        账户 nonce: 0 → 1
✓ 替换成立
```

## 处置台端到端实测（2026-11-13）

- `node scripts/12-console-smoke.js --port 8814`：最终 **36/36**。覆盖静态资源、三节点状态、造卡单、两类窗口拒绝、替换成功、无重启节点按钮、业务拒绝与 HTTP 异常分离、零 baseFee 及真实 gasPrice=0 注入交易。
- 独立浏览器实际操作：合法 100000 wei 注入后，最终截图对应替换交易 `0x771d14…25f7` 在块 **30507** `status=1`；原卡单无回执且出池，nonce **0→1**。截图：`console-browser-resolved.png`。
- 更早一次独立浏览器闭环也在块 30124 成功，说明不是单次偶然通过。
- 浏览器还验证了过量注入会显示“处置被拒”及具体原因，不再误报为 `HTTP 200` 异常。
- 页面展示节点 gasPrice 估计与 baseFee 两种口径：legacy 实验交易可使估计报价暂时为 2，但实际零 gas 注入交易仍入块；不能用估计值否定网络零 baseFee。

## 窗口公式（README 的 ⚠ 前提，脚本已内置校验）

```
替换成本 ≤ 注入额 < 卡单成本
```

- 注入额 **< 替换成本**：替换交易自己付不起手续费，白忙；
- 注入额 **≥ 卡单成本**：原卡单立刻变得可执行、直接在原 nonce 入块——"看起来解锁了"，
  实际测的是**原交易能不能执行**，与替换是否生效无关。按水龙头固定额度打 10 B03（1e19）就属于这种假阳性。

## 为什么不用 `txpool_content`

Besu 只有一个 HTTP RPC 端口且被 nginx 反代到公网，开 `txpool_*` API 等于把全链待处理交易
（地址/nonce/金额）暴露公网。三个等效信号足够：

1. `eth_getTransactionByHash` 非 null 且 `blockNumber == null`（在池、未入块）
2. `eth_getTransactionCount(pending) > eth_getTransactionCount(latest)`（该账户有悬单）
3. `eth_getBlockByNumber("pending")` 的交易列表里能看到它

## 服务器实验的原始结论（2026-10-23，脚本同源）

- 阶段 1（不重启，15 分钟 / 16 次采样）：`in_pool` 恒 true、receipt 恒 null、nonce 恒 `latest=0/pending=1`，
  同期链高 77825→77933 持续推进（排除"链停了的假象"）。
- 阶段 2（重启对照）：只重启 node-1 → 19 秒后 node-1 池中消失，8552/8553 仍在池；
  **4 分钟后复查 node-1 被 gossip 回填**，三节点再次同见。结论：**清池要重启全部持单节点**，
  "重启一台即可"是错误指引（早期推断被下游文档引用后走样，此处以对照实验为准）。
- 顺带复证零 gas 语义：注入 100000 − 替换成本 42000 = 58000，与账户最终余额吻合——
  **手续费不花钱、本金照扣**。
