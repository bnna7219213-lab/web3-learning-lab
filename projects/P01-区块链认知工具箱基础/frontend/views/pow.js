import { el, card, table, kv, lead, note, btn, badge, input, label, list } from "../lib/ui.js";
import { mineBlock, meetsTarget, expectedAttempts, preimage } from "../lib/pow.js";
import { sha256Hex, shortHash } from "../lib/crypto.js";

export default {
  id: "pow",
  title: "5. 工作量证明",
  async render(root) {
    root.append(
      el("h2", { text: "工作量证明：把「写账本」变成一件必须花钱的事" }),
      lead("教学模型：要求区块哈希以 N 个 0 开头。哈希结果不可预测，唯一办法是不断换 nonce 暴力试——难度每 +1，期望尝试次数 ×16。" )
    );

    const dataBox = input("device-01 冷链批次 B121 结算 12,800 元", "区块内容");
    const difficultyBox = el(
      "select",
      {},
      [1, 2, 3, 4, 5].map((n) =>
        el("option", { value: String(n), text: `难度 ${n}（前导 0 × ${n}，期望 ${expectedAttempts(n).toLocaleString()} 次）` })
      )
    );
    difficultyBox.value = "3";
    const mineOut = el("div");
    const verifyOut = el("div");
    let last = null;

    root.append(
      card(
        "A. 挖一个块",
        label("区块内容"),
        dataBox,
        label("难度（前导零个数）"),
        difficultyBox,
        btn("开始挖矿", async () => {
          mineOut.replaceChildren(note("搜索中…"));
          const difficulty = Number(difficultyBox.value);
          const result = await mineBlock({ index: 0, difficulty, data: dataBox.value, maxAttempts: 4_000_000 });
          last = { ...result, data: dataBox.value, prevHash: "0".repeat(64) };
          if (result.nonce < 0) {
            mineOut.replaceChildren(badge(false, `400 万次内没挖到（难度 ${difficulty} 本来就很难）`, ""));
            return;
          }
          const rate = (result.attempts / Math.max(result.ms, 1)).toFixed(2);
          mineOut.replaceChildren(
            kv([
              ["命中哈希", el("span", { class: "hash", text: result.hash })],
              ["nonce", el("span", { text: String(result.nonce) })],
              ["尝试次数", el("span", { text: `${result.attempts.toLocaleString()} 次（期望 ${expectedAttempts(difficulty).toLocaleString()}）` })],
              ["耗时", el("span", { text: `${result.ms} ms ≈ ${rate} hash/ms（浏览器 WebCrypto 实现，远慢于原生/ASIC）` })],
            ])
          );
          verifyOut.textContent = "";
        }, true),
        mineOut
      ),
      card(
        "B. 复验只要一次哈希（挖矿贵、验挖矿便宜——这就是共识的成本结构）",
        btn("以任意第三方身份复验", async () => {
          if (!last) return verifyOut.replaceChildren(note("先挖一个块。"));
          const recomputed = await sha256Hex(preimage(0, last.difficulty, last.prevHash, last.data, last.nonce));
          const ok = recomputed === last.hash && meetsTarget(recomputed, last.difficulty);
          verifyOut.replaceChildren(
            kv([
              ["复算哈希", el("span", { class: "hash", text: shortHash(recomputed, 24, 14) })],
              ["与区块存值一致", badge(ok, "一致：无需信任矿工，重算即可", "不一致")],
              ["满足难度", badge(meetsTarget(recomputed, last.difficulty), `前导 ${last.difficulty} 个 0 达标`, "未达标")],
            ]),
            note("改一下区块内容再复验：把 A 里的文本改一个字，回到这里重新复验，会立刻不一致——这就是「验证者不需要重挖矿也能查假」。")
          );
        }),
        verifyOut
      ),
      card(
        "C. 难度与成本（数量级直觉）",
        table(
          ["难度（前导 0）", "期望尝试次数", "十六进制前缀概率", "说明"],
          [1, 2, 3, 4, 5].map((n) => [
            String(n),
            expectedAttempts(n).toLocaleString(),
            `1 / ${expectedAttempts(n).toLocaleString()}`,
            n <= 2 ? "浏览器瞬间完成" : n === 3 ? "仍可感知" : "开始变慢，难度 5 通常要等几十秒到几分钟",
          ])
        ),
        list([
          "算力竞赛的本质：谁能更低成本地试更多 nonce，谁就更容易记账 → 挖矿产业与能耗问题（境内已清退）。",
          "51% 攻击直觉：攻击者要重算从某个高度起的全部后续区块，成本随区块数与全网算力上升；这就是「确认数」的意义。",
          "PoS 换成另一种昂贵：押注 + 罚没，作恶损失大于收益（P02 的 MiniChain 会实现简化版）。",
          "联盟链/盟链不需要挖矿：记账方是已知的签约主体，用排序与背书的共识（PBFT/raft 类），Gas 只用于资源计量。",
        ])
      ),
      card(null, el("p", { class: "biz" }, [
        el("b", { text: "商业落点：" }),
        "选型依据（M2 交付时解释「为什么盟链不需要矿机」）· M0 演示轨的共识实验。",
        el("a", { href: "#/overview", style: "margin-left:8px", text: "回到讲解页做自检" }),
      ]))
    );
  },
};
