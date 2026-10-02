// Run with: node --test test/
//
// Needs this project's own .env (WALLET_PRIVATE_KEY/RPC_URL) - dammPoolInfo.js
// transitively imports connection.js/config.js/dbcConfig.js, which read
// those at module-load time. No real RPC calls happen in this file though
// (resolveBaseQuote is pure), so no network access or real funds are
// needed to run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBaseQuote } from "../src/dammPoolInfo.js";
import { SOL_MINT, USDC_MINT } from "../src/config.js";

// Real numbers from the one pool this project has actually migrated
// (SOLBULL/SOL, confirmed live 2026-10-01/02).
const SOLBULL_MINT = "8z6M8QLJKPmRuJjg1Kzox4iCTCYgkzbD7GXyub2pWwT2";
const SOLBULL_PRICE_IN_SOL = 2.057872426453754e-9;

test("resolveBaseQuote: base=tokenA, quote=tokenB (the real SOLBULL/SOL case)", () => {
  const result = resolveBaseQuote({ tokenAMint: SOLBULL_MINT, tokenBMint: SOL_MINT, priceAInB: SOLBULL_PRICE_IN_SOL });
  assert.equal(result.baseIsA, true);
  assert.equal(result.baseMint, SOLBULL_MINT);
  assert.equal(result.quoteMint, SOL_MINT);
  assert.equal(result.priceBaseInQuote, SOLBULL_PRICE_IN_SOL);
});

test("resolveBaseQuote: base=tokenB, quote=tokenA (the inverted case - real bug fixed 2026-10-02)", () => {
  // Same real pair, as if the pool had stored them in the opposite order.
  // Before this fix, public/explore.js's live-price display
  // (loadDammPrices) read priceAInB directly and would have shown this as
  // "1 token ≈ 485,938,772 SOL" instead of the tiny, correct real price.
  const result = resolveBaseQuote({ tokenAMint: SOL_MINT, tokenBMint: SOLBULL_MINT, priceAInB: 1 / SOLBULL_PRICE_IN_SOL });
  assert.equal(result.baseIsA, false);
  assert.equal(result.baseMint, SOLBULL_MINT);
  assert.equal(result.quoteMint, SOL_MINT);
  assert.ok(
    Math.abs(result.priceBaseInQuote - SOLBULL_PRICE_IN_SOL) < 1e-20,
    `expected priceBaseInQuote ~= ${SOLBULL_PRICE_IN_SOL}, got ${result.priceBaseInQuote}`
  );
});

test("resolveBaseQuote: works with USDC as the quote mint, either side", () => {
  const forward = resolveBaseQuote({ tokenAMint: SOLBULL_MINT, tokenBMint: USDC_MINT, priceAInB: 0.5 });
  assert.equal(forward.baseMint, SOLBULL_MINT);
  assert.equal(forward.priceBaseInQuote, 0.5);

  const inverted = resolveBaseQuote({ tokenAMint: USDC_MINT, tokenBMint: SOLBULL_MINT, priceAInB: 2 });
  assert.equal(inverted.baseMint, SOLBULL_MINT);
  assert.equal(inverted.priceBaseInQuote, 0.5);
});

test("resolveBaseQuote: falls back to tokenA=base when neither side is a known quote mint", () => {
  // Shouldn't happen for anything launched by this platform, but this is a
  // public, works-for-any-pool API - must not throw, and should behave
  // exactly like the pre-fix code (tokenA=base) for a pool it can't classify.
  const someMint = "11111111111111111111111111111111";
  const otherMint = "22222222222222222222222222222222";
  const result = resolveBaseQuote({ tokenAMint: someMint, tokenBMint: otherMint, priceAInB: 3 });
  assert.equal(result.baseIsA, true);
  assert.equal(result.baseMint, someMint);
  assert.equal(result.quoteMint, otherMint);
  assert.equal(result.priceBaseInQuote, 3);
});
