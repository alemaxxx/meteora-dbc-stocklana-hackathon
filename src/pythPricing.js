import "dotenv/config";

// Live price data from Pyth (Hermes API), used to anchor a DBC curve's
// market-cap targets to a real stock's current price instead of a
// guessed SOL number - see PLANO-DBC-MIGRACAO.md for the full writeup
// (the "Pyth-anchored preset" round).
//
// REAL CONSTRAINT found live (2026-09-17): Hermes' price-update endpoint
// now requires a Pyth Pro API key (PYTH_API_KEY) even for basic feeds -
// this used to be a fully public endpoint. On top of that, the free
// trial plan only grants a small allowlist of equity tickers: out of ~25
// large-cap symbols tested (AAPL, NVDA, MSFT, GOOGL, AMZN, SPY, META,
// GME, COIN, ...), only TSLA and QQQ returned real data - everything
// else came back "403 Not entitled" (real-world exchange data is
// licensed per symbol, not a bug on our side). The trial itself also
// expires ~2026-10-01. Because of this, every caller of this module MUST
// tolerate failures (missing key, expired trial, unentitled symbol) and
// fall back to the fixed SOL presets - see dbcConfig.js/server.js.
const PYTH_HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";

// Feed IDs confirmed against Hermes's /v2/price_feeds listing on
// 2026-09-17 - only the two entries below are actually entitled under
// this project's trial key.
export const PYTH_STOCK_SYMBOLS = {
  TSLA: { label: "Tesla (TSLA)", feedId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1" },
  QQQ: { label: "Invesco QQQ Trust (QQQ)", feedId: "9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d" },
};
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// How much of ONE real share the launched token's entire supply
// symbolically represents, and how many times that anchor price the
// curve targets at graduation - both fixed, documented constants, picked
// so a typical stock/ETF price (checked live on 2026-09-17: TSLA ~$367,
// QQQ ~$717, SOL ~$101) lands the graduation threshold in a small,
// testable SOL range. No deeper meaning than that - purely a demo-scale
// calibration, disclosed as such in the UI.
const SHARE_FRACTION = 0.01;
const MIGRATION_MULTIPLIER = 50;

async function fetchPythPrice(feedId) {
  const apiKey = process.env.PYTH_API_KEY;
  if (!apiKey) {
    throw new Error("PYTH_API_KEY not set - Pyth-anchored presets are unavailable.");
  }
  const res = await fetch(`${PYTH_HERMES_URL}?ids[]=${feedId}&parsed=true`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pyth price request failed (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  const parsed = data.parsed?.[0];
  if (!parsed) throw new Error(`Pyth returned no price for feed ${feedId}.`);
  return Number(parsed.price.price) * 10 ** parsed.price.expo;
}

export function isPythStockSymbolSupported(symbol) {
  return Object.prototype.hasOwnProperty.call(PYTH_STOCK_SYMBOLS, symbol);
}

/**
 * Fetches the live SOL/USD price and the chosen stock's live USD price,
 * then derives (initialMarketCap, migrationMarketCap) in SOL - ready to
 * feed straight into buildCurveWithMarketCap (see dbcConfig.js).
 */
export async function computePythAnchoredMarketCaps(symbol) {
  const entry = PYTH_STOCK_SYMBOLS[symbol];
  if (!entry) throw new Error(`Unsupported Pyth-anchored symbol: "${symbol}".`);

  const [stockUsd, solUsd] = await Promise.all([fetchPythPrice(entry.feedId), fetchPythPrice(SOL_USD_FEED_ID)]);
  const pricePerShareSol = stockUsd / solUsd;
  const initialMarketCap = pricePerShareSol * SHARE_FRACTION;
  const migrationMarketCap = initialMarketCap * MIGRATION_MULTIPLIER;

  return { symbol, stockUsd, solUsd, initialMarketCap, migrationMarketCap };
}
