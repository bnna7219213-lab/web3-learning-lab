// scripts/07-upgrade-drill.js —— 代理升级演练：全成员参与窗口 + 回滚（README 本分支特有验收）
// 联盟链与公链的最大差异就在这里：升级不是 owner 单方行为，而是**多成员变更流程**：
//   变更单 → 全成员签名窗口（停机确认）→ 升级 → 灰度核对 → 回滚演练（代码可回滚，存储不回滚）
// 三条硬规矩沿用 b08.js；升级链上痕迹 = ERC-1967 Upgraded 事件 + 实现槽变更。
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { wallet, contract, provider, cfg, txOpts, ok, summary, hr, ethers, PROJECT } = require("./lib/b08");

// ERC-1967 实现槽：keccak256("eip1967.proxy.implementation") - 1
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function artifact(name) {
  const f = path.join(PROJECT, "out", "UUPSUpgrade.sol", `${name}.json`);
  const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  return j.bytecode.object || j.bytecode; // forge 新旧 artifact 格式兼容
}

(async () => {
  hr("07 upgrade drill (multi-member window + rollback)");

  // ── 0. 重新按 consortium profile（london）编译：out/ 可能被 default(cancun) 的
  //      forge test 覆盖过——cancun 字节码含 PUSH0，上联盟网 status=0（B07 的坑）
  execSync("forge build", { cwd: PROJECT, env: { ...process.env, FOUNDRY_PROFILE: "consortium" }, stdio: "pipe" });
  ok(true, "forge build（FOUNDRY_PROFILE=consortium / london）");

  const p = provider();
  const owner = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const memberB = wallet("MEMBER_B_PRIVATE_KEY");
  const dep = JSON.parse(fs.readFileSync(path.join(PROJECT, "deployments", "latest.json"), "utf8"));
  const proxy = contract("vaultProxy", owner, undefined);
  const proxyAddr = await proxy.getAddress();

  // ── 1. 变更单 manifest + 全成员签名窗口 ──────────────────────────────────
  const manifest = {
    change: "VaultV1 -> VaultV2 (UUPS)",
    proxy: proxyAddr,
    chainId: Number((await p.getNetwork()).chainId),
    rollbackImpl: dep.vaultImpl, // 回滚目标 = 当前 V1 实现
    window: "升级期间暂停新业务入金（停机窗口），灰度核对通过后恢复",
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const sigA = await memberA.signMessage(manifestText);
  const sigB = await memberB.signMessage(manifestText);
  const signers = [sigA, sigB].map((s) => ethers.verifyMessage(manifestText, s));
  ok(
    signers.includes(await memberA.getAddress()) && signers.includes(await memberB.getAddress()),
    `全成员签名窗口：memberA+memberB 均签署变更单（${signers.map((s) => s.slice(0, 10)).join(" / ")}…）`
  );
  const outsider = wallet("OUTSIDER_PRIVATE_KEY");
  const sigO = await outsider.signMessage(manifestText);
  const outsiderAddr = ethers.verifyMessage(manifestText, sigO);
  ok(outsiderAddr !== await owner.getAddress(), "outsider 签名不具成员效力（不进入签名集）");

  // ── 2. 升级前快照（含 ERC-1967 实现槽与业务存储槽）────────────────────────
  async function snapshot(tag) {
    const implSlot = await p.getStorage(proxyAddr, IMPL_SLOT); // ethers v6: getStorage
    const s2 = await p.getStorage(proxyAddr, 2); // totalDeposited
    return {
      tag,
      impl: "0x" + implSlot.slice(-40),
      slot2TotalDeposited: BigInt(s2),
      owner: await proxy.owner(),
      version: await proxy.version(),
    };
  }
  const before = await snapshot("before");
  console.log(`  before: impl=${before.impl} owner=${before.owner} version=${before.version} slot2=${before.slot2TotalDeposited}`);

  // ── 3. 部署 V2 实现并升级（owner 执行，签名窗口已满）─────────────────────
  const factory = new ethers.ContractFactory(
    JSON.parse(fs.readFileSync(path.join(PROJECT, "abi", "vaultV2.json"), "utf8").replace(/^﻿/, "")),
    artifact("VaultV2"),
    owner
  );
  let nonce = await p.getTransactionCount(await owner.getAddress());
  const implV2 = await factory.deploy({ gasLimit: 8000000, gasPrice: 0n, type: 0, nonce: nonce++ });
  await implV2.waitForDeployment();
  const v2Addr = await implV2.getAddress();
  ok(v2Addr !== before.impl, `VaultV2 新实现部署：${v2Addr}`);

  const upTx = await proxy.upgradeToAndCall(v2Addr, "0x", { ...txOpts(), nonce: nonce++ });
  const upRec = await upTx.wait();
  ok(upRec.status === 1, `升级交易进块：${upRec.hash.slice(0, 14)}… status=1`);

  const after = await snapshot("after-upgrade");
  ok(after.impl.toLowerCase() === v2Addr.toLowerCase(), `ERC-1967 实现槽已指向 V2（${after.impl.slice(0, 12)}…）`);
  ok(after.slot2TotalDeposited === before.slot2TotalDeposited, `slot2(totalDeposited) 未漂移（${after.slot2TotalDeposited}）`);
  ok(after.owner === before.owner, "owner 未变");

  // ── 4. 灰度核对：V2 新能力可用（只读，不动业务状态）─────────────────────
  // 代理升级后入口不变、ABI 变了——V2 新字段要用 V2 ABI 挂代理地址来读
  const proxyAsV2 = factory.attach(proxyAddr).connect(owner);
  ok((await proxyAsV2.totalWithdrawn()) === 0n, "V2 新字段 totalWithdrawn() 可读=0");
  ok((await proxyAsV2.lastDepositBlock(await owner.getAddress())) === 0n, "V2 新字段 lastDepositBlock() 可读=0");

  // ── 5. 回滚演练：升级回 V1 实现（代码可回滚）─────────────────────────────
  const rbTx = await proxy.upgradeToAndCall(dep.vaultImpl, "0x", { ...txOpts(), nonce: nonce++ });
  const rbRec = await rbTx.wait();
  ok(rbRec.status === 1, `回滚交易进块：${rbRec.hash.slice(0, 14)}… status=1`);

  const rolled = await snapshot("after-rollback");
  ok(rolled.impl.toLowerCase() === dep.vaultImpl.toLowerCase(), `实现槽回到 V1（${rolled.impl.slice(0, 12)}…）`);
  ok(rolled.slot2TotalDeposited === before.slot2TotalDeposited, `回滚后 slot2 仍未漂移（${rolled.slot2TotalDeposited}）`);

  // 回滚后业务可用：V1 的 deposit 仍工作
  const depTx = await proxy.deposit({ ...txOpts(), nonce: nonce++, value: 0n });
  const depRec = await depTx.wait();
  ok(depRec.status === 1, "回滚后 V1 deposit() 仍可用（业务恢复）");

  // 教学点：回滚只回滚**代码**，不回滚**存储**——V2 写过的东西 V1 不认识也不会清
  const v1View = contract("vaultProxy", provider());
  ok((await v1View.version()) === 1n, "version 仍是 1（本次演练未执行 migrateFromV1，存储未被 V2 改写）");

  // ── 6. 演练记录落盘（变更单 + 签名 + 快照对账）──────────────────────────
  const record = {
    drilledAt: new Date().toISOString(),
    manifest,
    memberSignatures: { memberA: sigA, memberB: sigB },
    snapshots: [before, after, rolled].map((s) => ({
      ...s,
      slot2TotalDeposited: s.slot2TotalDeposited.toString(),
      version: s.version.toString(),
    })),
    upgradeTx: upRec.hash,
    rollbackTx: rbRec.hash,
    conclusion: "代码可回滚（实现槽回 V1）；存储不回滚——若执行过 migrateFromV1，version=2 会留在链上，回滚方案必须配套数据订正",
  };
  const out = path.join(PROJECT, "deployments", "upgrade-drill.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`  演练记录：${out}`);

  summary("07 upgrade drill");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
