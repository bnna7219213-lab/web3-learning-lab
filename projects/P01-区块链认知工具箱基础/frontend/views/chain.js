import { el, card, table, kv, lead, note, btn, badge, input, label, list } from "../lib/ui.js";
import { buildChain, auditChain, rewriteChain, anchor, verifyAnchor } from "../lib/hashchain.js";
import { shortHash, nowStamp } from "../lib/crypto.js";

const readText = () => {
  const temps = ["18.4℃", "18.6℃", "22.9℃", "19.1℃", "25.3℃"];
  return `device-0${1 + Math.floor(Math.random() * 3)} 冷链 温度 ${temps[Math.floor(Math.random() * temps.length)]}（批次 B${Math.floor(Math.random() * 900) + 100}）`;
};

const honestLedger = () => [
  { timestamp: "2026-10-13 09:00:00", data: "出库装车：冷机设定 -18℃" },
  { timestamp: "2026-10-13 09:05:00", data: readText() },
  { timestamp: "2026-10-13 09:10:00", data: readText() },
  { timestamp: "2026-10-13 09:15:00", data: readText() },
  { timestamp: "2026-10-13 09:20:00", data: "到仓验收：按台账判定合格" },
];

// 篡改目标：把某条读数改成「看起来合格」的 18.0℃
const forge = (text) => (/-?\d+(\.\d+)?℃/.test(text) ? text.replace(/-?\d+(\.\d+)?℃/, "18.0℃") : `${text}｜补记 18.0℃ 合格`);

export default {
  id: "chain",
  title: "2. 哈希链与篡改检测",
  async render(root) {
    root.append(
      el("h2", { text: "哈希链：改历史要重算后续，而重算之后本地还查得出来吗？" }),
      lead("一份冷链温度台账，四种操作：只改数据、改完整段重算、链尖追加、把链尖承诺交给外部见证。结论：单副本台账不是证据，必须锚定到自己控制不了的地方。")
    );

    let blocks = await buildChain(honestLedger());
    let honestAnchor = await anchor(blocks);

    const tableHost = el("div");
    const auditHost = el("div");
    const anchorHost = el("div");
    const statusHost = el("p", { class: "note", text: "尚未操作。试按钮 ①。" });
    const targetInput = input("2", "区块序号 0-4");

    async function refresh() {
      const result = await auditChain(blocks);
      tableHost.replaceChildren(
        table(
          ["#", "时间", "数据", "prevHash", "hash", "自洽", "链接"],
          result.rows.map((b) =>
            el(
              "tr",
              { class: b.ok ? "row-ok" : "row-bad" },
              [
                el("td", { text: String(b.index) }),
                el("td", { text: b.timestamp }),
                el("td", { text: b.data }),
                el("td", { class: "hash", text: shortHash(b.prevHash, 10, 6) }),
                el("td", { class: "hash", text: shortHash(b.hash, 10, 6) }),
                el("td", {}, badge(b.selfOk, "OK", "被改")),
                el("td", {}, badge(b.linkOk, "OK", "断链")),
              ]
            )
          )
        )
      );
      auditHost.replaceChildren(
        result.valid
          ? badge(true, `本地审计通过：${blocks.length} 块全部自洽`, "")
          : badge(false, `本地审计失败：从第 ${result.brokenAt} 块起不再自洽`, "")
      );
      const anchorOk = await verifyAnchor(blocks, honestAnchor);
      anchorHost.replaceChildren(
        kv([
          ["外部锚点（见证值）", el("span", { class: "hash", text: honestAnchor })],
          ["当前链尖锚点", el("span", { class: "hash", text: await anchor(blocks) })],
          [
            "对比结论",
            badge(anchorOk, "一致：外部见证承认这条链", "不一致：外部见证拒绝承认——历史已被重写"),
          ],
        ])
      );
    }

    const pickIndex = () => Math.min(Math.max(Number(targetInput.value) || 0, 0), blocks.length - 1);

    root.append(
      card(
        "A. 台账与四种操作",
        tableHost,
        auditHost,
        statusHost,
        label("要篡改的区块序号"),
        targetInput,
        btn("① 只改数据（不重算）", async () => {
          const i = pickIndex();
          blocks = blocks.map((b, idx) => (idx === i ? { ...b, data: forge(b.data) } : b));
          statusHost.textContent = `第 ${i} 块读数被改成「合格」，但没动 hash。`;
          await refresh();
        }),
        btn("② 改完并把后续整段重算", async () => {
          const i = pickIndex();
          blocks = await rewriteChain(blocks, i, forge(blocks[i].data));
          statusHost.textContent = `第 ${i} 块起所有 hash 重算完毕，本地校验现在看不出异常——请对比 B 的锚点。`;
          await refresh();
        }),
        btn("③ 追加一条新上报（诚实做法）", async () => {
          blocks = await buildChain(blocks.concat([{ timestamp: nowStamp(), data: readText() }]));
          statusHost.textContent = "只在链尖追加，不改历史。";
          await refresh();
        }),
        btn("④ 把链尖锚点交公证/上链", async () => {
          honestAnchor = await anchor(blocks);
          statusHost.textContent = `外部见证记下新的锚点 ${shortHash(honestAnchor)}。此后任何重写都会在对账时暴露。`;
          await refresh();
        }),
        btn("⑤ 重置为诚实台账", async () => {
          blocks = await buildChain(honestLedger());
          honestAnchor = await anchor(blocks);
          statusHost.textContent = "已重置。";
          await refresh();
        })
      ),
      card("B. 外部锚点（公链高度 / 公证处 / 监管台账）", anchorHost),
      card("C. 工程结论", list([
        "哈希链保证「悄悄改一定查得出」，前提是有人愿意重算比对——所以审计要独立于记账方。",
        "整段重算能骗过本地校验，但骗不过外部锚点：这正是「只上哈希到公链/盟链」的商业价值，而不是「链上存文件」。",
        "多节点共识让重写代价随规模上升（对应 Demo ⑤ 工作量证明与 P02 的 MiniChain）。",
        "交付写法：把「每日链尖锚定 + 出证含锚点(tx hash/区块高度/公证编号)」写进 SLA 与合同。",
      ])),
      card(null, el("p", { class: "biz" }, [
        el("b", { text: "商业落点：" }),
        "M4 企业可信档案（锚点与出证）· M2 设备可信结算（冷链台账）。",
        el("a", { href: "#/merkle", style: "margin-left:8px", text: "整批台账怎么只上 1 个值 →" }),
      ]))
    );

    await refresh();
  },
};
