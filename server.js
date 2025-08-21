// server.js
// Lifetime gross SOL received counter with full v0 (loaded addresses) support.

const express = require("express");
const path = require("path");

// --- Config (from Railway env) ---
const WALLET = process.env.WALLET_ADDRESS || "DHUTZmXkySi4GRFP1nd4Js7CrN7fUbQHJUgLtor6Rubq";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
let RPC_URL = process.env.HELIUS_RPC_URL || "";
if (!RPC_URL && HELIUS_API_KEY) {
  RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
}
if (!RPC_URL) {
  console.error("Missing Helius RPC URL. Set HELIUS_RPC_URL or HELIUS_API_KEY.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// -------- Helpers --------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAMPORTS_PER_SOL = 1_000_000_000;

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random()*1e9), method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} error: ${body.error.message || body.error.code}`);
  return body.result;
}

// Pull all signatures for the address (paged by `before`)
async function getAllSignatures(address) {
  let all = [];
  let before = null;

  while (true) {
    const params = [address, { limit: 1000, commitment: "finalized" }];
    if (before) params[1].before = before;

    const batch = await rpc("getSignaturesForAddress", params);
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);
    before = batch[batch.length - 1].signature;

    // polite pacing to avoid rate limits
    await sleep(40);

    // Safety: if some RPC ever misbehaves and loops, bail out after a huge number
    if (all.length > 1_000_000) break;
  }
  return all;
}

// Find wallet index across *static* keys + *loaded addresses* (v0)
function findWalletIndex(tx) {
  const staticKeys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === "string" ? k : k.pubkey));
  const loadedW = tx.meta?.loadedAddresses?.writable ?? [];
  const loadedR = tx.meta?.loadedAddresses?.readonly ?? [];
  const full = [...staticKeys, ...loadedW, ...loadedR];
  const idx = full.findIndex(k => k === WALLET);
  return { idx, fullLen: full.length };
}

// Compute gross inbound lamports for our wallet from a single tx
function inboundLamportsForWallet(tx) {
  if (!tx?.meta || tx.meta.err) return 0;

  const pre = tx.meta.preBalances || [];
  const post = tx.meta.postBalances || [];

  const { idx, fullLen } = findWalletIndex(tx);
  if (idx < 0) return 0;                 // wallet not present
  if (idx >= pre.length || idx >= post.length) {
    // In theory, pre/post align with (static+loaded) accounts.
    // If something is off, just skip this tx.
    return 0;
  }

  const delta = (post[idx] ?? 0) - (pre[idx] ?? 0);
  return delta > 0 ? delta : 0;          // count ONLY inbound (gross-in)
}

// Batch-get transactions and sum inbound lamports
async function sumInboundForSignatures(sigs) {
  let totalIn = 0;
  let processed = 0;
  let earliest = null;
  let latest = null;

  // small concurrency to be gentle on rate limits
  const CONCURRENCY = 6;
  const queue = [...sigs];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const tx = await rpc("getTransaction", [
          item.signature,
          {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            commitment: "finalized"
          }
        ]);

        if (tx?.blockTime) {
          const d = new Date(tx.blockTime * 1000);
          if (!earliest || d < earliest) earliest = d;
          if (!latest || d > latest) latest = d;
        }

        totalIn += inboundLamportsForWallet(tx);
      } catch (e) {
        // best-effort; skip on errors, continue
      } finally {
        processed++;
        if (processed % 200 === 0) await sleep(60); // tiny breather every 200
      }
    }
  });

  await Promise.all(workers);

  return {
    lamportsIn: totalIn,
    scanned: processed,
    earliest,
    latest
  };
}

// -------- In-memory cache for frontend --------
let CACHE = {
  totalSOL: 0,
  formattedSOL: "—",
  lastUpdated: null,
  scanned: 0,
  earliest: null,
  latest: null
};

async function refreshNow() {
  console.log("🔎 Starting full lifetime scan for", WALLET);

  const signatures = await getAllSignatures(WALLET);
  console.log(`• Signatures discovered: ${signatures.length}`);

  const { lamportsIn, scanned, earliest, latest } = await sumInboundForSignatures(signatures);

  const sol = lamportsIn / LAMPORTS_PER_SOL;

  CACHE = {
    totalSOL: sol,
    formattedSOL: `${sol.toFixed(2)} SOL`,
    lastUpdated: new Date().toISOString(),
    scanned,
    earliest: earliest ? earliest.toISOString() : null,
    latest: latest ? latest.toISOString() : null
  };
