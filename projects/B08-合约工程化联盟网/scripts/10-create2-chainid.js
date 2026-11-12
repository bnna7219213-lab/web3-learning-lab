// scripts/10-create2-chainid.js —— Create2 地址派生与 chainId 绑定（README 知识点 4）
// 公链上 Create2 的地址公式不含 chainId——但联盟链换链 ID 时地址仍会**全变**：
//   因为工厂地址本身是 CREATE 派生（部署者+nonce），换链后部署历史不同 → 工厂地址不同
//   → 公式输入之一变了 → 所有 Create2 地址全变。所以链 ID 必须与地址一起永久登记。
// 本脚本：链上/链下双算地址对账 + 实部署验证 + 重复 salt 负例 + 登记链 ID 核对。
const path = require("path");
const { wallet, contract, provider, txOpts, ok, summary, hr, ethers, deployment, PROJECT } = require("./lib/b08");

(async () => {
  hr("10 create2 × chainId binding");
  const p = provider();
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const factory = contract("Create2Factory", issuer);
  const factoryAddr = await factory.getAddress();

  // ── ① 链 ID 永久登记核对：deployments/latest.json 的 chainId == 当前链 ────
  const dep = deployment();
  const liveChainId = Number((await p.getNetwork()).chainId);
  ok(dep.chainId === liveChainId, `登记链 ID == 实链 ID（${liveChainId}）——换链必须重新登记`);

  // ── ② 链下 EIP-1014 公式 vs 链上 computeAddress 双算对账 ──────────────────
  const beaconArt = JSON.parse(
    fsRead(path.join(PROJECT, "out", "Create2Factory.sol", "Beacon.json"))
  );
  const beaconBytecode = beaconArt.bytecode.object || beaconArt.bytecode;
  const initCode = beaconBytecode + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [7]).slice(2);
  const initCodeHash = ethers.keccak256(initCode);
  const salt = ethers.keccak256(ethers.toUtf8Bytes("b08/beacon/consortium/v1"));

  // 链下：address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  const predicted = ethers.getAddress(
    "0x" + ethers.keccak256("0x" + "ff" + factoryAddr.slice(2).toLowerCase() + salt.slice(2) + initCodeHash.slice(2)).slice(26)
  );
  const onchainCalc = await factory.computeAddress(salt, initCodeHash);
  ok(predicted.toLowerCase() === onchainCalc.toLowerCase(), `链下公式 == 链上 computeAddress（${predicted.slice(0, 12)}…）`);

  // ── ③ 实部署验证：CREATE2 实际地址 == 预测地址 ─────────────────────────────
  const actual = await factory.deploy.staticCall(salt, initCode, txOpts());
  ok(actual.toLowerCase() === predicted.toLowerCase(), `staticCall 预演地址 == 预测地址`);
  const { rec } = await (async () => {
    const tx = await factory.deploy(salt, initCode, txOpts());
    return { rec: await tx.wait() };
  })();
  ok(rec.status === 1, `实部署进块：tx ${rec.hash.slice(0, 14)}… status=1`);
  ok((await factory.deployedBySalt(salt)).toLowerCase() === predicted.toLowerCase(), "deployedBySalt 登记与实部署一致");

  // ── ④ 负例：同 salt 重复部署被拒（CREATE2 天然撞地址）─────────────────────
  try {
    await factory.deploy.staticCall(salt, initCode, txOpts());
    ok(false, "重复 salt 本应被拒");
  } catch (e) {
    ok(true, `重复 salt 被拒：${(e.shortMessage || e.message).slice(0, 60)}`);
  }

  // ── ⑤ chainId 绑定演示：换链 = 工厂地址不同 = 同 salt/initCode 地址全变 ────
  const otherFactory = "0x" + "11".repeat(20); // 换链后工厂地址必然不同（CREATE 派生）
  const predictedOther = ethers.getAddress(
    "0x" + ethers.keccak256("0x" + "ff" + otherFactory.slice(2) + salt.slice(2) + initCodeHash.slice(2)).slice(26)
  );
  ok(predictedOther !== predicted, "工厂地址一变，同 salt+initCode 的 Create2 地址全变 → 链 ID/工厂地址必须随地址永久登记");

  summary("10 create2 × chainId");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});

function fsRead(f) {
  return require("fs").readFileSync(f, "utf8").replace(/^﻿/, "");
}
