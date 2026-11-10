import { el, card, kv, lead, note, btn, textarea, label, badge, list } from "../lib/ui.js";
import { sha256Hex, hexHamming, prefixMatchLength, randomHex, shortHash } from "../lib/crypto.js";

const heatDiff = (a, b) =>
  el(
    "div",
    { class: "heat" },
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      el("span", { class: a[i] === b[i] ? "same" : "diff", text: b[i] ?? "?" })
    )
  );

async function findPrefixCollision(prefixLen, maxAttempts = 300_000) {
  const seen = new Map();
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const value = `reading-${randomHex(6)}-${attempts}`;
    const hash = await sha256Hex(value);
    const bucket = hash.slice(0, prefixLen);
    const previous = seen.get(bucket);
    if (previous) {
      return { attempts, prefixLen, aValue: previous.value, aHash: previous.hash, bValue: value, bHash: hash };
    }
    seen.set(bucket, { value, hash });
  }
  return null;
}

export default {
  id: "hash",
  title: "1. Hash 与雪崩效应",
  async render(root) {
    root.append(
      el("h2", { text: "Hash：把任意长度原文压成定长指纹" }),
      lead("三条性质：① 定长 ② 单向（从指纹反推原文不现实）③ 雪崩（改 1 比特，输出约一半比特翻转）。区块链的一切「不可篡改」都建立在这三条上。")
    );

    // A. 计算器
    const box = textarea("device-01|2026-10-13T09:05:00Z|seq=42|temp=18.4C", "输入任意原文");
    const calcOut = el("div");
    const recompute = async () => {
      const hash = await sha256Hex(box.value);
      calcOut.replaceChildren(
        kv([
          ["SHA-256", el("span", { class: "hash", text: hash })],
          ["长度", el("span", { text: `${hash.length} 个十六进制位 = 256 比特（与原文长度无关）` })],
          ["前 6 位", el("span", { class: "hash", text: hash.slice(0, 6) })],
        ]),
        note("改一个字符再算：指纹完全不同；但长度永远不变——所以存证只需要保存这个定长值。")
      );
    };
    box.addEventListener("input", recompute);
    root.append(card("A. 指纹计算器", label("原文（模拟一条设备上报报文）"), box, calcOut));
    await recompute();

    // B. 雪崩
    const baseInput = el("input", { type: "range", min: "1", max: "40", value: "24" });
    const avalOut = el("div");
    const runAvalanche = async () => {
      const position = Number(baseInput.value) - 1;
      const honest = "device-01 冷链 2026-10-13 09:05 温度 18.4℃ 状态 合格";
      const forged = honest.slice(0, position) + (honest[position] === "X" ? "Y" : "X") + honest.slice(position + 1);
      const [h, f] = [await sha256Hex(honest), await sha256Hex(forged)];
      const flipped = hexHamming(h, f);
      avalOut.replaceChildren(
        kv([
          ["原文差异", el("span", { text: `第 ${position + 1} 个字符：「${honest[position]}」→「${forged[position]}」` })],
          ["诚实指纹", el("span", { class: "hash", text: h })],
          ["伪造指纹", heatDiff(h, f)],
          ["翻转比特", el("span", { text: `${flipped} / 256（约 ${Math.round((flipped / 256) * 100)}%）` })],
          ["结论", badge(flipped > 100, "雪崩正常：肉眼看不出原文差别，指纹却面目全非", "这次改动过小，重试换个位置")],
        ])
      );
    };
    baseInput.addEventListener("input", runAvalanche);
    root.append(
      card(
        "B. 雪崩效应：只改一个字，谁能看出来？",
        label("选择被篡改的字符位置"),
        baseInput,
        avalOut
      )
    );
    await runAvalanche();

    // C. 碰撞搜索
    const prefixSelect = el(
      "select",
      {},
      [3, 4, 5, 6].map((n) =>
        el("option", { value: String(n), text: `${n} 个十六进制位（生日界期望约 ${Math.round(1.2 * Math.pow(16, n / 2))} 次尝试）` })
      )
    );
    const collideOut = el("div");
    const runCollision = async () => {
      collideOut.replaceChildren(note("搜索中…"));
      const len = Number(prefixSelect.value);
      const result = await findPrefixCollision(len);
      if (!result) {
        collideOut.replaceChildren(badge(false, `${len} 位在 30 万次内未命中——哈希强度正在替你工作`, ""));
        return;
      }
      collideOut.replaceChildren(
        kv([
          ["尝试次数", el("span", { text: `${result.attempts} 次（约 1.2 × 16^${len}/2 量级，生日攻击）` })],
          ["输入 A", el("span", { class: "hash", text: result.aValue })],
          ["输入 B", el("span", { class: "hash", text: result.bValue })],
          ["指纹 A", el("span", { class: "hash", text: shortHash(result.aHash, 20, 10) })],
          ["指纹 B", el("span", { class: "hash", text: shortHash(result.bHash, 20, 10) })],
          ["相同前缀", el("span", { class: "hash", text: result.aHash.slice(0, len) })],
          ["实际共同前缀", el("span", { text: `${prefixMatchLength(result.aHash, result.bHash)} 个十六进制位` })],
        ]),
        note(
          "只要求前几位相同很容易；要求整个 256 比特相同，搜索量级约 2^128 次。所以「哈希值一致」可以当作同一份文件的证据——这正是 M4 出证只上哈希的底气。"
        )
      );
    };
    root.append(
      card(
        "C. 「找碰撞」体验：为什么指纹短了就不能当证据",
        label("要求相同的前缀位数"),
        prefixSelect,
        btn("开始搜索", runCollision, true),
        collideOut
      )
    );

    root.append(
      card("D. 工程含义（做存证/分账时的取舍）", list([
        "只上哈希、不上原文：原文留在客户侧，链上放定长指纹，天然满足数据最小化。",
        "拼接顺序必须规范：H(a|b) 与 H(b|a) 不同，跨系统对接要先约定序列化格式（等价于签名的规范化编码）。",
        "不要用 MD5/SHA-1：出证材料要能被司法鉴定接受，算法强度是前置条件。",
        "链上可用的是 keccak256（以太坊）而非 sha256（比特币）：本 Demo 用 sha256 讲原理，P04 起在 Foundry 里对比两者 Gas 与 solidity 内置。",
      ])),
      card(null, el("p", { class: "biz" }, [
        el("b", { text: "商业落点：" }),
        "M4 企业可信档案（哈希即指纹，出证只上哈希）· ",
        el("a", { href: "#/merkle", text: "下一步：用 Merkle 把 N 份单据压成 1 个根" }),
      ]))
    );
  },
};
