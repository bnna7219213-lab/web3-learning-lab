// scripts/02-members-transfer.js —— 多成员转让（正例）+ 权限负例 + 审计留痕
// 验收点：成员 A→B 转让成功；A→未授权成员失败且留痕；成员资格被撤销后不能转出。
const { wallet, credential, send, ok, summary, hr, txOpts, cfg } = require("./lib/b07");

(async () => {
  hr("02 multi-member transfer + permission negative cases");
  const issuer = wallet("ISSUER_PRIVATE_KEY");
  const memberA = wallet("MEMBER_A_PRIVATE_KEY");
  const memberB = wallet("MEMBER_B_PRIVATE_KEY");
  const outsider = wallet("OUTSIDER_PRIVATE_KEY");
  const cred = credential(issuer);
  const A = await memberA.getAddress();
  const B = await memberB.getAddress();
  const O = await outsider.getAddress();
  const baseURI = cfg().INTERNAL_OSS_BASE || "http://127.0.0.1:8088/cred/";
  const ROOT = "0x" + "11".repeat(32);

  console.log("  issuer  ", await issuer.getAddress());
  console.log("  memberA ", A);
  console.log("  memberB ", B);
  console.log("  outsider", O);

  // 1) 成员白名单登记
  await send(cred, "setMember", [A, true]);
  await send(cred, "setMember", [B, true]);
  ok((await cred.isMember(A)) === true, "member A registered");
  ok((await cred.isMember(B)) === true, "member B registered");
  ok((await cred.isMember(O)) === false, "outsider NOT registered");

  // 2) 发行给成员 A
  const { rec } = await send(cred, "mintBatch", [A, 1, baseURI, ROOT, 0, true]);
  const tokenId = (await cred.nextId()) - 1n;
  console.log(`  minted token#${tokenId} gasUsed=${rec.gasUsed}`);
  ok((await cred.ownerOf(tokenId)) === A, "credential minted to member A");

  // 3) 正例：成员 A → 成员 B
  const credA = credential(memberA);
  const r1 = await send(credA, "transferFrom", [A, B, tokenId]);
  ok((await cred.ownerOf(tokenId)) === B, "member A -> member B transfer OK");
  console.log(`  tx gasUsed=${r1.rec.gasUsed} status=${r1.rec.status}`);

  // 4) 负例：成员 B → 非成员（应 revert NotMember）
  //    注意：必须等回执——contract.method() 在 eth_sendTransaction 返回时就 resolve 了，
  //    revert 发生在挖块阶段，不 wait 就看不到失败（脚本坑，不是合约问题）。
  const credB = credential(memberB);
  let err = null;
  try {
    await send(credB, "transferFrom", [B, O, tokenId]);
  } catch (e) {
    err = e;
  }
  ok(!!err, "member B -> outsider REJECTED");
  const name = err && err.revert ? err.revert.name : err && err.shortMessage;
  console.log("     revert =", name);

  // 5) 留痕：先只读预检拿原因码，再写审计记录
  const [allowed, why] = await cred.checkTransfer(B, O, tokenId);
  ok(allowed === false, "checkTransfer says not allowed");
  const whyName = {
    [await cred.REASON_NOT_MEMBER_TO()]: "NOT_MEMBER_TO",
    [await cred.REASON_NOT_MEMBER_FROM()]: "NOT_MEMBER_FROM",
    [await cred.REASON_EXPIRED()]: "EXPIRED",
    [await cred.REASON_NOT_TRANSFERABLE()]: "NOT_TRANSFERABLE",
  }[why] || why;
  console.log("     reason =", whyName);
  const before = await cred.auditCount();
  await send(cred, "recordBlockedTransfer", [B, O, tokenId, why]);
  const after = await cred.auditCount();
  ok(after === before + 1n, "audit trail entry appended");
  const entry = await cred.auditEntries(after);
  ok(entry.to === O && entry.reason === why, "audit entry content matches");
  console.log(`     audit#${after} actor=${entry.actor} from=${entry.from} to=${entry.to} token=${entry.tokenId}`);

  // 6) 负例：成员资格被撤销后不能转出
  await send(cred, "setMember", [B, false]);
  let err2 = null;
  try {
    await send(credB, "transferFrom", [B, A, tokenId]);
  } catch (e) {
    err2 = e;
  }
  ok(!!err2, "removed member CANNOT transfer out");
  console.log("     revert =", err2 && err2.revert ? err2.revert.name : err2 && err2.shortMessage);

  summary("02 multi-member");
})().catch((e) => {
  console.error("FAIL:", e.shortMessage || e.message);
  process.exit(1);
});
