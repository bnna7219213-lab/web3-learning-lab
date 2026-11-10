// 零依赖静态服务器（供 P01 认知工具箱等本地页面使用）
// 用法：node tools/serve.mjs [端口]   默认 8787
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".md": "text/plain; charset=utf-8",
};

async function resolveTarget(urlPath) {
  // 只允许 ROOT 内的文件，防目录穿越
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  let target = path.resolve(ROOT, rel === "" ? "README.md" : rel);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (target !== ROOT && !target.startsWith(rootWithSep)) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) target = path.join(target, "index.html");
  else if (info && !info.isFile()) return null;
  return target;
}

createServer(async (req, res) => {
  const target = await resolveTarget(new URL(req.url, "http://localhost").pathname);
  if (!target) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("403 越出仓库根目录");
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 未找到：${path.relative(ROOT, target)}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`静态服务器已启动（Ctrl+C 停止）`);
  console.log(`  P01 认知工具箱: http://127.0.0.1:${PORT}/projects/P01-区块链认知工具箱基础/frontend/`);
  console.log(`  仓库根目录:    ${ROOT}`);
});
