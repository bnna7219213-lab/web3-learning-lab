// tools/probe-rpc.mjs —— 探测本机联盟链节点与项目服务端口是否存活
const PORTS = [8551, 8552, 8553, 8554, 8545, 8802, 8570, 8560, 8580];
const BODY = JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 });

async function probe(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
      signal: ctrl.signal,
    });
    const j = await res.json();
    return `${port} -> UP block=${j.result ?? JSON.stringify(j)}`;
  } catch (e) {
    return `${port} -> DOWN (${e.name})`;
  } finally {
    clearTimeout(t);
  }
}

for (const p of PORTS) {
  console.log(await probe(p));
}
