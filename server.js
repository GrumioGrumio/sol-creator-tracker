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

// ── COMPREHENSIVE SOL ANALYSIS (RPC-based like frontend) ──────────────────────
const SOLANA_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        console.log(`Rate limited, waiting ${(i + 1) * 2}s...`);
        await sleep((i + 1) * 2000);
        continue;
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(1000);
    }
  }
}

async function comprehensiveSOLAnalysis() {
  console.log('🔥 Starting comprehensive SOL analysis...');
  
  let totalReceived = 0;
  let transactionCount = 0;
  let allSignatures = [];
  let before = null;
  let hasMore = true;
  let pageCount = 0;
  const MAX_PAGES = 1000; // Reasonable limit
  
  // Phase 1: Get all transaction signatures
  console.log('📥 Phase 1: Fetching transaction signatures...');
  
  while (hasMore && pageCount < MAX_PAGES) {
    try {
      const params = [WALLET_ADDRESS, { 
        limit: 1000,
        commitment: 'finalized'
      }];
      if (before) {
        params[1].before = before;
      }

      const response = await fetchWithRetry(SOLANA_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: pageCount + 1,
          method: 'getSignaturesForAddress',
          params: params
        })
      });

      if (!response.ok) {
        console.warn(`HTTP ${response.status} on signature page ${pageCount + 1}`);
        await sleep(2000);
        continue;
      }

      const data = await response.json();
      
      if (data.error) {
        console.warn(`API Error on signature page ${pageCount + 1}:`, data.error);
        if (data.error.code === 429) {
          await sleep(3000);
          continue;
        }
        break;
      }

      const signatures = data.result || [];
      
      if (signatures.length === 0) {
        console.log('✅ Reached end of transaction history');
        hasMore = false;
      } else {
        allSignatures.push(...signatures);
        before = signatures[signatures.length - 1].signature;
        pageCount++;
        
        if (pageCount % 10 === 0) {
          console.log(`📄 Processed ${pageCount} signature pages, ${allSignatures.length} total signatures`);
        }
        
        if (signatures.length < 1000) {
          console.log(`✅ Reached end: ${signatures.length} signatures on final page`);
          hasMore = false;
        }
      }

      await sleep(100); // Gentle rate limiting
      
    } catch (error) {
      console.warn(`Error on signature page ${pageCount + 1}:`, error);
      await sleep(2000);
      pageCount++;
    }
  }

  console.log(`📊 Phase 1 Complete: ${allSignatures.length} signatures collected from ${pageCount} pages`);

  // Phase 2: Analyze each transaction for SOL changes
  console.log('🔍 Phase 2: Analyzing transactions for SOL transfers...');
  
  let processedCount = 0;
  let errorCount = 0;
  const batchSize = 10;
  
  for (let i = 0; i < allSignatures.length; i += batchSize) {
    const batch = allSignatures.slice(i, i + batchSize);
    
    // Process batch in parallel for speed
    const batchPromises = batch.map(async (sigInfo) => {
      try {
        if (sigInfo.err) {
          return { processed: true, received: 0 };
        }
        
        const response = await fetchWithRetry(SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `tx_${processedCount}`,
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
          return { processed: true, received: 0, error: true };
        }

        const txData = await response.json();
        
        if (txData.error || !txData.result || txData.result.meta?.err) {
          return { processed: true, received: 0, error: !!txData.error };
        }
        
        // Calculate balance change for our wallet
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
        
        return { 
          processed: true, 
          received: balanceChange > 0 ? balanceChange : 0,
          signature: sigInfo.signature,
          blockTime: sigInfo.blockTime,
          balanceChange
        };
        
      } catch (error) {
        return { processed: true, received: 0, error: true };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    for (const result of batchResults) {
      processedCount++;
      
      if (result.error) {
        errorCount++;
      } else if (result.received > 0) {
        totalReceived += result.received;
        transactionCount++;
        
        // Log significant transfers
        if (result.received >= 100000000) { // >= 0.1 SOL
          const sol = result.received / 1000000000;
          const date = result.blockTime ? new Date(result.blockTime * 1000).toLocaleDateString() : 'Unknown';
          console.log(`💰 Found transfer: ${sol.toFixed(4)} SOL on ${date} (${result.signature.substring(0, 8)}...)`);
        }
      }
    }
    
    // Progress logging
    if (processedCount % 1000 === 0) {
      const progress = Math.round((processedCount / allSignatures.length) * 100);
      const solReceived = totalReceived / 1000000000;
      console.log(`🔄 Progress: ${progress}% (${processedCount}/${allSignatures.length}) - ${solReceived.toFixed(2)} SOL found, ${transactionCount} transfers`);
    }
    
    await sleep(200); // Rate limiting between batches
  }

  const finalSOL = totalReceived / 1000000000;
  
  console.log(`🎉 Analysis Complete!`);
  console.log(`- Total signatures processed: ${processedCount}`);
  console.log(`- Errors encountered: ${errorCount}`);
  console.log(`- Successful transfers found: ${transactionCount}`);
  console.log(`- Total SOL received: ${finalSOL.toFixed(6)} SOL`);
  
  return finalSOL;
}

// ── STATE + CACHING ────────────────────────────────────────────────────────────
let state = {
  running: false,
  totalSOL: null,
  lastUpdated: null,
  lastRunMs: 0,
  transactionCount: 0
};

async function runAnalysis() {
  if (state.running) {
    console.log('⏳ Analysis already running, skipping...');
    return;
  }
  
  state.running = true;
  const startTime = Date.now();
  
  try {
    console.log("🚀 Starting comprehensive SOL analysis for", WALLET_ADDRESS);
    
    const totalSOL = await comprehensiveSOLAnalysis();
    
    state.totalSOL = totalSOL;
    state.lastUpdated = new Date().toISOString();
    state.lastRunMs = Date.now() - startTime;
    
    console.log(`✅ Analysis completed! Total SOL: ${totalSOL.toFixed(6)} (took ${Math.round(state.lastRunMs/1000)}s)`);
    
  } catch (error) {
    console.error("❌ Analysis failed:", error);
  } finally {
    state.running = false;
  }
}

// ── API ENDPOINTS ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ...state,
    wallet: WALLET_ADDRESS,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/refresh', async (req, res) => {
  if (state.running) {
    return res.status(429).json({ error: 'Analysis already running' });
  }
  
  // Start analysis in background
  runAnalysis().catch(console.error);
  
  res.json({ message: 'Analysis started', running: true });
});

// ── SCHEDULING ─────────────────────────────────────────────────────────────────
function scheduleDaily() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(6, 30, 0, 0); // 6:30 AM
  
  const msUntilTomorrow = tomorrow.getTime() - now.getTime();
  
  console.log(`⏰ Next auto-analysis scheduled for: ${tomorrow.toLocaleString()}`);
  
  setTimeout(() => {
    console.log('🔄 Starting scheduled daily analysis...');
    runAnalysis();
    
    // Set up daily interval
    setInterval(() => {
      console.log('🔄 Starting scheduled daily analysis...');
      runAnalysis();
    }, 24 * 60 * 60 * 1000); // Every 24 hours
    
  }, msUntilTomorrow);
}

// ── SERVER STARTUP ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 SOL Tracker Backend running on port ${PORT}`);
  console.log(`📊 Tracking wallet: ${WALLET_ADDRESS}`);
  console.log(`🔑 Using Helius API key: ...${HELIUS_API_KEY.slice(-4)}`);
});

// Run initial analysis
runAnalysis();

// Schedule daily runs
scheduleDaily();

console.log('🔥 SOL Tracker Backend initialized and ready!');
