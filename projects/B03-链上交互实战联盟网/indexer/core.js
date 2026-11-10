// shared/evidence 的解析层。
//
// 为什么要这一层：仓库里 indexer 通过 ../../../shared/evidence 复用出证核心，
// 但服务器上部署在 /opt/b03-indexer，那个相对路径根本不存在。与其在代码里写死一条路径，
// 不如明确"优先仓库路径，退化到随包拷来的 vendor/ 副本"，两边都能跑且报错信息说清发生了什么。
//
// 部署脚本 60-deploy-indexer.sh 负责把 shared/evidence/lib 同步到 vendor/evidence-lib，
// 所以 vendor 目录是**构建产物**，不要手改、也不要在里面写业务逻辑。
const path = require("node:path");
const fs = require("node:fs");

const CANDIDATES = [
  ["repo", path.join(__dirname, "..", "..", "..", "shared", "evidence", "lib")],
  ["vendored", path.join(__dirname, "vendor", "evidence-lib")],
];

function resolveLib(name) {
  for (const [label, dir] of CANDIDATES) {
    const f = path.join(dir, `${name}.js`);
    if (fs.existsSync(f)) return { mod: require(f), from: label, file: f };
  }
  throw new Error(
    `找不到 shared/evidence/lib/${name}.js。仓库里跑应自动命中；服务器上跑请先执行 ` +
    `scripts/60-deploy-indexer.sh 同步 vendor/evidence-lib（已查找：${CANDIDATES.map((c) => c[1]).join(" , ")}）`
  );
}

const merkle = resolveLib("merkle-indexed").mod;
const sign = resolveLib("sign").mod;
const verify = resolveLib("verify").mod;

module.exports = { merkle, sign, verify, resolveLib, origin: { merkle: resolveLib("merkle-indexed").from } };
