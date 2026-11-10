# 阶段 2 原始记录：重启单节点 vs 同期对照

实验时间：2026-10-23 17:15 UTC（B03 联盟网 chainId 19880601）
目标交易：`0x8577916172337ec8fbecabc58a8b6ce85fe09d86f6329a4eef4d0aeb15d90349`
发送账户：`0x4C0535E075f97EB45d0460E45c9cA59C333A9a8C`（legacy / `gasPrice=1` / `value=0` / `gas=505440`，余额 0）
执行方式：SSH 到服务器，全部走 `127.0.0.1:855x`，不经公网 RPC。

## 为什么要有对照组

阶段 1 只证明了"不重启时它在池里"。要证明"重启导致消失"，必须排除：
交易在重启前就已被节点按 TTL/池上限丢弃、或被同 nonce 后续交易替换。
只重启一台、另外两台不碰，就得到**同一时刻的唯一自变量**。

## 重启前基线（三节点都在池，对照成立）

```
8551  height=0x130be  tx:"blockNumber":null  nonce latest=0x0 pending=0x1
8552  height=0x130be  tx:"blockNumber":null  nonce latest=0x0 pending=0x1
8553  height=0x130be  tx:"blockNumber":null  nonce latest=0x0 pending=0x1
```

## 重启 node-1（17:15:33 → RPC 恢复 17:15:52，19 秒）

```
8551  （已重启）      tx 查不到                     pending_nonce=0x0
8552  （未重启）      "blockNumber":null            pending_nonce=0x1
8553  （未重启）      "blockNumber":null            pending_nonce=0x1
```

→ **"重启会清本节点交易池"证实**：同一笔交易，重启过的那台没了，没重启的两台还在。

## 重启后约 4 分钟复查（关键的第二半）

```
8551 tx_seen=1 pending_nonce=0x1     ← 被邻居 gossip 重新填回
8552 tx_seen=1 pending_nonce=0x1
8553 tx_seen=1 pending_nonce=0x1
```

→ **重启单节点只是临时清池**。gossip 在几分钟内把交易回填，所以"重启一台清理卡单"
是无效运维动作；要真正清掉必须重启所有仍持有它的节点（整个集群）。

## 链与周边影响

```
重启期间：height 0x130c7 → 0x130c8（短暂变慢，随后自行恢复，未触发协同重启）
4 分钟后：height=0x130eb，看门狗 crit=0 warn=1（warn 为既知的"零容错运行"，非本次引入）
生产单元：nginx / mysqld / b03-faucet / b03-indexer 全程 active，未受影响
```

## 对既有说法的更正

10-19 曾观察到"那笔交易消失了"，当时归因为"重启节点清出了交易池"。方向对、强度错：
那天**所有**节点都被重启过，没有邻居能回填，才显得是"清掉了"。只重启一台会被 gossip 复原。

教训：只做"重启前后各查一次"会得出**错误**运维指引。同期对照组 + 延时复查才把
"清掉"和"回填"区分开。
