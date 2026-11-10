// node demos/device-signature.mjs —— 设备签名 + 网关防重放（M2 设备可信结算的最小内核）
import {
  generateIdentity,
  identityFromPublicKeyHex,
  signMessage,
  verifyMessage,
  devicePreimage,
} from "../frontend/lib/sign.js";

const device = await generateIdentity();
const attacker = await generateIdentity();
const reading = { deviceId: "device-01", ts: "2026-10-13T09:05:00Z", seq: 42, payload: "18.4C", chainId: 31337, contract: "0xIoTBridge" };
const message = devicePreimage(reading);
const signature = await signMessage(device.privateKey, message);
const verifier = await identityFromPublicKeyHex(device.publicKeyHex);

console.log(`设备公钥（65 字节非压缩）：0x${device.publicKeyHex.slice(0, 24)}…`);
console.log(`派生身份地址：${device.address}`);
console.log(`签名报文：${message}`);
console.log(`签名：${signature.slice(0, 32)}…`);

const checks = {
  正常验签: await verifyMessage(verifier.publicKey, signature, message),
  篡改读数: await verifyMessage(verifier.publicKey, signature, `${message}｜补记 25.0C`),
  冒名设备: await verifyMessage((await identityFromPublicKeyHex(attacker.publicKeyHex)).publicKey, signature, message),
  跨链重放: await verifyMessage(verifier.publicKey, signature, message.replace("|31337|", "|11155111|")),
};
for (const [name, ok] of Object.entries(checks)) console.log(`   ${name.padEnd(5)} → 验签 ${ok ? "通过" : "失败"}`);

// 网关：验签通过还不够，序号必须严格递增
const lastSeq = new Map();
function settle(seq) {
  const prev = lastSeq.get(reading.deviceId) ?? 0;
  if (seq <= prev) return `丢弃（上一有效 ${prev}）`;
  lastSeq.set(reading.deviceId, seq);
  return "入账";
}
console.log(`\n网关判定：seq=42 → ${settle(42)}｜seq=42 重放 → ${settle(42)}｜seq=43 → ${settle(43)}`);

if (!checks.正常验签 || checks.篡改读数 || checks.冒名设备 || checks.跨链重放) {
  console.error("\n异常：签名检查未达预期");
  process.exit(1);
}
console.log("\n结论：私钥即身份；「验签通过 + 序号单调」才等价于「这条上报可信且只算一次」。");
