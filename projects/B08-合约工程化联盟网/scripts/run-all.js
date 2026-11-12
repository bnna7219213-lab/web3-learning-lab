// scripts/run-all.js —— B08 一键验收 runner：按依赖顺序跑完 02→11，汇总并落盘
//
// 顺序有讲究（不是随便排的）：
//   02 多成员 → 03 零 gas → 04 终结性 → 05 权限负例   ← 联盟网四条共用增量
//   06 Gas 双指标 → 07 升级演练 → 08 Merkle 互验        ← 本分支特有
//   09 大合约边界 → 10 Create2×chainId → 11 看板冒烟     ← 本分支特有 + 前端
//   07 会重新 forge build（london profile），所以放在 06 之后，避免污染 Gas 测量。
//
// 用法：node scripts/run-all.js            # 全跑
//      node scripts/run-all.js 06 07       # 只跑指定编号
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { PROJECT } = require("./lib/b08");

const ALL = [
  { id: "02", file: "02-multi-member.js", title: "多成员 nonce 隔离" },
  { id: "03", file: "03-zero-gas.js", title: "零 gas 断言" },
  { id: "04", file: "04-finality.js", title: "终结性（3 节点块哈希）" },
  { id: "05", file: "05-permission-negative.js", title: "权限负例留痕" },
  { id: "06", file: "06-gas-report.js", title: "Gas 双指标报告" },
  { id: "07", file: "07-upgrade-drill.js", title: "多成员升级演练 + 回滚" },
  { id: "08", file: "08-merkle-crosscheck.js", title: "Merkle × P01 四方向互验" },
  { id: "09", file: "09-big-contract.js", title: "大合约体积与单笔 gas 上限" },
  { id: "10", file: "10-create2-chainid.js", title: "Create2 × chainId 登记" },
  { id: "11", file: "11-dashboard-smoke.js", title: "运维看板端到端冒烟" },
];

function runOne(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    console.log("\n────────────────────────────────────────");
    console.log("▶ " + step.id + "  " + step.title + "  (" + step.file + ")");
    console.log("────────────────────────────────────────");
    const child = spawn(process.execPath, [path.join("scripts", step.file)], {
      cwd: PROJECT,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      const ms = Date.now() - t0;
      console.log("◀ " + step.id + " 退出码 " + code + " · " + ms + "ms");
      resolve({ ...step, code, ms });
    });
  });
}

(async () => {
  const picked = process.argv.slice(2);
  const steps = picked.length ? ALL.filter((s) => picked.includes(s.id)) : ALL;
  if (!steps.length) {
    console.error("没有匹配的脚本编号。可选：" + ALL.map((s) => s.id).join(", "));
    process.exit(1);
  }
  console.log("B08 一键验收：共 " + steps.length + " 项");
  const results = [];
  for (const s of steps) {
    const r = await runOne(s);
    results.push(r);
    if (r.code !== 0) {
      console.log("\n⚠ " + s.id + " 失败，先停在这里（后续步骤依赖它的产物）。");
      break;
    }
  }
  const failed = results.filter((r) => r.code !== 0);
  const record = {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.code === 0).length,
    failed: failed.length,
    steps: results,
  };
  const out = path.join(PROJECT, "deployments", "acceptance-run.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  console.log("\n════════════════════════════════════════");
  console.log(
    "B08 验收汇总：" +
      record.passed +
      " 项通过 / " +
      record.failed +
      " 项失败（" +
      record.total +
      " 项执行）"
  );
  console.log("记录：" + out);
  process.exit(failed.length ? 1 : 0);
})(); 
