import fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildCurve,
  buildCurveWithMarketCap,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";
import { computePythAnchoredMarketCaps, PYTH_STOCK_SYMBOLS, isPythStockSymbolSupported } from "./pythPricing.js";

// DBC (Dynamic Bonding Curve) "config" step - see PLANO-DBC-MIGRACAO.md for
// the full design. A "config" is a SEPARATE account from the pool: it
// defines the curve's shape (fee, supply, DAMM v2 migration threshold,
// etc) and is MEANT TO BE REUSED - Meteora itself recommends one config
// per (quote token + fee/curve rules) combination, not one per launched
// token. Creating a new one costs a transaction + rent; reusing costs
// nothing beyond a read. That's why this file caches the created address
// in data/dbc-configs.json, the same way tokenLauncher.js caches launches
// in data/launched-tokens.json.

const DBC_CONFIGS_FILE = new URL("../data/dbc-configs.json", import.meta.url);

function ensureDataDir() {
  const dir = new URL("../data/", import.meta.url);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfigs() {
  ensureDataDir();
  if (!fs.existsSync(DBC_CONFIGS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DBC_CONFIGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfigs(list) {
  ensureDataDir();
  fs.writeFileSync(DBC_CONFIGS_FILE, JSON.stringify(list, null, 2));
}

// CONFIRMED (2026-09-17) against Meteora's own official reference config
// (github.com/MeteoraAg/meteora-invent, studio/config/dbc_config.jsonc,
// buildCurveMode 0 - the same mode used below) and against the "migration
// keepers" table in docs.meteora.ag/developer-guides/dbc: the official
// example uses migrationQuoteThreshold: 10 (SOL) - the canonical threshold
// for SOL-quoted pools. The previous value here (85 SOL) was pump.fun's
// classic graduation number, carried over by assumption and NEVER
// confirmed for DBC - with docs.meteora.ag reachable now (it was blocked
// by this environment's network proxy on 2026-09-15), confirmed that 85
// was 8.5x above the reference value, which would require accumulating
// far more real SOL to migrate. Adjusted to 10 (same value as the official
// example). The "initialMarketCap" field that used to be here was
// removed - it was never read anywhere: it only exists for the
// buildCurveWithMarketCap/... modes (not used here, see
// buildConfigParameters below, which uses plain buildCurve with
// percentageSupplyOnMigration + migrationQuoteThreshold).
// LIVE FINDING (2026-09-16, first real DBC launch - NARWAVE, mint
// 5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei): the 10% starting fee
// (preset "default-2h-linear") triggered GMGN's automatic "high tax"
// alert (showed "Dex 9.83%" ~2min after launch, flagged by GMGN's
// security check) - trading terminals tend to flag/reject tokens with a
// fee that high on purpose (anti-honeypot heuristic), which scares off
// real buyers even though the token is legitimate. Supply (1B) and the
// rest of the config matched exactly - only the starting fee was too high
// for this side effect. Hence the "low-fee" preset below, without
// deleting the original (lets you compare both launches side by side).
export const DBC_CURVE_PRESETS = [
  {
    id: "baixa-taxa-2h-linear",
    label: "Low fee (3%→0.5% over 2h, migrates at 10 SOL accumulated in the curve) - recommended after the NARWAVE finding",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300, // 3% - below what usually triggers "high tax" on terminal scanners (GMGN etc)
    endingFeeBps: 50, // 0.5%
    schedulerDurationSeconds: 7200,
  },
  {
    id: "default-2h-linear",
    label: "Default (10%→1% fee over 2h, migrates at 10 SOL accumulated in the curve) - triggers GMGN's \"high tax\" alert (found on NARWAVE), use with caution",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20, // 20% of the supply migrates to the DAMM v2 pool, the rest stays with whoever bought on the curve
    migrationQuoteThreshold: 10, // SOL accumulated in the curve to unlock migration - confirmed against the official dbc_config.jsonc
    startingFeeBps: 1000, // 10%
    endingFeeBps: 100, // 1%
    schedulerDurationSeconds: 7200, // 2h, same default already used in presets.js (SCHEDULER_DURATION_SECONDS)
  },
  // Three more fee/curve shapes added 2026-09-17 in direct response to the
  // Crypto World's Fair brief's own "ideas we'd love to see": "novel curve
  // or fee configurations" naming "Flat Curve, Exponential Curve, or Long
  // Curve" as examples - all three below map onto one of those verbatim,
  // reusing the same 10 SOL threshold and 1B/20% supply split already
  // validated for the two presets above (only the fee shape changes).
  {
    id: "flat-1pct",
    label: "Flat curve (1% fee, never decays, migrates at 10 SOL accumulated in the curve) - simplest possible fee shape, no scheduler to reason about",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 100, // 1%, flat
    endingFeeBps: 100,
    // A real "no decay" fee needs numberOfPeriod/totalDuration at exactly
    // ZERO, not just startingFeeBps === endingFeeBps over some nonzero
    // duration - confirmed live against the installed SDK (v1.5.12):
    // buildCurve rejects a matching start/end with a nonzero duration
    // with "numberOfPeriod and totalDuration must both be zero".
    schedulerDurationSeconds: 0,
  },
  {
    id: "exponencial-2h",
    label: "Exponential curve (5%→0.5% over 2h, decays fast then slow, migrates at 10 SOL accumulated in the curve) - front-loads the fee harder than the linear presets",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 500, // 5% - still below the ~10% GMGN "high tax" line, with headroom for exponential's faster initial drop
    endingFeeBps: 50, // 0.5%
    schedulerDurationSeconds: 7200,
    baseFeeMode: BaseFeeMode.FeeSchedulerExponential, // SAME FeeSchedulerParams shape as linear - only this enum value differs (confirmed against the installed SDK's .d.ts)
  },
  {
    id: "long-24h-linear",
    label: "Long curve (3%→0.5% over 24h, migrates at 10 SOL accumulated in the curve) - same fee range as the low-fee preset, stretched over a full day instead of 2h",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 86400, // 24h instead of 7200 (2h) - the only thing that makes this "long"
  },
];

export function findDbcCurvePreset(id) {
  return DBC_CURVE_PRESETS.find((p) => p.id === id);
}

/**
 * Everything a DBC config needs that ISN'T about the curve's shape itself
 * (token/fee/migration/liquidity/vesting/activation) - identical for both
 * the fixed SOL presets (buildCurve) and the Pyth-anchored ones
 * (buildCurveWithMarketCap), factored out so the two curve modes below
 * can't drift apart on anything except the numbers that actually define
 * the curve.
 */
function sharedCurveConfig(quoteInfo, { startingFeeBps, endingFeeBps, schedulerDurationSeconds, baseFeeMode = BaseFeeMode.FeeSchedulerLinear, totalTokenSupply = 1_000_000_000 }) {
  return {
    token: {
      tokenType: TokenType.SPLToken, // new token, minted by DBC itself - no need for the Token-2022 that StonkFun/pump.fun sometimes require
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteInfo.decimals, // needs to match the quote's REAL decimals (SPYx = 8, SOL = 9, USDC/USDT = 6)
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // no mint/update authority left with us after launch - same spirit as "direct" (mintNewToken already revokes authority, see tokenMinter.js)
      totalTokenSupply,
      leftover: 0, // nothing withheld on purpose - all supply that doesn't migrate stays with whoever bought on the curve
    },
    fee: {
      baseFeeParams: {
        baseFeeMode,
        feeSchedulerParam: { startingFeeBps, endingFeeBps, numberOfPeriod: schedulerDurationSeconds, totalDuration: schedulerDurationSeconds },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken, // fee always in the quote (SOL/SPYx/...), never in the new token - more predictable to withdraw later (see dbcMigration.js)
      creatorTradingFeePercentage: 100, // 100% of the creator fee stays with us (no third-party partner in this project)
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // V1 is deprecated for new configs
      migrationFeeOption: MigrationFeeOption.FixedBps100, // 1% fee on the post-migration DAMM v2 pool - middle ground, revisit
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // no EXTRA migration fee beyond the one above
    },
    liquidityDistribution: {
      // 100% of the migration liquidity is permanently locked in the
      // creator's name - without this, the entire liquidity of the
      // freshly migrated pool could be withdrawn and rugged; that's not
      // what this bot does in the other methods (createInfinitePool also
      // locks via an NFT position, never grants free-removal approval).
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,
    },
    lockedVesting: {
      // No vesting at all on the supply left out of migration - same
      // behavior "direct" already has today (entire supply liquid, no
      // lock).
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp, // same convention already used in poolCreator.js (activationType: 1)
  };
}

/**
 * Builds the ConfigParameters (curve + fees + migration) from a preset +
 * the chosen quote - uses buildCurve, which does all the sqrtPrice/
 * liquidity math for us (equivalent to the preparePoolCreationParams that
 * poolCreator.js already uses for DAMM v2, just on the DBC side).
 */
async function buildConfigParameters(preset, quoteMint) {
  const quoteInfo = await getMintInfo(connection, quoteMint);

  return buildCurve({
    ...sharedCurveConfig(quoteInfo, preset),
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
    migrationQuoteThreshold: preset.migrationQuoteThreshold,
  });
}

// Same fee schedule as the validated "low-fee" preset (see
// DBC_CURVE_PRESETS above) - reused as-is for Pyth-anchored launches
// rather than inventing a new number, since it's the one already proven
// live against GMGN's "high tax" heuristic.
const PYTH_ANCHORED_FEE_SCHEDULE = { startingFeeBps: 300, endingFeeBps: 50, schedulerDurationSeconds: 7200 };

/**
 * Builds ConfigParameters anchored to a real stock's live Pyth price
 * instead of a fixed SOL number - uses buildCurveWithMarketCap (a
 * DIFFERENT SDK curve-builder than the one above: it takes
 * initialMarketCap/migrationMarketCap directly, no
 * percentageSupplyOnMigration/migrationQuoteThreshold). See
 * pythPricing.js for where the market caps come from and the real
 * limitations found (trial API key, only TSLA/QQQ entitled).
 */
async function buildPythAnchoredConfigParameters(symbol, quoteMint) {
  const quoteInfo = await getMintInfo(connection, quoteMint);
  const { initialMarketCap, migrationMarketCap } = await computePythAnchoredMarketCaps(symbol);

  return buildCurveWithMarketCap({
    ...sharedCurveConfig(quoteInfo, PYTH_ANCHORED_FEE_SCHEDULE),
    initialMarketCap,
    migrationMarketCap,
  });
}

/**
 * Returns the address of an already-created config (local cache) for this
 * (preset, quote) combination, creating a new one on-chain only the first
 * time. Never creates two configs for the same preset+quote pair - always
 * reuses.
 */
export async function getOrCreateDbcConfig(presetId, quoteMint) {
  const preset = findDbcCurvePreset(presetId);
  if (!preset) throw new Error(`Unknown DBC curve preset: "${presetId}".`);

  const list = loadConfigs();
  const cached = list.find((c) => c.presetId === presetId && c.quoteMint === quoteMint);
  if (cached) return new PublicKey(cached.configAddress);

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate(); // new account - the config address is random, not deterministic (unlike the "customizable" DAMM v2 pool in poolCreator.js)
  const configParams = await buildConfigParameters(preset, quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey, // we withdraw the fee as both "partner" (config owner) AND "creator" (pool owner) - we're both parties here
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new config created for preset "${presetId}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  list.push({
    presetId,
    quoteMint,
    configAddress: configKeypair.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    signature,
  });
  saveConfigs(list);

  return configKeypair.publicKey;
}

/**
 * Creates a FRESH DBC config anchored to a stock's live Pyth price - on
 * purpose NEVER cached/reused like getOrCreateDbcConfig above: the whole
 * point is that the market caps reflect the price at the moment of
 * launch, so every Pyth-anchored launch gets its own config with a
 * current read, not a stale one from whenever the symbol was first used.
 * The extra config-account rent this costs is negligible.
 */
export async function createPythAnchoredDbcConfig(symbol, quoteMint) {
  if (!isPythStockSymbolSupported(symbol)) {
    throw new Error(`Unsupported Pyth-anchored symbol: "${symbol}". Supported: ${Object.keys(PYTH_STOCK_SYMBOLS).join(", ")}.`);
  }

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate();
  const configParams = await buildPythAnchoredConfigParameters(symbol, quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey,
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new Pyth-anchored config created for "${symbol}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  const list = loadConfigs();
  list.push({
    presetId: `pyth:${symbol}`,
    quoteMint,
    configAddress: configKeypair.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    signature,
  });
  saveConfigs(list);

  return configKeypair.publicKey;
}
