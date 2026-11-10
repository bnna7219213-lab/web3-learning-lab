import { el, card, table, kv, lead, note, btn, badge, textarea, label, list } from "../lib/ui.js";
import { buildMerkleTree, getProof, buildProofPackage, computeRootFromProof } from "../lib/merkle.js";
import { sha256Hex, shortHash } from "../lib/crypto.js";

const DEFAULT_BATCH = [
  "发票 NO.2026-1001 供应商A 金额 12000",
  "发票 NO.2026-1002 供应商A 金额 8600",
  "发票 NO.2026-1003 供应商B 金额 43000",
  "温控记录 B121 09:05 18.4℃",
  "温控记录 B121 09:10 18.6℃",
  "验收单 WH03 批次 B121 合格",
  "结算单 S2026-10-13 平台/主播/公会 55:30:15",
  "发票 NO.2026-1004 供应商C 金额 1500",
];

const leavesOf = (batch) => batch.value.split("\n").map((s) => s.trim()).filter(Boolean);

export default {
  id: "merkle",
  title: "3. Merkle 树与批量出证",
  async render(root) {
    root.append(
      el("h2", { text: "Merkle 树：一批单据只上链一个值，每一份仍可单独证明" }),
      lead("存证与分账里最省钱的形状：链上只写 root（32 字节），链下保留全部原文；客户或监管拿到「叶子 + proof」即可离线复算，不需要访问你的数据库。")
    );

    const batch = textarea(DEFAULT_BATCH.join("\n"), "每行一份单据");
    const treeHost = el("div");
    const proofHost = el("div");
    const forgeHost = el("div");
    let tree = null;
    let picked = 3;

    async function renderTree() {
      const leaves = leavesOf(batch);
      if (!leaves.length) {
        tree = null;
        treeHost.replaceChildren(badge(false, "清单为空：批次必须拒绝空清单（root 为 null，合约侧要 revert）", ""));
        return;
      }
      tree = await buildMerkleTree(leaves);
      treeHost.replaceChildren(
        kv([
          ["单据份数", el("span", { text: `${leaves.length} 份` })],
          ["链上要写的 root", el("span", { class: "hash", text: tree.root })],
          ["树形", el("span", { text: `${tree.levels.length} 层：${tree.levels.map((l) => l.length).join(" → ")}` })],
          ["链下原文总量", el("span", { text: `${leaves.join("").length} 字符（链上只承载 32 字节）` })],
        ]),
        note("奇数节点复制末尾（教学做法）。生产要用索引哈希或 Merkle Mountain Range：否则 3 份与「3 份 + 末尾重复」会撞同一个 root，单测已把这条弱点固定住。")
      );
    }

    function proofSelect(leaves) {
      return el(
        "select",
        {
          onchange: async (e) => {
            picked = Number(e.target.value);
            await renderProof();
          },
        },
        leaves.map((text, i) =>
          el("option", { value: String(i), text: `第 ${i} 份：${text.slice(0, 22)}`, ...(i === picked ? { selected: "selected" } : {}) })
        )
      );
    }

    async function renderProof() {
      if (!tree) {
        proofHost.replaceChildren(note("先点「计算 Merkle Root」。"));
        return;
      }
      const leaves = leavesOf(batch);
      picked = Math.min(picked, leaves.length - 1);
      const pkg = await buildProofPackage(leaves, picked);
      proofHost.replaceChildren(
        label("选择要出证的单据"),
        proofSelect(leaves),
        kv([
          ["序号 / 总数", el("span", { text: `${pkg.index} / ${pkg.total}` })],
          ["原文", el("span", { text: pkg.data })],
          ["叶子哈希", el("span", { class: "hash", text: pkg.leafHash })],
          ["链上 root", el("span", { class: "hash", text: pkg.root })],
          ["验证结果", badge(pkg.verifiable, "通过：第三方无需问你即可复算", "失败")],
        ]),
        table(
          ["证明层", "兄弟节点哈希", "兄弟在"],
          pkg.proof.map((step, i) => [String(i), shortHash(step.hash, 18, 10), step.position])
        ),
        el("details", {}, [
          el("summary", { text: "出证包 JSON（交给客户 / 监管 / 法院的材料）" }),
          el("pre", { text: JSON.stringify(pkg, null, 2) }),
        ])
      );
    }

    root.append(
      card(
        "A. 批次清单（每行一份单据）",
        batch,
        btn("计算 Merkle Root", async () => {
          await renderTree();
          await renderProof();
        }, true),
        treeHost
      ),
      card("B. 单份出证与离线验证", proofHost),
      card("C. 攻击模拟：替换选中的单据", note("验证方只有 root 与出证包。替换原文 → 叶子哈希变 → 沿路复算出的根与链上 root 不同。"),
        btn("执行伪造并重验", async () => {
          if (!tree) {
            forgeHost.replaceChildren(badge(false, "先计算 root", ""));
            return;
          }
          const leaves = leavesOf(batch);
          const forgedLeaf = await sha256Hex(`L|${leaves[picked]}｜金额改成 999999`);
          const proof = getProof(tree, picked);
          const recomputed = await computeRootFromProof(forgedLeaf, proof);
          forgeHost.replaceChildren(
            kv([
              ["伪造单据", el("span", { text: `${leaves[picked]}｜金额改成 999999` })],
              ["伪造叶子哈希", el("span", { class: "hash", text: forgedLeaf })],
              ["沿证明复算出的根", el("span", { class: "hash", text: recomputed })],
              ["链上真实根", el("span", { class: "hash", text: tree.root })],
              ["判定", badge(recomputed !== tree.root, "拒绝：伪造不通过，这就是可交付的证据强度", "居然通过，实现有漏洞")],
            ])
          );
        }),
        forgeHost
      ),
      card(
        "D. 为什么这是省钱又可信的形状",
        table(
          ["方式", "1000 份单据要写多少链上数据", "结论"],
          [
            ["逐份上链存证", "1000 笔交易，每笔约 2.1 万–5 万 Gas", "成本、吞吐、隐私全输"],
            ["Merkle 批量", "1 笔，写 32 字节 root", "大批次均摊成本趋近于零，逐份仍可证"],
            ["纯链下台账", "0", "便宜但不可信：回到「必须先相信某一家」"],
          ]
        ),
        list([
          "合约端验证 proof 的循环与这里完全同构（P08/P19 会在 Solidity 里重写一遍）。",
          "出证包必须写清算法约定：前缀 L|/N|、奇数处理、编码方式；约定不一致就无法跨系统复算。",
          "同一形状复用处：批量分账快照、Merkle 空投、按批次出证、链下订单撮合的链上结算。",
        ])
      ),
      card(null, el("p", { class: "biz" }, [
        el("b", { text: "商业落点：" }),
        "M4 企业可信档案（批量出证）· M1 多方分账（整批结算单一次锚定）。",
        el("a", { href: "#/signature", style: "margin-left:8px", text: "谁有权提交这一批？→ 设备与账户签名" }),
      ]))
    );

    await renderTree();
    await renderProof();
  },
};
