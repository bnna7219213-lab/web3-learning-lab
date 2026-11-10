import { el, card, table, kv, lead, note, btn, badge, input, label, list } from "../lib/ui.js";
import {
  generateIdentity,
  identityFromPublicKeyHex,
  signMessage,
  verifyMessage,
  devicePreimage,
  digestAESKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "../lib/sign.js";
import { shortHash, nowStamp } from "../lib/crypto.js";

export default {
  id: "signature",
  title: "4. 加密与设备签名",
  async render(root) {
    root.append(
      el("h2", { text: "签名：私钥即身份，公钥即可验证的证据" }),
      lead("对称加密解决「别人看不见」，非对称签名解决「谁写的、有没有被改」。设备可信结算的全部信任起点就在这两件事上。")
    );

    // A. 对称加密
    const secretBox = input("供应商 A 结算明细：3 家门店，合计 128,600 元", "需要保密的原文");
    const aesOut = el("div");
    let aesKey = null;
    let sealed = null;
    root.append(
      card(
        "A. 对称加密（AES-256-GCM）：原文不进链，只在授权方之间可读",
        label("原文"),
        secretBox,
        btn("① 生成密钥并加密", async () => {
          aesKey = await digestAESKey();
          sealed = await aesGcmEncrypt(aesKey, secretBox.value);
          aesOut.replaceChildren(
            kv([
              ["IV（每次随机）", el("span", { class: "hash", text: sealed.ivHex })],
              ["密文", el("span", { class: "hash", text: shortHash(sealed.cipherHex, 40, 16) })],
              ["密文长度", el("span", { text: `${sealed.cipherHex.length / 2} 字节（含 16 字节认证标签）` })],
            ])
          );
        }),
        btn("② 用正确密钥解密", async () => {
          if (!sealed) return aesOut.replaceChildren(note("先加密。"));
          const result = await aesGcmDecrypt(aesKey, sealed.ivHex, sealed.cipherHex);
          aesOut.append(el("p", {}, [badge(result.ok, `解密成功：${result.plaintext}`, "解密失败"), note("　GCM 自带完整性校验，密文被改就拒绝解密（不是解出乱码）。")]));
        }),
        btn("③ 篡改 1 个比特再解密", async () => {
          if (!sealed) return aesOut.replaceChildren(note("先加密。"));
          const flipped = sealed.cipherHex.slice(0, -2) + (sealed.cipherHex.endsWith("00") ? "ff" : "00");
          const result = await aesGcmDecrypt(aesKey, sealed.ivHex, flipped);
          aesOut.append(el("p", {}, [badge(!result.ok, "被拒绝：认证加密（AEAD）改一个比特即失败", "居然解开了，实现有问题")]));
        }),
        aesOut,
        note("遗留问题：这把密钥怎么安全交给对方？对称加密做不到「不预先见面就能建立信道」——这就是非对称密码存在的理由。")
      )
    );

    // B. 非对称签名
    let device = await generateIdentity();
    let auditor = await generateIdentity();
    let signature = null;
    const deviceFields = {
      deviceId: input("device-01", "设备编号"),
      ts: input(nowStamp(), "时间戳"),
      seq: input("1", "递增序号"),
      payload: input("18.4C", "读数"),
      chainId: input("31337", "chainId"),
      contract: input("0xIoTBridge", "合约地址"),
    };
    const signOut = el("div");
    const messageOf = () =>
      devicePreimage({
        deviceId: deviceFields.deviceId.value,
        ts: deviceFields.ts.value,
        seq: deviceFields.seq.value,
        payload: deviceFields.payload.value,
        chainId: Number(deviceFields.chainId.value) || 0,
        contract: deviceFields.contract.value,
      });

    async function identityBlock() {
      signOut.replaceChildren(
        kv([
          ["设备私钥", el("span", { text: "留在设备安全元件里，永不导出（浏览器演示用内存对象代替）" })],
          ["设备公钥（65 字节非压缩）", el("span", { class: "hash", text: shortHash(device.publicKeyHex, 26, 14) })],
          ["派生身份地址", el("span", { class: "hash", text: device.address })],
          ["审计方公钥（另一台设备）", el("span", { class: "hash", text: shortHash(auditor.publicKeyHex, 26, 14) })],
          ["当前签名", el("span", { class: "hash", text: signature ? shortHash(signature, 26, 14) : "（尚未签名）" })],
        ])
      );
    }

    const verdict = el("div");
    const runVerify = async (labelText, publicKey, message, sig, expectOk) => {
      const ok = await verifyMessage(publicKey, sig, message);
      verdict.prepend(el("p", {}, [badge(ok === expectOk, `${labelText}：验签 ${ok ? "通过" : "失败"}（符合预期）`, `${labelText}：验签 ${ok ? "通过" : "失败"}（与预期不符）`)]));
    };

    root.append(
      card(
        "B. 设备签名与验签（ECDSA P-256，流程与链上 secp256k1 一致）",
        el("div", { class: "grid3" }, [
          el("div", {}, label("deviceId"), deviceFields.deviceId),
          el("div", {}, label("时间戳"), deviceFields.ts),
          el("div", {}, label("序号 seq"), deviceFields.seq),
        ]),
        el("div", { class: "grid3" }, [
          el("div", {}, label("payload 读数"), deviceFields.payload),
          el("div", {}, label("chainId（防跨链重放）"), deviceFields.chainId),
          el("div", {}, label("合约地址（防跨合约重放）"), deviceFields.contract),
        ]),
        btn("重新生成设备身份", async () => {
          device = await generateIdentity();
          auditor = await generateIdentity();
          signature = null;
          verdict.textContent = "";
          await identityBlock();
        }),
        btn("④ 设备签名", async () => {
          signature = await signMessage(device.privateKey, messageOf());
          await identityBlock();
        }, true),
        btn("⑤ 用正确公钥验签", async () => {
          if (!signature) return verdict.replaceChildren(note("先签名。"));
          const verifier = await identityFromPublicKeyHex(device.publicKeyHex);
          await runVerify("正常路径", verifier.publicKey, messageOf(), signature, true);
        }),
        btn("⑥ 改一个字节再验（读数被伪造）", async () => {
          if (!signature) return verdict.replaceChildren(note("先签名。"));
          const verifier = await identityFromPublicKeyHex(device.publicKeyHex);
          await runVerify("篡改报文", verifier.publicKey, `${messageOf()}｜现场补记 25.0℃`, signature, false);
        }),
        btn("⑦ 换别人的公钥验（未注册设备）", async () => {
          if (!signature) return verdict.replaceChildren(note("先签名。"));
          const other = await identityFromPublicKeyHex(auditor.publicKeyHex);
          await runVerify("冒名顶替", other.publicKey, messageOf(), signature, false);
        }),
        btn("⑧ 换 chainId 再验（跨链重放）", async () => {
          if (!signature) return verdict.replaceChildren(note("先签名。"));
          const verifier = await identityFromPublicKeyHex(device.publicKeyHex);
          const replay = messageOf().replace(/\|31337\|/, "|11155111|");
          await runVerify("跨链重放", verifier.publicKey, replay, signature, false);
        }),
        signOut,
        verdict
      )
    );
    await identityBlock();

    // C. 网关防重放
    const gateway = new Map();
    const gwBody = el("tbody");
    const gwTable = el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ["seq", "payload", "验签", "序号检查", "网关判定"].map((t) => el("th", { text: t })))),
      gwBody
    );

    async function submit(seqOverride) {
      const fields = {
        deviceId: deviceFields.deviceId.value || "device-01",
        ts: nowStamp(),
        seq: seqOverride ?? (Number(deviceFields.seq.value) || 1),
        payload: deviceFields.payload.value,
      };
      const message = devicePreimage(fields);
      const sig = await signMessage(device.privateKey, message);
      const verifier = await identityFromPublicKeyHex(device.publicKeyHex);
      const sigOk = await verifyMessage(verifier.publicKey, sig, message);
      const lastSeq = gateway.get(fields.deviceId) ?? 0;
      const seqOk = fields.seq > lastSeq;
      if (sigOk && seqOk) gateway.set(fields.deviceId, fields.seq);
      gwBody.prepend(
        el("tr", { class: sigOk && seqOk ? "row-ok" : "row-bad" }, [
          el("td", { text: String(fields.seq) }),
          el("td", { text: fields.payload }),
          el("td", {}, badge(sigOk, "验签通过", "验签失败")),
          el("td", {}, badge(seqOk, `新序号（上一有效 ${lastSeq}）`, `重放/回退（上一有效 ${lastSeq}）`)),
          el("td", {}, badge(sigOk && seqOk, "入账", "丢弃并告警")),
        ])
      );
    }

    root.append(
      card(
        "C. 结算网关：签名对 ≠ 可以入账（重放与序号单调）",
        note("真实系统里最常见的攻击不是破解签名，而是把一条合法报文再发一遍。下表最新一条在最上面。"),
        btn("正常提交 seq=1", () => submit(1)),
        btn("重放同一条 seq=1", () => submit(1)),
        btn("递增提交 seq=2", () => submit(2)),
        btn("回退提交 seq=1", () => submit(1)),
        gwTable
      )
    );

    root.append(
      card("D. 工程结论", list([
        "私钥即身份：没有「管理员帮你改回权限」这条路，密钥管理（多签/HSM/国密 SE）是交付的一部分，不是附录。",
        "签名域要包含链 id 与合约地址：否则同一条签名可以在另一条链/另一个合约上重放（EIP-191/EIP-712 的动机）。",
        "序号与时间戳由业务侧强制单调：验签只证明「谁写的」，不证明「只发生了一次」。",
        "浏览器用 ECDSA P-256 演示，链上是 secp256k1 + keccak256；换的是曲线与哈希，不是流程。",
      ])),
      card(null, el("p", { class: "biz" }, [
        el("b", { text: "商业落点：" }),
        "M2 设备可信结算（设备签名 → 链上结算一体机）· M1 分账的提现授权 · M5 支付指令签名。",
        el("a", { href: "#/pow", style: "margin-left:8px", text: "共识为什么要昂贵 →" }),
      ]))
    );
  },
};
