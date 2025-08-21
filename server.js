// server.js
const express = require("express");
const cors = require("cors");
const compression = require("compression");

// ── ENV ────────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const PORT = process.env.PORT || 3000;

if (!HELIUS_API_KEY) console.warn("⚠️  Missing HELIUS_API_KEY env var");
if (!WALLET_ADDRESS) console.warn("⚠️  Missing WALLET_ADDRESS env var");

// ── APP ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(compression());

// (Optional) serve your static site if you keep it in /public
// app.use(express.static("public"));

// ── GROSS-INBOUND CALC (Helius Enhanced Tx API) ───────────────────────────────
const BASE = "https://api.helius.xyz/v0/addresses";
const PAGE_LIMIT = 1000;           // Helius page size
const MAX_PAGES = 50000;           // safety cap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sumGrossInboundSOL() {
  let totalLamports = 0n;
  let before;         // pagination cursor (signature of last tx on a page)
  let pages = 0;

  while (pages < MAX_PAGES) {
    const url =
      `${BASE}/${WALLET_ADDRESS}/transactions?api-key=${HELIUS_API_KEY}` +
      `&limit=${PAGE_LIMIT}${before ? `&before=${before}` : ""}`;

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) { await sleep(1000); continue; }
      throw new Error(`Helius HTTP ${res.status}`);
    }
    const txs = await res.json();
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      // Newer Helius: tx.events.nativeTransfers ; older: tx.nativeTransfers
      const nativeTransfers =
        (tx.events && tx.events.nativeTransfers) || tx.nativeTransfers || [];

      for (const nt of nativeTransfers) {
        const to = nt.toUserAccount || nt.to;
        const amt = nt.amount ?? 0;
        if (to === WALLET_ADDRESS) totalLamports += BigInt(amt);
      }
    }

    pages += 1;
    before = txs[txs.length - 1].signature;
    if (txs.length < PAGE_LIMIT) break;

    // Gentle pacing to avoid rate limits
    await sleep(60);
  }

  return Number(totalLamports) / 1e9; // convert lamports → SOL
}

// ── STATE + SCHEDULING ────────────────────────────────────────────────────────
let state = {
  running: false,
  totalSOL: null,
  lastUpdated: null,
  lastRunMs: 0
};

async function runAnalysis() {
  if (state.running) return;
  state.running = true;
  const t0 = Date.now();

  try {
    console.log("▶️  Starting gross-inbound analysis for", WALLET_ADDRESS);
    const totalSOL = await sumGrossInboundSOL();
    state.totalSOL = totalSOL;
    state.lastUpdated = new Date().toISOString();
    state.lastRunMs = Date.now() - t0;
    console.log(
      `✅ Done. Gross inbound SOL: ${totalSOL.toFixed(2)} (took ${Math.round(state.lastRunMs/1000)}s)`
    );
  } catch (e) {
    console.error("❌ Analysis failed:", e);
  } finally {
    state.running = false;
  }
}

// Run once on boot
runAnalysis();

// Schedule 6:30 AM & 6:30 PM Eastern
function scheduleAt(hours, minutes, tz = "America/New_York") {
  cons
