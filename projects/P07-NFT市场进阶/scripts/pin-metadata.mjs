// 元数据 pin 脚本：把 NFT 元数据（与可选图片）加进本地 IPFS，输出 CID 与网关 URL。
// 用法：node scripts/pin-metadata.mjs --name "Lab NFT #0" --desc "…" [--image assets/lab-nft-0.svg]
// 依赖：本机 kubo daemon（API 127.0.0.1:5001，见 README）。零 npm 依赖（node22 原生 fetch/FormData）。
// 哈希锚定：tokenURI = ipfs://<CID>；CID 即内容哈希，改一个字节 CID 就变——链上锚的是内容不是位置。
import fs from "node:fs";
import path from "node:path";

const API = process.env.IPFS_API || "http://127.0.0.1:5001";
const GATEWAY = process.env.IPFS_GATEWAY || "http://127.0.0.1:8088";

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

async function add(buf, filename) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  const res = await fetch(`${API}/api/v0/add?pin=true&cid-version=1`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`IPFS add 失败 ${res.status}: ${await res.text()}`);
  return (await res.json()).Hash;
}

const name = get("--name", "Lab NFT");
const desc = get("--desc", "学习用 NFT 凭证（零价值）");
const image = get("--image", "");

let imageUri = "";
if (image) {
  const buf = fs.readFileSync(image);
  const cid = await add(buf, path.basename(image));
  imageUri = `ipfs://${cid}`;
  console.log(`image  CID=${cid}  ${GATEWAY}/ipfs/${cid}`);
}

const metadata = {
  name,
  description: desc,
  image: imageUri,
  attributes: [
    { trait_type: "purpose", value: "learning" },
    { trait_type: "value", value: "zero" },
  ],
};
const cid = await add(Buffer.from(JSON.stringify(metadata, null, 2)), "metadata.json");
console.log(`meta   CID=${cid}`);
console.log(`tokenURI=ipfs://${cid}`);
console.log(`gateway=${GATEWAY}/ipfs/${cid}`);

// 读回验证：网关取回的内容必须与提交逐字节一致（哈希锚定的自证）
const back = await fetch(`${GATEWAY}/ipfs/${cid}`);
const same = Buffer.from(await back.arrayBuffer()).equals(Buffer.from(JSON.stringify(metadata, null, 2)));
console.log(`readback=${same ? "IDENTICAL" : "MISMATCH"}`);
if (!same) process.exit(1);