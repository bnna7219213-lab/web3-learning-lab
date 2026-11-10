{
  "_comment": "QBFT 联盟链创世模板。字段与常量取自 Besu 官方文档（qbft.md / free-gas.md / genesis-items.md，抓取 2026-10-14）。占位符全大写，用 scripts/10-genesis.sh 替换；不要手填 extraData。",
  "config": {
    "chainId": 19880601,
    "comment_chainid": "官方参数表写作 chainId，QBFT 教程示例写作 chainid，两者均可解析；此处按参数表。链 ID 必须全局唯一并登记（防跨网重放，同 P01 签名域原理）。",

    "berlinBlock": 0,
    "londonBlock": 0,
    "zeroBaseFee": true,
    "comment_zeroBaseFee": "零 gas 网络必须项（free-gas 文档第 6 步）：启用 londonBlock 后 EIP-1559 会强制非零 baseFee，只有 zeroBaseFee=true 才能真正免费。原方案写的 baseFeePerGas:0x0 不是官方机制。",

    "contractSizeLimit": 2147483647,
    "comment_contractSizeLimit": "零 gas 网络建议放到最大（free-gas 第 3 步），否则 P07/P08 的大合约部署不进去。",

    "qbft": {
      "blockperiodseconds": 5,
      "requesttimeoutseconds": 10,
      "epochlength": 30000,
      "pertxgaslimit": 0,
      "comment_pertxgaslimit": "EIP-7825 把单笔交易上限压到 16,777,216 gas；0 = 解除上限，便于大合约部署/迁移。正值必须 <= gasLimit。",
      "comment_epochlength": "上线后不可改：官方明确 'Changing the epochlength after genesis can result in illegal blocks'。"
    }
  },

  "nonce": "0x0000000000000000",
  "timestamp": "0x0",
  "gasLimit": "0x1fffffffffffff",
  "comment_gasLimit": "官方 free-gas 文档推荐值（Hardhat 可接受的最大值）。我一度以为它过大，查证后确认照抄即可。若更在意出块准点，可改成验证者在实际 blockperiod 内真能处理的气体量。",
  "difficulty": "0x0",
  "mixHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "comment_postmerge": "difficulty=0 与 mixHash 全零是 Post-Merge 常量要求（qbft.md「Post-Merge configuration」）。原方案 difficulty=0x1 且缺 mixHash，会生成非法块。",

  "extraData": "REPLACE_WITH_GENERATED_VALUE",
  "comment_extraData": "必须用 besu operator generate-blockchain-config 生成（含 4 个验证者地址 + 空 sealed 段），Merge 后 vanity 限 32 字节。手写会直接导致链无法出块。",

  "alloc": {
    "REPLACE_ADMIN_ADDRESS_NO_0X_PREFIX": { "balance": "0x200000000000000000000000000000000000000000000000000000000000000" },
    "comment_alloc": "官方模板的 alloc 键不带 0x 前缀。余额值是 wei 的十六进制；上面这行 = 2.3e37 wei，请按实际规划改。零 gas 网络里余额只影响需要余额检查的场景（配合 tx-pool-enable-balance-check=false）。"
  },

  "number": "0x0",
  "gasUsed": "0x0",
  "parentHash": "0x0000000000000000000000000000000000000000000000000000000000000000"
}
