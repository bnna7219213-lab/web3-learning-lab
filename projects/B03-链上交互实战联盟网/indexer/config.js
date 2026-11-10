// b03-indexer 配置：全部走环境变量，缺省值面向本机单机部署
module.exports = {
  // 扫链目标：nginx upstream 池 8551–8554，直连 8551 即可
  RPC: process.env.RPC || "http://127.0.0.1:8551",
  CHAIN_ID: 19880601,
  // SQLite 落盘位置（systemd 里 WorkingDirectory 指向 /opt/b03-indexer）
  DB_PATH: process.env.DB_PATH || "/opt/b03-indexer/data/index.db",
  // 扫块批：每批 20 块单事务写入；追平链头后 sleep 300ms 背压
  BATCH: Number(process.env.BATCH || 20),
  IDLE_MS: Number(process.env.IDLE_MS || 300),
  // 失败退避，不推进游标
  RETRY_MS: Number(process.env.RETRY_MS || 5000),
  // 查询 API 监听（nginx /b03-api/ 反代到此，同源无 CORS）
  API_PORT: Number(process.env.API_PORT || 8570),
  API_HOST: process.env.API_HOST || "127.0.0.1",
  // 多节点探针目标：nginx 轮询池无法定点查单台，一致性核验必须逐节点问
  NODES: (process.env.NODES || "http://127.0.0.1:8551,http://127.0.0.1:8552,http://127.0.0.1:8553,http://127.0.0.1:8554")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // genesis 里的验证者总数（不是"在跑的台数"）。在线数与它的差额就是容错余量，
  // 页面必须两个都显示——只写 4 会在只剩 3 台时误导排障（2026-10-16 踩过）。
  VALIDATORS_EXPECTED: Number(process.env.VALIDATORS_EXPECTED || 4),
  // 出证锚点：根写进一笔 value=0、gasPrice=0 的旧式交易的 input 里，收款地址用这个。
  // 默认用 0x…0000 这个无人持有的地址——联盟链上成员固定、可审计，input 里的根本身就是
  // 承诺；将来要"任何人可查且签发方不可抵赖"时换成 IEvidenceRegistry 合约（M4 链上部分）。
  ANCHOR_REGISTRY: process.env.ANCHOR_REGISTRY || "0x000000000000000000000000000000000000E51D",
  // 签发密钥目录：API 只从这里读 **publicKeyPem** 用于验签。
  // 私钥也在同一个文件里（600 权限），但验签路径绝不把它读进内存之外的地方。
  EVIDENCE_KEYS_DIR: process.env.EVIDENCE_KEYS || "/opt/b03-evidence-keys",
  // 对外访问地址。2026-10-19：IP 直连已在 nginx 层关闭（default_server 返回 444），
  // 只认 <your-domain.example>；并按"默认 https"配置。写 IP 会让出证包和页面链接指向打不开的地址。
  // ⚠ 前提：阿里云**安全组**需放行 443（实例内 firewalld 已放行，但安全组是外层另一套）。
  //   安全组没开之前，这里生成的 https 链接只有服务器本机能访问——
  //   给客户出证之前务必先确认 `curl -s https://<your-domain.example>/b03/` 从外网能通。
  PUBLIC_BASE: process.env.PUBLIC_BASE || "https://<your-domain.example>",
  // 出证确认数策略下限（验证方持有，不信包内声明）。QBFT 单块终结，理论上 1 个确认即最终；
  // 但"终结"的前提是锚定交易被 ≥quorum 验证者签过且我们看到的各节点一致，
  // 留 2 个确认是为了避开锚点后紧跟一次重启的边界。对客交付时按合同调。
  MIN_CONFIRMATIONS: Number(process.env.MIN_CONFIRMATIONS || 2),
  // 看门狗状态文件：watchdog.js 每轮写，API 只读出来给浏览器显示"最近一次体检"。
  WATCHDOG_STATE: process.env.WATCHDOG_STATE || "/var/lib/b03-watchdog/state.json",
};
