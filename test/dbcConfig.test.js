// Run with: node --test test/
//
// Needs this project's own .env (WALLET_PRIVATE_KEY/RPC_URL) - dbcConfig.js
// transitively imports connection.js/config.js, which read those at
// module-load time. No real RPC calls happen in this file though
// (STOCK_QUOTE_MINTS/DBC_CURVE_PRESETS are plain data, built once at
// import time), so no network access or real funds are needed to run it.
//
// Exists because every ticker-batch addition this project has done so far
// (157 -> 331 entries over several rounds) was reviewed by hand for exactly
// the mistakes this file checks automatically: duplicate keys, a decimals
// value that doesn't match the issuer's own established convention, a
// mint string that isn't valid base58, and a symbol that doesn't match the
// object's own key. One of those rounds (2026-10-01) DID introduce a real,
// if cosmetic, bug (two entries lost their indentation during an
// alphabetical re-sort) that only got caught by manual inspection - this
// suite is the automated version of that same manual check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STOCK_QUOTE_MINTS, DBC_CURVE_PRESETS } from "../src/dbcConfig.js";

// Same base58 alphabet Solana addresses use (no 0, O, I, l) - real
// PublicKey validation (length + curve check) is Solana-specific and
// already exercised for real by the live verification scripts each ticker
// batch runs before adding anything; this is just a cheap shape check to
// catch an obviously mistyped/truncated address.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DECIMALS_BY_ISSUER = {
  "xStocks (Backed Finance)": 8,
  "Backpack Securities": 6,
  Ondo: 9,
};

test("STOCK_QUOTE_MINTS: no duplicate mint addresses across different ticker keys", () => {
  const seen = new Map();
  for (const [key, entry] of Object.entries(STOCK_QUOTE_MINTS)) {
    const prior = seen.get(entry.mint);
    assert.equal(prior, undefined, `mint ${entry.mint} used by both "${prior}" and "${key}"`);
    seen.set(entry.mint, key);
  }
});

test("STOCK_QUOTE_MINTS: every entry's object key matches its own symbol field", () => {
  for (const [key, entry] of Object.entries(STOCK_QUOTE_MINTS)) {
    assert.equal(entry.symbol, key, `entry keyed "${key}" has symbol "${entry.symbol}"`);
  }
});

test("STOCK_QUOTE_MINTS: every mint looks like a real base58 Solana address", () => {
  for (const [key, entry] of Object.entries(STOCK_QUOTE_MINTS)) {
    assert.match(entry.mint, BASE58_RE, `"${key}"'s mint "${entry.mint}" doesn't look like a valid address`);
  }
});

test("STOCK_QUOTE_MINTS: decimals match the established convention for each known issuer", () => {
  for (const [key, entry] of Object.entries(STOCK_QUOTE_MINTS)) {
    const expected = DECIMALS_BY_ISSUER[entry.issuer];
    if (expected === undefined) continue; // a new issuer not yet in this table - not this test's job to flag
    assert.equal(entry.decimals, expected, `"${key}" (${entry.issuer}) has decimals=${entry.decimals}, expected ${expected}`);
  }
});

test("DBC_CURVE_PRESETS: one stock-quoted preset exists for every STOCK_QUOTE_MINTS entry", () => {
  const presetMints = new Set(
    DBC_CURVE_PRESETS.filter((p) => p.group?.startsWith("Real stock")).map((p) => p.quoteMint)
  );
  for (const [key, entry] of Object.entries(STOCK_QUOTE_MINTS)) {
    assert.ok(presetMints.has(entry.mint), `no DBC_CURVE_PRESETS entry found quoting "${key}"'s mint`);
  }
});

test("DBC_CURVE_PRESETS: every preset has a unique id", () => {
  const ids = DBC_CURVE_PRESETS.map((p) => p.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "duplicate preset id found");
});
