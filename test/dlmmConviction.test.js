// Run with: node --test test/
//
// Needs this project's own .env (WALLET_PRIVATE_KEY/RPC_URL) to be present,
// same as running the app itself - dlmmConviction.js transitively imports
// connection.js/config.js, which read those at module-load time. No real
// RPC calls happen in this file though (resolveBaseQuote is pure), so no
// network access or real funds are needed to run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBaseQuote } from "../src/dlmmConviction.js";
import { SOL_MINT, USDC_MINT } from "../src/config.js";

// Real numbers from the one pool this project has actually migrated
// (SOLBULL/SOL, confirmed live 2026-10-01/02) - used as realistic fixtures
// rather than made-up values.
const SOLBULL_MINT = "8z6M8QLJKPmRuJjg1Kzox4iCTCYgkzbD7GXyub2pWwT2";
const SOLBULL_PRICE_IN_SOL = 2.057872426453754e-9;

test("resolveBaseQuote: base=tokenA, quote=tokenB (the real SOLBULL/SOL case)", () => {
  const result = resolveBaseQuote({
    tokenAMint: SOLBULL_MINT,
    tokenBMint: SOL_MINT,
    priceAInB: SOLBULL_PRICE_IN_SOL,
  });
  assert.equal(result.baseMint, SOLBULL_MINT);
  assert.equal(result.quoteMint, SOL_MINT);
  assert.equal(result.livePrice, SOLBULL_PRICE_IN_SOL);
});

test("resolveBaseQuote: base=tokenB, quote=tokenA (the inverted case the 2026-10-02 bug fix covers)", () => {
  // Same real pair, but as if the pool had stored them in the opposite
  // order - this is the exact scenario that was silently wrong before the
  // fix (see project_multisegment_curve_option.md's 2026-10-02 entry).
  const result = resolveBaseQuote({
    tokenAMint: SOL_MINT,
    tokenBMint: SOLBULL_MINT,
    priceAInB: 1 / SOLBULL_PRICE_IN_SOL, // price of SOL in terms of SOLBULL
  });
  assert.equal(result.baseMint, SOLBULL_MINT);
  assert.equal(result.quoteMint, SOL_MINT);
  assert.ok(
    Math.abs(result.livePrice - SOLBULL_PRICE_IN_SOL) < 1e-20,
    `expected livePrice ~= ${SOLBULL_PRICE_IN_SOL}, got ${result.livePrice}`
  );
});

test("resolveBaseQuote: works with USDC as the quote mint, either side", () => {
  const forward = resolveBaseQuote({ tokenAMint: SOLBULL_MINT, tokenBMint: USDC_MINT, priceAInB: 0.5 });
  assert.equal(forward.baseMint, SOLBULL_MINT);
  assert.equal(forward.quoteMint, USDC_MINT);
  assert.equal(forward.livePrice, 0.5);

  const inverted = resolveBaseQuote({ tokenAMint: USDC_MINT, tokenBMint: SOLBULL_MINT, priceAInB: 2 });
  assert.equal(inverted.baseMint, SOLBULL_MINT);
  assert.equal(inverted.quoteMint, USDC_MINT);
  assert.equal(inverted.livePrice, 0.5);
});

test("resolveBaseQuote: falls back to tokenA/tokenB order when neither side is a known quote mint", () => {
  // Shouldn't happen for anything launched by this platform, but the
  // status endpoint is a public, works-for-any-pool API - must not throw.
  const someMint = "11111111111111111111111111111111";
  const otherMint = "22222222222222222222222222222222";
  const result = resolveBaseQuote({ tokenAMint: someMint, tokenBMint: otherMint, priceAInB: 3 });
  assert.equal(result.baseMint, someMint);
  assert.equal(result.quoteMint, otherMint);
  assert.equal(result.livePrice, 3);
});
