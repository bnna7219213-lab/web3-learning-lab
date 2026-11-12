import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// ABI 与部署记录在 frontend/ 之外（abi/、deployments/）：fs.allow 放开到仓库根，
// 让「ABI 自动下发」成立——前端 import 的是 deploy.sh 刚导出的那份，不是手抄副本。
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    fs: { allow: [path.resolve(process.cwd(), "../..")] },
  },
});