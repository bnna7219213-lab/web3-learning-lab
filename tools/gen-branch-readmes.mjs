import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/bnna7/Aether/web3_roadmap";
const force = process.argv.includes("--force");

const NET = "../../shared/consortium-network";

// P 分支真实目录名（用于生成可点击的相对链接）
const TWIN = {
  P03: "P03-链上交互实战基础",
  P04: "P04-HelloContract基础",
  P05: "P05-ERC20代币基础",
  P06: "P06-投票DApp基础",
  P07: "P07-NFT市场进阶",
  P08: "P08-合约工程化进阶",
};

const M = [
  {
    id: "B03", dir: "B03-链上交互实战联盟网", twin: "P03", name: "链上交互实战（联盟网）",
    goal: "在自建 QBFT 联盟网上完成「建账户 → 授权 → 发交易 → 用内网浏览器逐字段解析」，替代公链浏览器依赖。",
    kp: [
      "自定义 chainId 与 RPC profile（不再用公共节点）",
      "无公网浏览器时如何解析交易：input selector、logs/topics、receipt、gasUsed",
      "QBFT 确定性终结下的「确认数」语义（终结证明 vs N 个确认）",
      "内网 Blockscout 部署与索引延迟",
      "账户白名单导致的「交易被拒」新故障类别",
      "RPC 经反向代理后的鉴权与审计日志"
    ],
    stack: ["Besu 26.9.0 QBFT 4 验证者（`shared/consortium-network`）", "cast/viem 脚本 + 自建解析页", "内网 Blockscout（版本相关环境变量部署前核实）"],
    delta: [
      ["浏览器", "sepolia.etherscan.io", "内网 Blockscout 或自研解析页（P26/B 分支共同的离线交付常态）"],
      ["领水", "公共 faucet（有额度与验证码）", "运营方 alloc 预存 或 零 gas 免余额（见 docs/02）"],
      ["最终性", "约 2 epoch 才 finalized", "单块终结，但 n=4 挂 2 台会停链"],
      ["失败模式", "gas 不足 / nonce 抢跑", "新增：账户未授权、节点不在白名单、某节点 min-gas-price 漂移导致静默丢单"]
    ],
    biz: [["M2/M4", "内网出证查询与交易解析是政企交付的必备件", "解析手册 + 内网浏览器部署说明"]],
    accept: ["3 个不同成员账户各发 5 笔交易，nonce 互不干扰", "每笔交易能在内网浏览器按 hash 查到并逐字段解释", "写清「本链无公网浏览器时客户如何自证」的替代方案"]
  },
  {
    id: "B04", dir: "B04-HelloContract联盟网", twin: "P04", name: "HelloContract（联盟网）",
    goal: "把 Foundry 写-测-部署闭环平移到 QBFT 联盟链，验证「合约零改动」这个卖点是否真成立。",
    kp: [
      "foundry.toml 多 profile：anvil / sepolia / consortium",
      "私钥来源：环境变量 vs keystore vs 远程签名",
      "零 gas 链上的 gas 估算与显式 maxFeePerGas=0",
      "部署者必须在账户白名单（否则报 permissioned 拒绝）",
      "verify 流程在无公网浏览器时的替代（本地源码哈希登记）"
    ],
    stack: ["Solidity + Foundry（rpc-url 指向联盟网）", "无前端（B06 再做）", "部署记录：deployments/<chainId>.json（对齐 lainchain 的 DeploymentRecorder）"],
    delta: [
      ["部署目标", "anvil / Sepolia", "联盟网 RPC（内网地址 + 可选 mTLS 代理）"],
      ["gas", "真实 gasPrice，需领水", "`min-gas-price=0` + `zeroBaseFee=true`，MetaMask 会异常，需脚本发交易"],
      ["验证合约", "Etherscan verify", "本地登记源码哈希 + 出证（进 M4）"],
      ["失败面", "revert / out of gas", "新增：账户未授权、单笔超 EIP-7825 上限"]
    ],
    biz: [["M1/M3/M4", "所有业务合约的部署基线与 profile 规范", "foundry profile 模板 + 部署脚本"]],
    accept: ["同一份合约在 anvil 与联盟网部署成功且地址可复现（Create2 时记录 salt）", "forge test 全绿；联盟网集成测试含「未授权账户部署被拒」负例", "部署产物自动导出 ABI 给前端（消灭手写 ABI）"]
  },
  {
    id: "B05", dir: "B05-ERC20代币联盟网", twin: "P05", name: "代币与权限（联盟网）",
    goal: "在联盟环境实现「内部积分/权益代币」，重点不是发币，而是**谁能发行、谁能销毁、跨成员如何授权**。",
    kp: [
      "AccessControl 角色与成员组织的映射（运营方/审计方/成员）",
      "mint/burn 的治理：单签 → 多签 → 时间锁的演进",
      "EIP-2612 permit 在无 gas 环境的意义变化（免签名单据）",
      "内部积分与「变相代币」的合规边界",
      "精度与四舍五入方向（联盟对账口径必须一致）"
    ],
    stack: ["Solidity + OpenZeppelin v5 + Foundry", "无前端（B06 起）", "角色配置：deployments/roles.json"],
    delta: [
      ["代币定位", "公链可流通资产", "**联盟内部记账单位**：不可对外转让、不可兑换法币、无二级"],
      ["发行权", "合约 owner", "运营方多签 + 成员确认；变更进 M4 存证"],
      ["合规", "面向公众即触碰红线", "限定成员范围 + 合同依据（对齐去代币化检查表）"],
      ["技术新增", "—", "角色矩阵测试：未授权 mint 必须 revert 且有事件留痕"]
    ],
    biz: [["M1 多方分账中台", "分账计价载体的联盟内实现", "角色矩阵 + 计价单位规范"], ["M4", "发行/销毁动作即存证对象", "事件清单"]],
    accept: ["角色矩阵 ≥6 条负例测试（未授权 mint/burn/改角色全部 revert）", "文档写清「本代币不是虚拟货币」的三条依据", "跨成员转账 100 笔后各成员余额与链下台账零差异"]
  },
  {
    id: "B06", dir: "B06-投票DApp联盟网", twin: "P06", name: "审批/投票 DApp（联盟网）",
    goal: "把投票 DApp 升级为**多成员审批流**：不同成员用各自账户签名、双人复核、前端可切换成员身份。",
    kp: [
      "多账户 nonce 管理器（按 address 串行化）",
      "viem 直连联盟网 RPC（绕开钱包对零 gas 链的校验问题）",
      "审批状态机：提案 → 复核 → 生效延迟 → 执行",
      "成员身份与链上地址映射（对应 M4 企业可信档案）",
      "事件驱动的前端刷新与索引延迟处理"
    ],
    stack: ["Next.js/React + viem（不依赖 MetaMask 注入）", "Solidity 审批合约", "数据：联盟网事件 + 内网索引（B09 前用轻量轮询）"],
    delta: [
      ["交互主体", "单个学习钱包", "**多成员账户**，每成员独立身份与权限"],
      ["钱包", "MetaMask", "MetaMask 在零 gas 链上会异常 → 用后端代签或 viem 显式 maxFeePerGas=0"],
      ["业务语义", "投票", "**双人复核/授权**（M5 补贴直达的核心流程原型）"],
      ["新增验收", "—", "未授权成员操作被拒且留痕；两成员并发操作 nonce 不串"]
    ],
    biz: [["M5 补贴直达/履约支付", "「条件判定 + 双人复核 + 生效延迟」流程原型", "审批流合约 + 管理台"], ["M1", "分成比例变更走同一审批模型", "复用说明"]],
    accept: ["2 个成员账户并发各发 10 笔，全部成功且顺序正确", "未授权成员发起审批 → 前端可读的拒绝原因 + 链上留痕", "提案到执行含生效延迟，可演示「撤销窗口」"]
  },
  {
    id: "B07", dir: "B07-NFT市场联盟网", twin: "P07", name: "权益凭证（联盟网）",
    goal: "把 NFT 市场改造成**联盟内权益凭证系统**：成员间转让受控、元数据不出内网、无二级炒作入口。",
    kp: [
      "ERC-721/1155 在联盟场景的语义收缩（凭证而非藏品）",
      "EIP-4907 租期分离：owner/user 双角色的成员间租赁",
      "元数据放内网对象存储 + 哈希上链（不依赖公网 IPFS）",
      "转让限制：账户白名单 + 合约层转让策略（禁二级）",
      "批量铸造与 EIP-7825 单笔 gas 上限的关系"
    ],
    stack: ["Solidity + Foundry", "React 权益管理台", "内网 OSS + 哈希锚定（复用 P01 Merkle 出证结构）"],
    delta: [
      ["定位", "公开市场 + 版税 + 二级", "**权益发行/核销/退改**，明确关闭二级"],
      ["元数据", "IPFS/Pinata", "客户内网对象存储，链上只存哈希（数据不出域）"],
      ["批量", "受 gas 成本约束", "受区块容量与单笔 gas 上限约束（需 pertxgaslimit）"],
      ["合规", "数字藏品炒作风险", "禁二级 + 实名成员 + 预收费监管口径（见 M3 卡片）"]
    ],
    biz: [["M3 权益与订阅", "权益模板合约 + 核销 API + 管理台", "可报价的模块 v0"], ["M4", "元数据哈希存证复用同一出证包", "出证接口"]],
    accept: ["成员 A→B 转让成功、A→未授权成员失败且留痕", "1000 份权益批量铸造通过（含 gas 上限验证）", "到期自动回收 0 例外；核销 P95 < 300ms"]
  },
  {
    id: "B08", dir: "B08-合约工程化联盟网", twin: "P08", name: "合约工程化（联盟网）",
    goal: "在零 gas 联盟链上重做 Gas/升级/Create2/Merkle 四类工程实验，把「优化」的目标从省钱改成**省区块容量与延迟**。",
    kp: [
      "零 gas 下为什么仍要优化：区块 gasLimit 决定吞吐与出块准点率",
      "contractSizeLimit 与 EIP-170/7825 对大合约的真实约束",
      "代理升级在多成员链上的流程（需成员共识窗口，不是单方行为）",
      "Create2 地址派生与 chainId 绑定（联盟链换链 ID 会导致地址全变）",
      "合约端 Merkle proof 验证 + 出证包（接 shared/evidence）"
    ],
    stack: ["Solidity + Foundry（forge snapshot + gas report）", "Slither/Aderyn", "脚本：升级演练 + 全成员参与窗口"],
    delta: [
      ["优化目标", "省 ETH", "省区块容量、降延迟、控节点资源（成员分摊成本）"],
      ["升级权限", "合约 owner 单方", "**多成员窗口**：停机/灰度/回滚需协调，写进变更流程"],
      ["地址可预测", "主网/测试网通用", "chainId 变更会使 Create2 地址全变 → 链 ID 必须永久登记"],
      ["新增交付", "—", "合约体积与单笔 gas 上限的实测报告（决定批量业务能否上线）"]
    ],
    biz: [["M1/M4", "批量分账与出证的链上验证（对数级 gas）", "verifyProof 合约 + 容量报告"], ["全部模块", "可控升级与变更流程", "升级 Runbook（含成员协调）"]],
    accept: ["Gas 报告改成「区块容量占用 + 出块延迟影响」双指标", "一次代理升级演练含全成员参与与回滚方案", "合约端 Merkle 验证与 P01 链下实现互相验证通过", "大合约（>24KB）在 contractSizeLimit/pertxgaslimit 配置下部署成功"]
  },
];

const render = (b) => `# ${b.id} · ${b.name}

> 状态：未开始 ｜ 对应主线：[${b.twin}](../${TWIN[b.twin]}/README.md) ｜ 网络底座：[shared/consortium-network](${NET}/README.md) ｜ 更新：2026-10-14
> 一句话目标：${b.goal}

## 与 ${b.twin} 的关系

**功能实现一致，环境语义不同。**${b.twin} 的全部知识点在本分支都要做一遍，本 README 只记录**差异与新增验收**；
共性差异见 [差异矩阵](${NET}/docs/04-差异矩阵-P03-P08-vs-B03-B08.md)。

| 维度 | ${b.twin}（公链/anvil） | ${b.id}（联盟 QBFT） |
|------|------------------------|----------------------|
${b.delta.map(([k, p, q]) => `| ${k} | ${p} | ${q} |`).join("\n")}

## 知识点

${b.kp.map((k) => `- [ ] ${k}`).join("\n")}

## 技术栈

${b.stack.map((s) => `- ${s}`).join("\n")}

## 环境准备

\`\`\`bash
cd ${NET}
bash scripts/00-preflight.sh
bash scripts/20-up-docker.sh          # 单机 4 验证者验证；多机见 README §三
RPC=http://127.0.0.1:8545 bash scripts/30-smoke-test.sh
\`\`\`

## 商业落点

| 模块 | 本项目提供什么 | 交付形态 |
|------|----------------|----------|
${b.biz.map(([m, w, f]) => `| ${m} | ${w} | ${f} |`).join("\n")}

## 任务拆解

1. [ ] 复用 ${b.twin} 的实现，切到联盟网 profile
2. [ ] 多成员账户与 nonce 管理
3. [ ] 零 gas 相关断言与负例
4. [ ] 权限（白名单/角色）正例与负例
5. [ ] 内网可观测（浏览器/日志/审计）
6. [ ] 文档与截图

## 验收

**分支共用四条增量**（B03–B08 一律适用）：

- [ ] 多成员：≥2 个成员账户各自发交易，nonce 互不干扰
- [ ] 零 gas：\`eth_gasPrice == 0\` 且 \`baseFeePerGas == 0\`，交易确实入账
- [ ] 终结性：交易所在块在 3 个节点查询一致，5 分钟后仍一致
- [ ] 权限负例：未授权账户/节点被拒且留下可审计记录

**本分支特有**：

${b.accept.map((a) => `- [ ] ${a}`).join("\n")}

- [ ] README 可按步骤复现（含联盟网准备步骤）
- [ ] 去代币化检查表通过（涉及对外交付时）

## 复盘

- 与 ${b.twin} 相比最意外的差异：
- 联盟特有故障（静默丢单 / 授权遗漏 / 停链）遇到没有：
- 对客交付时客户最关心的问题：
`;

let created = 0, skipped = 0;
for (const b of M) {
  const dir = path.join(ROOT, "projects", b.dir);
  const file = path.join(dir, "README.md");
  if (existsSync(file) && !force) { skipped++; continue; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, render(b), "utf8");
  created++;
}
console.log(`生成 ${created} 个分支 README，跳过 ${skipped} 个`);
