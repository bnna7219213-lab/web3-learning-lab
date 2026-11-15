// 验收公共层：ethers + anvil 解锁账户（零私钥口径，与 B03/P09 一致）。
// 交易走 eth_sendTransaction，验证者签名走 personal_sign——仓库不放任何私钥。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RPC = process.env.RPC || "http://127.0.0.1:8545";
export const U = (n) => BigInt(n) * 10n ** 6n; // LabUSD 6 位小数

export const provider = new ethers.JsonRpcProvider(RPC);

export function loadDeployment() {
  const f = path.join(ROOT, "deployments", "latest.json");
  if (!fs.existsSync(f)) throw new Error(`缺部署记录 ${f}：先跑 bash script/deploy.sh anvil`);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
}

export function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "abi", `${name}.json`), "utf8").replace(/^﻿/, ""));
}

/// 账户表：0 admin / 1-5 验证者 / 6 provider / 7 agent 运行时 / 8 碳基用户 / 9 硅基主体
export async function loadContext() {
  const d = loadDeployment();
  const signers = {};
  const names = ["admin", "v1", "v2", "v3", "v4", "v5", "provider", "runtime", "human", "silicon"];
  for (let i = 0; i < names.length; i++) signers[names[i]] = await provider.getSigner(i);
  const c = (name, addr, signer) => new ethers.Contract(addr, loadAbi(name), signer ?? signers.admin);
  return {
    d,
    signers,
    usd: c("LabUSD", d.labUsd),
    id: c("LabID", d.labId),
    reg: c("SignalRegistry", d.signalRegistry),
    agent: c("PaymentAgent", d.paymentAgent),
    payee: ethers.Wallet.createRandom().address, // 商户收款地址（随机，无私钥持久化）
  };
}

/// 幂等布线：角色 / 验证者 / 身份 / 资金。重复跑验收不会洗状态。
export async function bootstrap(ctx) {
  const { signers: s, usd, id, reg, agent } = ctx;
  const admin = await s.admin.getAddress();
  const [providerAddr, runtime, human, silicon] = await Promise.all(
    [s.provider, s.runtime, s.human, s.silicon].map((x) => x.getAddress())
  );

  const grantIf = async (contract, role, who) => {
    if (!(await contract.hasRole(role, who))) await (await contract.grantRole(role, who)).wait();
  };
  await grantIf(reg, await reg.PROVIDER_ROLE(), providerAddr);
  await grantIf(agent, await agent.AGENT_ROLE(), runtime);
  for (const v of [s.v1, s.v2, s.v3, s.v4, s.v5]) {
    const addr = await v.getAddress();
    if (!(await reg.isVerifier(addr))) await (await reg.addVerifier(addr)).wait();
  }
  if ((await id.idOf(human)) === 0n) {
    await (await id.mint(human, false, ethers.id("human-kyc-material+salt"))).wait();
  }
  if ((await id.idOf(silicon)) === 0n) {
    await (await id.mint(silicon, true, ethers.id("agent-kyc-material+salt"))).wait();
  }
  for (const who of [human, silicon]) {
    if ((await usd.balanceOf(who)) < U(100_000)) {
      await (await usd.mint(who, U(100_000))).wait();
    }
    const allowance = await usd.allowance(who, await agent.getAddress());
    if (allowance < U(1_000_000)) {
      const signer = who === human ? s.human : s.silicon;
      await (await usd.connect(signer).approve(await agent.getAddress(), ethers.MaxUint256)).wait();
    }
  }
  return { admin, providerAddr, runtime, human, silicon };
}

/// 一条信号走完整管线：provider 承诺 + 3/5 验证者 EIP-191 确认。
export async function pushSignal(ctx, subject, kind, salt) {
  const { signers: s, reg } = ctx;
  const sigHash = ethers.solidityPackedKeccak256(["address", "uint8", "string"], [subject, kind, salt]);
  const ts = BigInt((await provider.getBlock("latest")).timestamp);
  const rec = await (await reg.connect(s.provider).commit(subject, "agent:runtime", sigHash, kind, ts)).wait();
  const cid = rec.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "Committed").args.commitmentId;
  const inner = ethers.solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "uint8", "uint64"],
    ["LabSignal-Confirm", cid, subject, sigHash, kind, ts]
  );
  for (const v of [s.v1, s.v2, s.v3]) {
    const sig = await v.signMessage(ethers.getBytes(inner));
    await (await reg.confirm(cid, sig)).wait();
  }
  return cid;
}

/// 把主体声誉刷到目标 tier（走真实信号管线）。kind 默认 AgentFingerprint(3)。
/// salt 带时间戳：同一主体多次运行不会撞去重键。
export async function raiseToTier(ctx, subject, tier, kind = 3) {
  const { id } = ctx;
  const weight = await ctx.reg.kindWeight(kind);
  const need = [0n, 100n, 500n, 2000n][tier];
  let count = 0;
  const stamp = Date.now();
  while ((await id.reputationOf(subject)) < need) {
    await pushSignal(ctx, subject, kind, `raise-${tier}-${stamp}-${count++}`);
  }
}

/// 断言调用以指定自定义错误失败（选择器级，不是「失败了就行」）。
export async function mustRevert(promise, iface, name) {
  try {
    await promise;
  } catch (e) {
    const data = e.data ?? e.info?.error?.data ?? null;
    if (!data) throw new Error(`期望 ${name}，但没有 revert data：${e.shortMessage ?? e.message}`);
    const parsed = iface.parseError(data);
    if (!parsed || parsed.name !== name) {
      throw new Error(`期望 ${name}，实际 ${parsed?.name ?? data}`);
    }
    return parsed;
  }
  throw new Error(`期望 revert ${name}，但调用成功了`);
}

let passed = 0;
let failed = 0;
const counters = {};
export async function check(group, name, fn) {
  counters[group] = (counters[group] ?? 0) + 1;
  const tag = `${group}${String(counters[group]).padStart(2, "0")}`;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${tag} ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${tag} ${name}\n      ${e.shortMessage ?? e.message}`);
  }
}
export function summary() {
  console.log(`\n验收结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  if (failed > 0) process.exitCode = 1;
}
export const assert = (cond, msg) => {
  if (!cond) throw new Error(msg ?? "断言失败");
};

export const snapshot = () => provider.send("evm_snapshot", []);
export const revert = (id) => provider.send("evm_revert", [id]);