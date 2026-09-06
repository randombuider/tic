# Onchain Ticks — V1 Scanner

Wallet age/activity scanner for Robinhood Chain (chain ID `4663`), built as
a static frontend + one Netlify Function so no API key is ever exposed to
the browser.

## Files

- `index.html` / `style.css` / `app.js` — the scanner UI
- `netlify/functions/scan-tick.mjs` — server-side function that queries
  Blockscout and computes the Tick Score
- `netlify.toml` — routes `/api/scan-tick` to the function
- `test-wallet.html` — a **standalone** page that calls Blockscout directly
  from the browser (no server, no key). Open it straight in a browser or
  drag it into an online HTML sandbox to sanity-check a wallet address
  before deploying anything.

## Test a wallet right now (no deploy needed)

Open `test-wallet.html` directly in a browser (double-click it, or serve it
with any static file host) and paste an EVM address. It calls
`https://robinhoodchain.blockscout.com/api/v2/addresses/{address}/transactions`
directly, so if the wallet has no Robinhood Chain activity you'll correctly
see "no transactions found" — that endpoint only knows about **this** chain,
not Ethereum mainnet or L2s in general.

If the browser blocks the request (CORS), that's expected for some
Blockscout deployments and is exactly why the real app (`index.html`)
routes through the Netlify function instead of calling the API
client-side.

## Run the real app locally

```bash
npm install
npx netlify dev
```

This serves `index.html` and runs `scan-tick.mjs` as a local function at
`/.netlify/functions/scan-tick`, proxied through `/api/scan-tick`.

## API key (optional but recommended)

The function works without a key by falling back to the public
`robinhoodchain.blockscout.com` instance. For production, get a free key at
[dev.blockscout.com](https://dev.blockscout.com) and set it as an
environment variable:

```bash
netlify env:set BLOCKSCOUT_API_KEY proapi_your_key_here
```

This routes calls through `https://api.blockscout.com/4663/api/v2/...`
(Blockscout's PRO multichain API) instead of the direct instance, which is
more reliable at scale.

## Deploy

```bash
netlify deploy --prod
```

## What's implemented vs. stubbed

Implemented:
- Full transaction history pagination (follows `next_page_params`, capped
  at 10 pages per scan)
- True first-transaction detection (sorts oldest-first rather than trusting
  page order)
- Onchain age, transaction count, unique contract count, active-months
  consistency
- Weighted Tick Score using the 30/20/15/15/10/10 formula

Stubbed at 0 for now (need additional data sources — see `scan-tick.mjs`):
- **NFT History (15%)** — needs the `/token-transfers` endpoint filtered to
  ERC-721/1155
- **Early Adopter (10%)** — needs Robinhood Chain's genesis block timestamp
  to compare against

Both are straightforward additions once you're ready — the weighting logic
already accounts for them, they just need real inputs instead of `0`.

## Known limitation

`MAX_PAGES = 10` in `scan-tick.mjs` caps very active wallets at ~500-1000
transactions per scan (Blockscout pages ~50-100 items). Raise it if you hit
wallets with more history, at the cost of a slower response.
