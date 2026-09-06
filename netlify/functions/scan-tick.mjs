// netlify/functions/scan-tick.mjs
//
// POST { wallet: "0x..." }
// -> { wallet, ageDays, firstSeen, transactionCount, contractCount,
//      tickScore, breakdown: {...}, species }
//
// Talks to Blockscout's Robinhood Chain (4663) REST API server-side so the
// API key (if you add one) never touches the browser.

const CHAIN_ID = 4663;
const BLOCKSCOUT_BASE = `https://api.blockscout.com/${CHAIN_ID}/api/v2`;
// Fallback: the self-hosted instance also serves the same v2 REST shape
// without requiring a key. Used if the PRO API call fails or no key is set.
const BLOCKSCOUT_DIRECT_BASE = "https://robinhoodchain.blockscout.com/api/v2";

const MAX_PAGES = 10; // safety cap so one wallet can't hang the function

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch one page, retrying transient 5xx errors a couple of times before
// giving up on that specific page. Blockscout's free/PRO tiers occasionally
// return a bare 500 under load; a short backoff usually clears it.
async function fetchPageWithRetry(url, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      return res.json();
    }
    lastError = new Error(`Blockscout returned HTTP ${res.status}`);
    // Only worth retrying server-side errors / rate limiting, not a bad
    // request or auth failure - those won't fix themselves on retry.
    if (res.status < 500 && res.status !== 429) {
      throw lastError;
    }
    if (attempt < maxAttempts - 1) {
      await sleep(400 * (attempt + 1)); // 400ms, 800ms
    }
  }
  throw lastError;
}

async function fetchAllTransactions(wallet, apiKey) {
  const useDirect = !apiKey;
  const base = useDirect ? BLOCKSCOUT_DIRECT_BASE : BLOCKSCOUT_BASE;

  let items = [];
  let params = new URLSearchParams();
  if (apiKey) params.set("apikey", apiKey);

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = params.toString();
    const url = `${base}/addresses/${wallet}/transactions${qs ? `?${qs}` : ""}`;

    let data;
    try {
      data = await fetchPageWithRetry(url);
    } catch (err) {
      if (page === 0) {
        // Failed on the very first page - we have nothing to work with.
        throw err;
      }
      // Later page failed even after retries - use what we already have
      // rather than discarding a wallet's entire history over one bad page.
      console.error(
        `scan-tick: page ${page} failed after retries (${err.message}), returning ${items.length} items collected so far`
      );
      break;
    }

    items = items.concat(data.items || []);

    if (data.next_page_params) {
      params = new URLSearchParams(data.next_page_params);
      if (apiKey) params.set("apikey", apiKey);
      await sleep(150); // small gap between pages to avoid tripping rate limits
    } else {
      break;
    }
  }
  return items;
}

function daysBetween(a, b) {
  return Math.floor(Math.abs(b - a) / 86400000);
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function scoreWallet(transactions) {
  if (transactions.length === 0) return null;

  // Sort oldest -> newest. Blockscout returns newest-first by default.
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  const firstSeen = new Date(sorted[0].timestamp);
  const lastSeen = new Date(sorted[sorted.length - 1].timestamp);
  const now = new Date();
  const ageDays = daysBetween(firstSeen, now);

  const uniqueContracts = new Set();
  const activeMonths = new Set();
  let successCount = 0;

  for (const tx of sorted) {
    if (tx.to && tx.to.hash) uniqueContracts.add(tx.to.hash.toLowerCase());
    activeMonths.add(monthKey(new Date(tx.timestamp)));
    if (tx.status === "ok" || tx.result === "success") successCount++;
  }

  const walletAgeMonths = Math.max(
    1,
    Math.ceil(daysBetween(firstSeen, now) / 30)
  );

  // --- category scores (0-100 each) ---
  const ageScore = Math.min(100, (ageDays / 1000) * 100);
  const activityScore = Math.min(100, (transactions.length / 300) * 100);
  const explorationScore = Math.min(100, (uniqueContracts.size / 60) * 100);
  const consistencyScore = Math.min(
    100,
    (activeMonths.size / walletAgeMonths) * 100
  );

  // NFT + early-adopter scoring need token-transfer / chain-genesis data
  // this endpoint doesn't return, so they're left at a neutral placeholder
  // until the NFT-history and chain-launch-date lookups are wired in.
  const nftScore = 0;
  const earlyScore = 0;

  const tickScore =
    ageScore * 0.3 +
    activityScore * 0.2 +
    nftScore * 0.15 +
    explorationScore * 0.15 +
    earlyScore * 0.1 +
    consistencyScore * 0.1;

  return {
    ageDays,
    firstSeen: firstSeen.toISOString(),
    lastSeen: lastSeen.toISOString(),
    transactionCount: transactions.length,
    successCount,
    contractCount: uniqueContracts.size,
    activeMonthCount: activeMonths.size,
    walletAgeMonths,
    breakdown: {
      ageScore: Number(ageScore.toFixed(1)),
      activityScore: Number(activityScore.toFixed(1)),
      nftScore,
      explorationScore: Number(explorationScore.toFixed(1)),
      earlyScore,
      consistencyScore: Number(consistencyScore.toFixed(1)),
    },
    tickScore: Number(tickScore.toFixed(1)),
  };
}

function speciesFor(score) {
  if (score >= 90) return "GENESIS TICK";
  if (score >= 75) return "ANCIENT TICK";
  if (score >= 55) return "MATURE TICK";
  if (score >= 30) return "YOUNG TICK";
  return "HATCHLING";
}

export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const wallet = (body.wallet || "").trim();
  if (!isValidAddress(wallet)) {
    return jsonResponse({ error: "Invalid EVM wallet address" }, 400);
  }

  try {
    const apiKey = process.env.BLOCKSCOUT_API_KEY || null;
    const transactions = await fetchAllTransactions(wallet, apiKey);

    if (transactions.length === 0) {
      return jsonResponse({
        wallet,
        transactionCount: 0,
        tickScore: 0,
        species: "UNSCANNED",
        message: "No transactions found for this address on Robinhood Chain.",
      });
    }

    const scored = scoreWallet(transactions);

    return jsonResponse({
      wallet,
      ...scored,
      species: speciesFor(scored.tickScore),
    });
  } catch (error) {
    console.error("scan-tick error:", error);
    return jsonResponse({ error: "Unable to scan wallet. Try again shortly." }, 500);
  }
};
