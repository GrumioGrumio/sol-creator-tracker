// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.warn("⚠️ HELIUS_API_KEY is not set. Set it in Railway → Variables.");
}

const HELIUS_BASE = "https://api.helius.xyz/v0";
const LAMPORTS_PER_SOL = 1_000_000_000n;

// simple in-memory cache to avoid re-scanning on every hit
const cache = new Map(); // key: `${wallet}|${excludeSelf}`, value: { totalLamports, txCount, from, to, at }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function fmtSOL(lamportsBigInt) {
  const sign = lamportsBigInt < 0 ? "-" : "";
  const n = lamportsBigInt < 0 ? -lamportsBigInt : lamportsBigInt;
  const whole = n / LAMPORTS_PER_SOL;
  const frac = n % LAMPORTS_PER_SOL;
  const fracStr = (frac + "").padStart(9, "0").slice(0, 2); // 2 decimals
  return `${sign}${whole}.${fracStr} SOL`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch *enriched* transactions from Helius and sum native lamports
 * sent *to* the target wallet (lifetime).
 *
 * - Handles legacy + v0 txs
 * - Includes inner transfers
 * - Paginates until history ends
 * - Optionally excludes "self" sends (from === to)
 */
async function totalInboundLamports(wallet, { excludeSelf = false } = {}) {
  const cacheKey = `${wallet}|${excludeSelf ? 1 : 0}`;
  const hit = cache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit;
  }

  let before = undefined;
  let pages = 0;
  let total = 0n;
  let txCount = 0;
  let firstTs = null;
  let lastTs = null;

  // Helius returns up to 200 per page; we’ll walk back with `before` (signature)
  while (true) {
    const url = new URL(`${HELIUS_BASE}/addresses/${wallet}/transactions`);
    url.searchParams.set("api-key", API_KEY);
    url.searchParams.set("limit", "200");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url, { method: "GET" });
    if (res.status === 429) {
      // rate limit – back off gently
      await sleep(1200);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Helius error ${res.status}: ${text}`);
    }

    /** @type {Array<any>} */
    const batch = await res.json();

    if (!Array.isArray(batch) || batch.length === 0) break;
    pages += 1;

    // Sum all nativeTransfers that land in `wallet`
    for (const tx of batch) {
      txCount += 1;

      // unified enriched shape: either top-level `nativeTransfers`
      // or nested under `events.nativeTransfers` depending on API version
      const transfers =
        tx.nativeTransfers ??
        (tx.events && tx.events.nativeTransfers) ??
        [];

      for (const t of transfers) {
        const to = (t.toUserAccount || "").trim();
        const from = (t.fromUserAccount || "").trim();
        if (to === wallet) {
          if (excludeSelf && from === wallet) continue; // optional: skip self → self
          const amt = BigInt(Math.trunc(Number(t.amount || 0)));
          if (amt > 0) total += amt;
        }
      }

      // gather rough date range (unix ms assumed; Helius `timestamp` is seconds)
      const tsSec = tx.timestamp ?? tx.blockTime;
      if (typeof tsSec === "number") {
        const tsMs = tsSec < 1e12 ? tsSec * 1000 : tsSec;
        if (!firstTs || tsMs < firstTs) firstTs = tsMs;
        if (!lastTs || tsMs > lastTs) lastTs = tsMs;
      }
    }

    before = batch[batch.length - 1]?.signature;
    if (!before || batch.length < 200) break;

    // minor throttle to be nice to the API
    await sleep(50);
  }

  const payload = {
    wallet,
    totalLamports: total.toString(),
    formattedSOL: fmtSOL(total),
    transactionsScanned: txCount,
    from: firstTs ? new Date(firstTs).toISOString() : null,
    to: lastTs ? new Date(lastTs).toISOString() : null,
    lastUpdated: new Date().toISOString(),
    excludeSelf,
  };

  cache.set(cacheKey, { ...payload, at: now });
  return payload;
}

// JSON API (compatible name with your front-end)
app.get("/api/sol-data", async (req, res) => {
  try {
    const wallet =
      (req.query.wallet || process.env.DEFAULT_WALLET || "").toString().trim();
    if (!wallet) {
      return res.status(400).json({ error: "Missing ?wallet=address" });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: "Missing HELIUS_API_KEY" });
    }
    const excludeSelf = String(req.query.excludeSelf || "").toLowerCase() === "true";

    const data = await totalInboundLamports(wallet, { excludeSelf });
    res.json(data);
  } catch (err) {
    console.error("API /api/sol-data error:", err);
    res.status(500).json({ error: "Internal error", detail: String(err) });
  }
});

// Simple SVG badge you can embed
app.get("/badge.svg", async (req, res) => {
  try {
    const wallet =
      (req.query.wallet || process.env.DEFAULT_WALLET || "").toString().trim();
    if (!wallet) {
      res.status(400).type("text/plain").send("Missing ?wallet=address");
      return;
    }
    const excludeSelf = String(req.query.excludeSelf || "").toLowerCase() === "true";
    const { formattedSOL } = await totalInboundLamports(wallet, { excludeSelf });

    const label = "Lifetime SOL In";
    const value = formattedSOL.replace(" SOL", "");
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="60" role="img" aria-label="${label}: ${value} SOL">
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#444" stop-opacity=".2"/>
    <stop offset="1" stop-opacity=".2"/>
  </linearGradient>
  <rect rx="10" width="420" height="60" fill="#111"/>
  <rect rx="10" x="0" y="0" width="420" height="60" fill="url(#g)"/>
  <text x="20" y="38" fill="#f9cd4f" font-family="Montserrat, Arial, sans-serif" font-size="18" font-weight="600">${label}</text>
  <text x="400" y="38" fill="#fff" font-family="Montserrat, Arial, sans-serif" font-size="22" font-weight="800" text-anchor="end">${value} SOL</text>
</svg>`.trim();

    res.setHeader("Cache-Control", "no-store");
    res.type("image/svg+xml").send(svg);
  } catch (err) {
    console.error("SVG badge error:", err);
    res.status(500).type("text/plain").send("badge error");
  }
});

app.get("/", (_req, res) =>
  res.type("text/plain").send("OK – use /api/sol-data?wallet=... or /badge.svg?wallet=...")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
