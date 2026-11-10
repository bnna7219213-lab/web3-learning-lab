import test from "node:test";
import assert from "node:assert/strict";
import {
  generateIdentity,
  identityFromPublicKeyHex,
  signMessage,
  verifyMessage,
  devicePreimage,
  digestAESKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "../frontend/lib/sign.js";

const reading = { deviceId: "device-01", ts: "2026-10-13T09:05:00Z", seq: 42, payload: "18.4C" };

test("私钥签名 → 公钥验签通过；改一个字节即失败", async () => {
  const signer = await generateIdentity();
  const msg = devicePreimage(reading);
  const sig = await signMessage(signer.privateKey, msg);

  const verifier = await identityFromPublicKeyHex(signer.publicKeyHex);
  assert.equal(await verifyMessage(verifier.publicKey, sig, msg), true);
  assert.equal(await verifyMessage(verifier.publicKey, sig, msg.replace("18.4C", "25.0C")), false);
});

test("签名不能由别人的公钥验证（设备未注册即拒绝）", async () => {
  const device = await generateIdentity();
  const other = await generateIdentity();
  const sig = await signMessage(device.privateKey, devicePreimage(reading));
  assert.equal(
    await verifyMessage((await identityFromPublicKeyHex(other.publicKeyHex)).publicKey, sig, devicePreimage(reading)),
    false
  );
});

test("签名域包含 chainId 与合约地址：跨链重放自动失效", async () => {
  const device = await generateIdentity();
  const onAnvil = devicePreimage({ ...reading, chainId: 31337 });
  const onSepolia = devicePreimage({ ...reading, chainId: 11155111 });
  const sig = await signMessage(device.privateKey, onAnvil);
  assert.equal(await verifyMessage(device.publicKey, sig, onSepolia), false);
});

test("公钥导出为 65 字节非压缩格式（0x04 开头），与链上 secp256k1 公钥同形", async () => {
  const { publicKeyHex } = await generateIdentity();
  assert.equal(publicKeyHex.length, 130);
  assert.equal(publicKeyHex.slice(0, 2), "04");
});

test("AES-GCM：正确密钥可解密；密文被篡改则拒绝（认证加密）", async () => {
  const key = await digestAESKey();
  const { ivHex, cipherHex } = await aesGcmEncrypt(key, "供应商 A 结算明细（原文不进链）");
  assert.equal((await aesGcmDecrypt(key, ivHex, cipherHex)).ok, true);

  const flipped = (cipherHex.slice(0, -2) + (cipherHex.endsWith("00") ? "ff" : "00"));
  assert.equal((await aesGcmDecrypt(key, ivHex, flipped)).ok, false);

  const wrongKey = await digestAESKey();
  assert.equal((await aesGcmDecrypt(wrongKey, ivHex, cipherHex)).ok, false);
});
