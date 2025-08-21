// server.js
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY; // set this in Railway → Variables
const DEFAULT_WALLET = process.env.DEFAULT_WALLET || "DHUTZmXkySi4GRFP1nd4Js7CrN7fUbQHJUgLtor6Rubq";
const PORT = process.env.PORT || 3000;

if (!HELIUS_API_KEY) {
  console.error("Missing HELIUS_API_KEY env var");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const app = express();
app.use(helmet());
app.use(cors());

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpc(method, params, id = 1, attempt = 0) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  // Retry on 429 / 5xx lightly
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 4) {
      await sleep(500 * (attempt + 1));
      return rpc(method, params, id, attempt + 1);
    }
  }
  const data = await res.json();
  if (data.error) throw Object.assign(new Error(data.error.message || "RPC error"), { code: data.error.code, data });
  return data.result;
}

// Sum all System Program transfers that DEPOSIT into `wallet` (outer + inner)
function sumSystemTransfersToWallet(tx, wallet) {
  let gross = 0n;
  const grab = (ix) => {
    const p = ix?.parsed;
    if (p?.type === "transfer" && p?.info?.destination === wallet && p?.info?.lamports != null) {
      // Ignore self-to-self sends if you want only deposits from others:
      if (p?.info?.source === wallet) return;
      gross += BigInt(p.info.lamports);
    }
  };
  for (const ix of (tx.transaction?.message?.instructions || [])) grab(ix);
  for (const inner of (tx.meta?.innerInstructions || [])) {
    for (const ix of (inner.instructions || [])) grab(ix);
  }
  return gross;
}

function lamportsToSOLString(n) {
  let x = BigInt(n);
  const neg = x < 0n;
  if (neg) x = -x;
  const LAMPORTS = 1_000_000_000n;
  const whole = x / LAMPORTS;
  const frac = (x % LAMPORTS).toString().padStart(9, "0").replace(/0+$/,"");
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return (neg ? "-" : "") + s + " SOL";
}

// Paginate the full history (or capped by maxPages)
async function getSignaturesForAddressFull(address, { commitment = "finalized", maxPages = 25, full = false }) {
  const all = [];
  let before = undefined;
  for (let page = 0; page < (full ? 10_000 : maxPages); page++) {
    const params = [address, { limit: 1000, commitment }];
    if (before) params[1].before = before;
    const batch = await rpc("getSignaturesForAddress", params, page + 1);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    await sleep(30); // be polite to RPC
  }
  return all;
}

async function computeGrossDeposits(wallet, { commitment = "finalized", maxPages = 25, full = false }) {
  const sigs = await getSignaturesForAddressFull(wallet, { commitment, maxPages, full });
  let gross = 0n;
  let scanned = 0;

  // light concurrency
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    for (;;) {
      const item = sigs[i++];
      if (!item) break;
      if (item.err) continue;
      const tx = await rpc("getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment }], 1000 + i);
      if (tx) {
        gross += sumSystemTransfersToWallet(tx, wallet);
        scanned++;
      }
      if (i % 100 === 0) await sleep(10);
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));

  const first = sigs[sigs.length - 1]?.blockTime ? new Date(sigs[sigs.length - 1].blockTime * 1000).toISOString() : null;
  const last  = sigs[0]?.blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null;

  return {
    wallet,
    metric: "gross_deposits",
    lamports: gross.toString(),
    formattedSOL: lamportsToSOLString(gross),
    transactionsScanned: scanned,
    pagesScanned: Math.ceil(sigs.length / 1000),
    firstTxTime: first,
    lastTxTime: last,
    lastUpdated: new Date().toISOString()
  };
}

// JSON API
app.get("/api/sol-data", async (req, res) => {
  try {
    const wallet = (req.query.wallet || DEFAULT_WALLET).trim();
    const maxPages = Number(req.query.maxPages || 25);
    const full = req.query.full === "true";   // full history scan
    const stats = await computeGrossDeposits(wallet, { maxPages, full });
    res.set("Cache-Control", "public, max-age=60"); // 60s
    res.json(stats);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed", message: e.message });
  }
});

// SVG Badge (easy to embed)
app.get("/badge.svg", async (req, res) => {
  try {
    const wallet = (req.query.wallet || DEFAULT_WALLET).trim();
    const maxPages = Number(req.query.maxPages || 25);
    const full = req.query.full === "true";
    const stats = await computeGrossDeposits(wallet, { maxPages, full });
    res.type("image/svg+xml");
    res.set("Cache-Control", "public, max-age=60");
    res.send(`
<svg xmlns="http://www.w3.org/2000/svg" width="460" height="120">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1115"/>
      <stop offset="1" stop-color="#1a1f29"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="12" fill="url(#g)"/>
  <text x="24" y="46" fill="#f9cd4f" font-family="Montserrat, sans-serif" font-size="16">Total SOL Deposited (lifetime)</text>
  <text x="24" y="88" fill="#f9cd4f" font-family="Montserrat, sans-serif" font-size="34" font-weight="800">${stats.formattedSOL}</text>
</svg>`);
  } catch (e) {
    res.type("image/svg+xml").status(500).send(`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="100"><text x="10" y="60" fill="red">Error: ${String(e.message || e)}</text></svg>`);
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log(`listening on :${PORT}`));
