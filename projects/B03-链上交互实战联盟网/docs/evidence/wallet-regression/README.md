# B03 钱包完整浏览器回归（2026-11-13）

> 环境：Besu QBFT 4 验证者，chainId 19880601；独立浏览器真实点击、签名与链上查询。
> 结论：六步主流程全部通过，另有 EIP-55 拒绝、地址历史与独立转账脚本复证。**本页不含私钥或助记词。**

## 验收矩阵

| 步骤 | 实测结果 | 截图 |
|------|----------|------|
| ① 生成钱包 | 生成一次性钱包、保存、刷新后地址恢复；私钥/助记词默认不渲染 | [01-created.png](01-created.png) |
| ② 领取 | 两次各领取 10 B03，交易分别入块 #31164 / #31262；页面显示合约付款方与 QBFT 终结 | [02-claimed-balance.png](02-claimed-balance.png) |
| ③ 余额与状态 | 20 B03、nonce 0、gasPrice 0、链高可读；全小写地址被 EIP-55 规则拦在签名前 | [03-checksum-rejection.png](03-checksum-rejection.png) |
| ④ 签名转账 | 向一次性地址转 1 B03，交易 `0x1a29b95b…39dfbc` 入块 #31352，status=1，gasUsed=21000 | [04-transfer-reconciled.png](04-transfer-reconciled.png) |
| ⑤ 双向对账 | 付款方 20→19、收款方 0→1；观察地址不需要对方私钥；两侧增量均为 1 | [04-transfer-reconciled.png](04-transfer-reconciled.png) |
| ⑥ 自查 | 交易深链显示 nonce、value、零 gas、input、签名、回执和 QBFT 终结；地址深链一出一入且四节点一致 | [05-explorer-transaction.png](05-explorer-transaction.png)、[06-recipient-address.png](06-recipient-address.png)、[07-sender-address.png](07-sender-address.png) |

## 独立链上复核

- `scripts/verify-transfer-both-sides.js`：另一组一次性账户完成 A `10→9`、B `0→1`，交易 `0xdcb9db09…5e62d` 入块 #32040，判定 PASS。
- 8551–8554 四节点：付款地址余额 19 B03 / nonce 1，收款地址余额 1 B03 / nonce 0，全部一致。
- 地址 API 返回同一笔 #31352 的收款记录，`direction=in`、`value=1000000000000000000`、`status=1`。
- 浏览器控制台错误：**0**。

## 回归中发现并修复的问题

1. Node 24 下 `better-sqlite3` 原生模块 ABI 不匹配，已在当前受管 Node 下重建（依赖不提交）。
2. 扫描器把 ERC721 同名 `Transfer` 的空 `data` 送入 `BigInt("0x")`，导致游标停在 **25777**、后续地址历史缺失。
   - `erc20.js` 只接受 ERC20 的三 topics + 32 字节 data；`scanner.js` 对空 value 按 0 处理。
   - 新增 `indexer/scanner.test.js`：**2/2** 覆盖混合 ERC20/ERC721 与空 value 的扫描和游标推进。
   - 扫描器追平至 **32041 / 32041（lag=0）**后，地址历史才显示一出一入；没有用余额正确来掩盖历史缺失。

## 复现

```bash
# 前置：shared/consortium-network 已运行，RPC 8551–8554 可用。
cd projects/B03-链上交互实战联盟网
npm install
npm rebuild better-sqlite3   # Node ABI 变化时；本地依赖，不入库

# 终端 A：索引器（Windows 本地路径用环境变量）
DB_PATH="$PWD/indexer/data/index.db" PUBLIC_BASE="http://127.0.0.1:8080" \
  EVIDENCE_KEYS="$PWD/indexer/data/evidence-keys" \
  WATCHDOG_STATE="$PWD/indexer/data/watchdog-state.json" node indexer/server.js
# 终端 B：水龙头（从仓库根 .env 读 FAUCET_PK，不打印）
node faucet/start.js
# 终端 C：同源页面 + RPC/API/faucet 反代
node ../../tools/serve-lab.mjs 8080

# 浏览器：http://127.0.0.1:8080/b03/wallet.html
# 单元回归：node --test indexer/scanner.test.js
# 独立对账：node scripts/verify-transfer-both-sides.js
```

结构化实测字段见 [result.json](result.json)，其中 `additionalRuns` 保留高清证据复跑及第二组跨地址对账的交易与余额，不以旧数字覆盖新结果。数据库、浏览器 localStorage 与一次性密钥均不纳入提交。
