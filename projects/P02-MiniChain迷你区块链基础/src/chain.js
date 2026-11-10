// 链：重放验证、总难度（权重）比较、分叉点定位与重组计划。
import { validateBlock } from "./block.js";
import { checkTx, applyTx, emptyState } from "./tx.js";

// 权重模型：PoW 块按难度计（每 +1 难度 ≈ 16 倍成本，这里用 2^难度 的简化线性权重），PoS 块记 1。
export function blockWeight(block) {
  return block.consensus === "pow" ? Math.pow(2, block.difficulty) : 1;
}

export function chainWeight(blocks) {
  return blocks.reduce((sum, b) => sum + blockWeight(b), 0);
}

/**
 * 重放整条链：逐块检查结构 → 逐笔检查签名 → 应用状态。
 * 任何一步不过就是这条链无效；返回的 state 是「链尖账本快照」。
 */
export async function replayChain(blocks, { validators = [] } = {}) {
  const state = emptyState();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.index !== i) return { ok: false, reason: `第 ${i} 块高度错乱（实际 ${block.index}）` };
    if (i > 0 && block.prevHash !== blocks[i - 1].hash) {
      return { ok: false, reason: `第 ${i} 块 prevHash 未接上第 ${i - 1} 块` };
    }
    const shape = await validateBlock(block, { validatorSet: validators });
    if (!shape.ok) return { ok: false, reason: `第 ${i} 块：${shape.reason}` };

    // 创世余额表只在第 0 块生效：重组后重放也必须得到同一份账本
    if (i === 0) {
      for (const { address, balance, nonce = 0 } of block.allocations ?? []) {
        state.accounts[address] = { balance, nonce };
      }
    }

    for (const tx of block.txs) {
      const checked = await checkTx(tx);
      if (!checked.ok) return { ok: false, reason: `第 ${i} 块交易：${checked.reason}` };
      const appliedResult = applyTx(state, tx, block.proposer);
      if (!appliedResult.ok) return { ok: false, reason: `第 ${i} 块交易：${appliedResult.reason}` };
    }
  }
  return { ok: true, reason: "", state, blocks };
}

export function findForkPoint(local, remote) {
  let i = 0;
  while (i < local.length && i < remote.length && local[i].hash === remote[i].hash) i++;
  return i - 1; // 最后一个共同区块的下标；-1 表示连创世块都不同
}

/**
 * 收到别人的链时怎么办：
 * 1) 共同祖先必须存在，否则两条链无关；
 * 2) 只有「严格更重」才切换（最长链规则），等重时保持本地（避免来回抖动）；
 * 3) 被丢弃区块里的交易回到待打包区——这就是「已确认交易被回滚」的确切含义。
 */
export function planAdoption(local, remote, { validators = [] } = {}) {
  const forkAt = findForkPoint(local, remote);
  if (forkAt < 0) return { adopt: false, reason: "创世块不同，非同一网络", forkAt: -1, orphanedTxs: [] };

  const localWeight = chainWeight(local);
  const remoteWeight = chainWeight(remote);
  if (remoteWeight <= localWeight) {
    return { adopt: false, reason: `本地不更轻（本地 ${localWeight} ≥ 对方 ${remoteWeight}）`, forkAt, orphanedTxs: [] };
  }
  const orphaned = local.slice(forkAt + 1).flatMap((b) => b.txs);
  return {
    adopt: true,
    reason: `切换到更重链：${localWeight} → ${remoteWeight}`,
    forkAt,
    orphanedTxs: orphaned,
    newChain: remote,
  };
}

export function confirmations(chain, blockHash) {
  const index = chain.findIndex((b) => b.hash === blockHash);
  return index < 0 ? 0 : chain.length - 1 - index;
}

export function balanceOf(state, address) {
  return state.accounts[address]?.balance ?? 0;
}

export function nonceOf(state, address) {
  return state.accounts[address]?.nonce ?? 0;
}
