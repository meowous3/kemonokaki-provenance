// Rebuilds data/transfers.json: every Kemonokaki Transfer log from the last 7 days,
// plus the bytecode kind of every address involved. Incremental: keeps the existing
// file's logs that are still inside the window and only fetches blocks after its toBlock.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const RPC = "https://mainnet.base.org";
const CONTRACT = "0xee7d1b184be8185adc7052635329152a4d0cdefa";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WINDOW = 7 * 24 * 60 * 30; // blocks in 7 days at 2s per block
const RANGE = 2000; // mainnet.base.org eth_getLogs limit
const OUT = new URL("../data/transfers.json", import.meta.url);
const IMAGES = new URL("../images/", import.meta.url);
const IMAGE_CID = "bafybeidxclt74frtmiuiisfquphn2qdukz2cg63cr7bwyblp3mfwr5gk6a";
// ipfs.io, dweb.link and Pinata refuse or rate-limit these; these two served them.
const GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gw.ipfs-lens.dev/ipfs/"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => "0x" + n.toString(16);

async function rpc(body) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    const err = Array.isArray(j) ? j.find(x => x.error)?.error : j?.error;
    if (r.ok && j && !err) return j;
    if (r.status === 429 || r.status >= 500 || err?.code === -32016) { await sleep(500 * 2 ** i); continue; }
    throw new Error(`RPC ${r.status}: ${JSON.stringify(err || j)}`);
  }
  throw new Error("RPC kept rate-limiting");
}
const call = async (method, params) => (await rpc({ jsonrpc: "2.0", id: 1, method, params })).result;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function loadExisting() {
  try {
    const d = JSON.parse(await readFile(OUT, "utf8"));
    return d.contract === CONTRACT && d.version === 1 ? d : null;
  } catch { return null; }
}

const head = await call("eth_getBlockByNumber", ["latest", false]);
const latest = parseInt(head.number, 16);
const latestTime = parseInt(head.timestamp, 16);
const start = latest - WINDOW;

const prev = await loadExisting();
let logs = prev ? prev.logs.filter(l => l[0] >= start) : [];
const kinds = prev ? prev.kinds : {};
const from = prev && prev.toBlock >= start ? prev.toBlock + 1 : start;

const ranges = [];
for (let b = from; b <= latest; b += RANGE) ranges.push([b, Math.min(b + RANGE - 1, latest)]);
console.log(`blocks ${from}..${latest} (${ranges.length} requests), kept ${logs.length} logs`);

const fresh = [];
await pool(ranges, 3, async ([a, z]) => {
  const res = await call("eth_getLogs", [{ address: CONTRACT, fromBlock: hex(a), toBlock: hex(z), topics: [TRANSFER] }]);
  for (const l of res) {
    if (l.topics.length !== 4) continue;
    fresh.push([
      parseInt(l.blockNumber, 16),
      parseInt(l.logIndex, 16),
      BigInt(l.topics[3]).toString(),
      "0x" + l.topics[1].slice(26),
      "0x" + l.topics[2].slice(26),
      l.transactionHash,
    ]);
  }
});
logs = logs.concat(fresh).sort((x, y) => x[0] - y[0] || x[1] - y[1]);

// "c" contract, "e" plain wallet, "7" EIP-7702 delegated wallet.
const unknown = [...new Set(logs.flatMap(l => [l[3], l[4]]))].filter(a => !(a in kinds));
const batches = [];
for (let i = 0; i < unknown.length; i += 10) batches.push(unknown.slice(i, i + 10));
await pool(batches, 3, async chunk => {
  const res = await rpc(chunk.map((a, id) => ({ jsonrpc: "2.0", id, method: "eth_getCode", params: [a, "latest"] })));
  for (const r of res) kinds[chunk[r.id]] = r.result === "0x" ? "e" : r.result.startsWith("0xef0100") ? "7" : "c";
});
const used = new Set(logs.flatMap(l => [l[3], l[4]]));
for (const a of Object.keys(kinds)) if (!used.has(a)) delete kinds[a];

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify({ version: 1, contract: CONTRACT, fromBlock: start, toBlock: latest, toTime: latestTime, logs, kinds }));
console.log(`wrote ${logs.length} logs (${fresh.length} new), ${Object.keys(kinds).length} addresses (${unknown.length} classified)`);

// Mirror the image of every token in the window into images/ so the page never depends on a public gateway.
await mkdir(IMAGES, { recursive: true });
const exists = f => access(new URL(f, IMAGES)).then(() => true, () => false);
const ids = [...new Set(logs.map(l => l[2]))];
const missing = [];
for (const id of ids) if (!(await exists(`${id}.png`)) && !(await exists(`${id}.gif`))) missing.push(id);
let saved = 0;
const failed = [];
await pool(missing, 6, async id => {
  for (const g of GATEWAYS) for (const ext of ["png", "gif"]) {
    try {
      const r = await fetch(`${g}${IMAGE_CID}/${id}.${ext}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      await writeFile(new URL(`${id}.${ext}`, IMAGES), Buffer.from(await r.arrayBuffer()));
      saved++;
      return;
    } catch {}
  }
  failed.push(id);
});
console.log(`images: ${ids.length - missing.length} cached, ${saved} downloaded${failed.length ? `, failed: ${failed.join(" ")}` : ""}`);
