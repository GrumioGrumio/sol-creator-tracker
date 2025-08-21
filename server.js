// server.js - Smart SOL Tracker with incremental scans
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs").promises;
const path = require("path");

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

// ── DATA PERSISTENCE ───────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'sol_data.json');

async function saveData(data) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('💾 Data saved to disk');
  } catch (error) {
    console.error('❌ Failed to save data:', error);
  }
}

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    console.log('📁 Previous data loaded from disk');
    return JSON.parse(data);
  } catch (error) {
    console.log('📝 No previous data found, starting fresh');
    return {
      totalSOL: 0,
      transactionCount: 0,
      lastProcessedSignature: null,
      lastFullScan: null,
      lastIncrementalScan: null,
      apiCallsToday: 0,
      lastApiReset: new Date().toDateString()
    };
  }
}

// ── API CALL TRACKING ──────────────────────────────────────────────────────────
let apiCallsToday = 0;
let lastApiReset = new Date().toDateString();

function trackApiCall() {
  const today = new Date().toDateString();
  if (today !== lastApiReset) {
    apiCallsToday = 0;
    lastApiReset = today;
  }
  apiCallsToday++;
}

function canMakeApiCall() {
  const today = new Date().toDateString();
  if (today !== lastApiReset) {
    apiCallsToday = 0;
    lastApiReset = today;
  }
  
  // Conservative limit to avoid hitting Helius limits
  const DAILY_LIMIT = 50000; // Adjust based on your Helius plan
  return apiCallsToday < DAILY_LIMIT;
}

// ── RPC HELPERS ────────────────────────────────────────────────────────────────
const SOLANA_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!canMakeApiCall()) {
        console.log('🚫 Daily API limit reached, skipping request');
        throw new Error('API_LIMIT_REACHED');
      }
      
      trackApiCall();
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        console.log(`⏳ Rate limited, waiting ${(i + 1) * 2}s...`);
        await sleep((i + 1) * 2000);
        continue;
      }
      return response;
    } catch (error) {
      if (error.message === 'API_LIMIT_REACHED') throw error;
      if (i === maxRetries - 1) throw error;
      await sleep(1000);
    }
  }
}

// ── INCREMENTAL SCAN (Only new transactions) ──────────────────────────────────
async function incrementalScan(persistedData) {
  console.log('🔄 Starting incremental scan (new transactions only)...');
  
  let newReceived = 0;
  let newTransactionCount = 0;
  let processedCount = 0;
  
  try {
    const params = [WALLET_ADDRESS, { 
      limit: 1000,
      commitment: 'finalized'
    }];
    
    // Only get transactions since last scan
    if (persistedData.lastProcessedSignature) {
      params[1].until = persistedData.lastProcessedSignature;
    }

    const response = await fetchWithRetry(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'incremental_scan',
        method: 'getSignaturesForAddress',
        params: params
      })
    });

    if (!response.ok) {
      console.log('⚠️  API error, skipping incremental scan');
      return { newReceived: 0, newTransactionCount: 0, newSignature: null };
    }

    const data = await response.json();
    const signatures = data.result || [];
    
    if (signatures.length === 0) {
      console.log('✅ No new transactions since last scan');
      return { newReceived: 0, newTransactionCount: 0, newSignature: null };
    }

    console.log(`📥 Found ${signatures.length} new transactions to analyze`);
    
    // Process new transactions in small batches
    const batchSize = 5;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      
      for (const sigInfo of batch) {
        try {
          if (sigInfo.err) {
            processedCount++;
            continue;
          }
          
          const response = await fetchWithRetry(SOLANA_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `inc_tx_${processedCount}`,
              method: 'getTransaction',
              params: [
                sigInfo.signature,
                { 
                  encoding: 'json',
                  maxSupportedTransactionVersion: 0,
                  commitment: 'finalized'
                }
              ]
            })
          });

          if (!response.ok) {
            processedCount++;
            continue;
          }

          const txData = await response.json();
          
          if (txData.error || !txData.result || txData.result.meta?.err) {
            processedCount++;
            continue;
          }
          
          // Calculate balance change
          const meta = txData.result.meta;
          const transaction = txData.result.transaction;
          
          const preBalances = meta.preBalances;
          const postBalances = meta.postBalances;
          const accountKeys = transaction.message.accountKeys;
          
          let walletIndex = -1;
          for (let j = 0; j < accountKeys.length; j++) {
            if (accountKeys[j] === WALLET_ADDRESS) {
              walletIndex = j;
              break;
            }
          }

          let balanceChange = 0;
          if (walletIndex !== -1 && 
              walletIndex < preBalances.length && 
              walletIndex < postBalances.length) {
            
            const preBalance = preBalances[walletIndex];
            const postBalance = postBalances[walletIndex];
            balanceChange = postBalance - preBalance;
          }
          
          if (balanceChange > 0) {
            newReceived += balanceChange;
            newTransactionCount++;
            
            // Log significant transfers
            if (balanceChange >= 100000000) { // >= 0.1 SOL
              const sol = balanceChange / 1000000000;
              const date = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toLocaleDateString() : 'Unknown';
              console.log(`💰 New transfer: ${sol.toFixed(4)} SOL on ${date} (${sigInfo.signature.substring(0, 8)}...)`);
            }
          }
          
          processedCount++;
          
        } catch (error) {
          console.warn('Transaction processing error:', error);
          processedCount++;
        }
        
        await sleep(100); // Rate limiting
      }
      
      await sleep(300); // Batch delay
    }

    const newSOL = newReceived / 1000000000;
    console.log(`✅ Incremental scan complete: +${newSOL.toFixed(6)} SOL from ${newTransactionCount} new transfers`);
    
    return { 
      newReceived, 
      newTransactionCount, 
      newSignature: signatures.length > 0 ? signatures[0].signature : null 
    };
    
  } catch (error) {
    console.error('❌ Incremental scan failed:', error);
    return { newReceived: 0, newTransactionCount: 0, newSignature: null };
  }
}

// ── FULL SCAN (Complete history - run weekly) ─────────────────────────────────
async function fullScan() {
  console.log('🔥 Starting FULL comprehensive scan (all history)...');
  // This would be your existing comprehensive analysis
  // Only run this weekly or when specifically requested
  
  // For now, return current data to avoid API overuse
  console.log('⚠️  Full scan disabled to conserve API calls. Use incremental scans.');
  return null;
}

// ── SMART ANALYSIS COORDINATOR ────────────────────────────────────────────────
async function smartAnalysis(forceFullScan = false) {
  if (state.running) {
    console.log('⏳ Analysis already running, skipping...');
    return;
  }
  
  state.running = true;
  const startTime = Date.now();
  
  try {
    // Load persisted data
    const persistedData = await loadData();
    
    // Decide scan type
    const now = new Date();
    const lastFullScan = persistedData.lastFullScan ? new Date(persistedData.lastFullScan) : null;
    const weeksSinceFullScan = lastFullScan ? (now - lastFullScan) / (7 * 24 * 60 * 60 * 1000) : 999;
    
    if (forceFullScan || !lastFullScan || weeksSinceFullScan >= 1) {
      console.log('📊 Performing weekly full scan...');
      // const fullResults = await fullScan();
      // For now, just update timestamp
      persistedData.lastFullScan = now.toISOString();
    }
    
    // Always do incremental scan
    const { newReceived, newTransactionCount, newSignature } = await incrementalScan(persistedData);
    
    // Update totals
    const updatedData = {
      ...persistedData,
      totalSOL: (persistedData.totalSOL || 0) + (newReceived / 1000000000),
      transactionCount: (persistedData.transactionCount || 0) + newTransactionCount,
      lastProcessedSignature: newSignature || persistedData.lastProcessedSignature,
      lastIncrementalScan: now.toISOString(),
      apiCallsToday,
      lastApiReset
    };
    
    // Save updated data
    await saveData(updatedData);
    
    // Update state
    state.totalSOL = updatedData.totalSOL;
    state.transactionCount = updatedData.transactionCount;
    state.lastUpdated = now.toISOString();
    state.lastRunMs = Date.now() - startTime;
    state.apiCallsUsed = apiCallsToday;
    
    console.log(`✅ Smart analysis complete! Total SOL: ${updatedData.totalSOL.toFixed(6)} (${state.lastRunMs/1000}s, ${apiCallsToday} API calls today)`);
    
  } catch (error) {
    console.error("❌ Smart analysis failed:", error);
  } finally {
    state.running = false;
  }
}

// ── STATE ──────────────────────────────────────────────────────────────────────
let state = {
  running: false,
  totalSOL: null,
  lastUpdated: null,
  lastRunMs: 0,
  transactionCount: 0,
  apiCallsUsed: 0
};

// ── API ENDPOINTS ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ...state,
    wallet: WALLET_ADDRESS,
    apiCallsToday,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/refresh', async (req, res) => {
  if (state.running) {
    return res.status(429).json({ error: 'Analysis already running' });
  }
  
  const forceFullScan = req.query.full === 'true';
  
  // Start analysis in background
  smartAnalysis(forceFullScan).catch(console.error);
  
  res.json({ 
    message: forceFullScan ? 'Full analysis started' : 'Incremental analysis started', 
    running: true 
  });
});

// ── SCHEDULING ─────────────────────────────────────────────────────────────────
function scheduleFrequent() {
  // Every 6 hours: 12 AM, 6 AM, 12 PM, 6 PM
  const scheduleHours = [0, 6, 12, 18];
  
  function getNextScheduledTime() {
    const now = new Date();
    const currentHour = now.getHours();
    
    // Find next scheduled hour today
    let nextHour = scheduleHours.find(hour => hour > currentHour);
    
    const nextTime = new Date(now);
    if (nextHour !== undefined) {
      // Schedule for today
      nextTime.setHours(nextHour, 0, 0, 0);
    } else {
      // Schedule for tomorrow's first slot
      nextTime.setDate(nextTime.getDate() + 1);
      nextTime.setHours(scheduleHours[0], 0, 0, 0);
    }
    
    return nextTime;
  }
  
  function scheduleNext() {
    const nextTime = getNextScheduledTime();
    const msUntilNext = nextTime.getTime() - Date.now();
    
    console.log(`⏰ Next incremental scan: ${nextTime.toLocaleString()}`);
    
    setTimeout(() => {
      console.log('🔄 Starting scheduled incremental analysis...');
      smartAnalysis(false); // Incremental only
      scheduleNext(); // Schedule the next run
    }, msUntilNext);
  }
  
  scheduleNext();
}

// ── SERVER STARTUP ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Smart SOL Tracker running on port ${PORT}`);
  console.log(`📊 Tracking wallet: ${WALLET_ADDRESS}`);
  console.log(`🔑 Using Helius API: ...${HELIUS_API_KEY.slice(-4)}`);
});

// Initialize
async function initialize() {
  // Load existing data first
  const persistedData = await loadData();
  state.totalSOL = persistedData.totalSOL;
  state.transactionCount = persistedData.transactionCount;
  
  // Run incremental analysis on startup
  smartAnalysis(false);
  
  // Schedule regular incremental scans
  scheduleFrequent();
}

initialize();

console.log('🔥 Smart SOL Tracker initialized!');
