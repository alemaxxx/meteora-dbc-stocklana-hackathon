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
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
  deriveTokenBadgeAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";
import { computePythAnchoredMarketCaps, PYTH_STOCK_SYMBOLS, isPythStockSymbolSupported } from "./pythPricing.js";
import { query } from "./db.js";

// DBC (Dynamic Bonding Curve) "config" step - see DBC-MIGRATION-PLAN.md for
// the full design. A "config" is a SEPARATE account from the pool: it
// defines the curve's shape (fee, supply, DAMM v2 migration threshold,
// etc) and is MEANT TO BE REUSED - Meteora itself recommends one config
// per (quote token + fee/curve rules) combination, not one per launched
// token. Creating a new one costs a transaction + rent; reusing costs
// nothing beyond a read. That's why this file caches the created address
// in the dbc_configs table (see db.js) - moved 2026-09-21 from a flat
// data/dbc-configs.json file, which had no protection against two
// concurrent requests for a brand-new preset both deciding to create one.

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

// Real xStock mints (Backed Finance, Token-2022) on Solana mainnet -
// confirmed via direct on-chain reads on 2026-09-22 (both the mint
// account itself and its Meteora DBC token badge), not just from
// announcements/docs. See the "stock-quoted" presets below for why this
// matters and dbcConfig.js's `resolveTokenBadge` for how the badge gets
// used automatically.
export const STOCK_QUOTE_MINTS = {
  AAPLx: { symbol: "AAPLx", label: "Apple (AAPLx)", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8 },
  TSLAx: { symbol: "TSLAx", label: "Tesla (TSLAx)", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8 },
  NVDAx: { symbol: "NVDAx", label: "NVIDIA (NVDAx)", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8 },
  SPYx: { symbol: "SPYx", label: "S&P 500 (SPYx)", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8 },
  // Backpack Securities - a SEPARATE, competing tokenized-stock issuer from
  // Backed Finance's xStocks above (confirmed 2026-09-26: different mints,
  // different legal structure - direct 1:1 redeemable security entitlement
  // vs xStocks' cash-settled tracker). Same badge check applied (both
  // dbcClient.state.getTokenBadge AND the mint's real Token-2022 extensions
  // read directly, not assumed) - both came back badged, with the same
  // extension set as the xStocks above (permanentDelegate, inactive
  // transferHook, scaledUiAmountConfig, pausableConfig), so the same DAMM
  // v2 migration compatibility reasoning applies (CreatePoolWithoutMintValidation
  // is a DBC-program-level permission, not mint-specific - see
  // project_token_badge_feasibility.md). Only spot-checked two of Backpack's
  // ~200 (heading to a publicly-announced 10,000) tickers so far.
  SPCX: { symbol: "SPCX", label: "SpaceX (SPCX, Backpack Securities)", mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", decimals: 6 },
  MU: { symbol: "MU", label: "Micron (MU, Backpack Securities)", mint: "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1", decimals: 6 },
  // Four more Backpack Securities mints added 2026-09-26, same round -
  // each independently badge/extension-checked on-chain (6/6 Backpack
  // mints checked so far all badged, all identical Token-2022 extension
  // profile - see DBC-MIGRATION-PLAN.md section 5.21).
  MRNA: { symbol: "MRNA", label: "Moderna (MRNA, Backpack Securities)", mint: "MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT", decimals: 6 },
  NKE: { symbol: "NKE", label: "Nike (NKE, Backpack Securities)", mint: "NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg", decimals: 6 },
  CRWV: { symbol: "CRWV", label: "CoreWeave (CRWV, Backpack Securities)", mint: "CRWVJeR2yEZuDUKYfGuKCHvLz8ywn4LGvovHfy5WiFmi", decimals: 6 },
  SNDK: { symbol: "SNDK", label: "SanDisk (SNDK, Backpack Securities)", mint: "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH", decimals: 6 },
};

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
  // Added 2026-09-17, same round as the three above - the other explicit
  // idea named by the Crypto World's Fair brief: "Compounding Liquidity
  // DAMM v2 Pools". DBC already supports this at migration time via
  // MigrationFeeOption.Customizable + a migratedPoolFee block (confirmed
  // against the SDK's real .d.ts and validated offline with buildCurve,
  // same discipline as every other preset here) - the migrated DAMM v2
  // pool compounds half its trading fees back into its own liquidity
  // instead of paying all of it out. HIGHER RISK than the other five:
  // this is the first preset to use anything other than
  // MigrationFeeOption.FixedBps100, so it also exercises the
  // previously-unused dammConfig-selection branch in dbcMigration.js (see
  // getMigrationFeeOptionForPreset below) - untested live, on top of
  // migrate/claim already being untested live for every other preset too
  // (section 5.5/5.8).
  {
    id: "compounding-damm-v2",
    label: "Compounding DAMM v2 (3%→0.5% over 2h curve, migrates at 10 SOL, migrated pool compounds 50% of fees back into its own liquidity) - untested live, higher risk than the other presets",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 7200,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migratedPoolFee: {
      collectFeeMode: MigratedCollectFeeMode.Compounding,
      dynamicFee: DammV2DynamicFeeMode.Enabled,
      poolFeeBps: 100, // 1% - within the SDK's [10, 1000] bps bounds for a migrated pool fee
      compoundingFeeBps: 5000, // 50% of trading fees compound back into the pool's own liquidity, the rest still pays out
    },
  },
  // Added 2026-09-22 - direct response to how several other Stocklana
  // submissions raised the bar on "tokenized stock" ideas: they quote the
  // DBC pool directly in a REAL tokenized stock (xStock), not just use one
  // to calibrate a SOL threshold (which is all the Pyth-anchored mode
  // above does). Verified this is actually possible before writing any of
  // this - Meteora controls token badge creation (no SDK method exposes
  // it to partners, confirmed by reading the installed SDK's real
  // exports), but a live on-chain read (dbcClient.state.getTokenBadge)
  // confirmed Meteora has ALREADY badged all four of Backed Finance's real
  // xStock mints below for DBC use - independently re-verified for AAPLx
  // by deriving the badge PDA and fetching it directly (owned by the DBC
  // program, real data, not a null/false-positive read).
  //
  // Migration threshold is 0.1 units of the xStock itself (not SOL) -
  // meaning "the curve is done" is now a literal, real amount of stock
  // exposure (e.g. 0.1 TSLAx), not a converted number. No Pyth call
  // needed for this mode at all: since 1 unit of quote already equals 1
  // real share by the mint's own design, there's no USD/SOL conversion to
  // do - Pyth stays reserved for the separate "Pyth-anchored" mode above.
  ...Object.values(STOCK_QUOTE_MINTS).map((stock) => ({
    id: `stock-quoted-${stock.symbol.toLowerCase()}`,
    label: `Quoted in real ${stock.label} (3%→0.5% over 2h, migrates at 0.1 ${stock.symbol} accumulated in the curve) - trades directly against the tokenized stock, not SOL`,
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 0.1,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 7200,
    quoteMint: stock.mint,
    quoteSymbol: stock.symbol,
  })),
];

export function findDbcCurvePreset(id) {
  return DBC_CURVE_PRESETS.find((p) => p.id === id);
}

/**
 * Which MigrationFeeOption a given launch's config actually used when it
 * was created - needed at migrate time to pick the matching DAMM v2
 * config key (DAMM_V2_MIGRATION_FEE_ADDRESS), since that address is
 * DIFFERENT per option and has to match exactly what createConfig used.
 * `presetId` null (Pyth-anchored launches) falls back to the same
 * FixedBps100 default every preset used before this file supported
 * per-preset overrides (see "compounding-damm-v2").
 */
export function getMigrationFeeOptionForPreset(presetId) {
  return findDbcCurvePreset(presetId)?.migrationFeeOption ?? MigrationFeeOption.FixedBps100;
}

/**
 * Everything a DBC config needs that ISN'T about the curve's shape itself
 * (token/fee/migration/liquidity/vesting/activation) - identical for both
 * the fixed SOL presets (buildCurve) and the Pyth-anchored ones
 * (buildCurveWithMarketCap), factored out so the two curve modes below
 * can't drift apart on anything except the numbers that actually define
 * the curve.
 */
function sharedCurveConfig(
  quoteInfo,
  {
    startingFeeBps,
    endingFeeBps,
    schedulerDurationSeconds,
    baseFeeMode = BaseFeeMode.FeeSchedulerLinear,
    totalTokenSupply = 1_000_000_000,
    migrationFeeOption = MigrationFeeOption.FixedBps100,
    migratedPoolFee,
  }
) {
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
      migrationFeeOption, // FixedBps100 (1%) by default - middle ground, revisit; Customizable for presets that also set migratedPoolFee (see "compounding-damm-v2")
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // no EXTRA migration fee beyond the one above
      ...(migratedPoolFee ? { migratedPoolFee } : {}),
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
 * Some quote mints (Token-2022 with extensions the DBC program doesn't
 * natively trust, like the real xStock tokenized-stock mints - see
 * STOCK_QUOTE_MINTS below) require a "token badge" - an account Meteora
 * itself creates to vouch for that specific mint. Badging is NOT something
 * a partner/developer can do (confirmed 2026-09-22 by reading the SDK's
 * actual exported methods: no service class exposes a create-badge call,
 * only read-only getTokenBadge/deriveTokenBadgeAddress - the raw IDL
 * instruction exists but its `operator` account is a Meteora-controlled
 * role). This just checks whether Meteora has ALREADY badged the given
 * quote mint (a real, free, on-chain read) and passes the address along if
 * so - for SOL and other "supported" mints, getTokenBadge returns null and
 * this is a no-op, identical to the previous behavior.
 */
async function resolveTokenBadge(quoteMint) {
  const badge = await dbcClient.state.getTokenBadge(quoteMint).catch(() => null);
  return badge ? deriveTokenBadgeAddress(new PublicKey(quoteMint)) : undefined;
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

  const { rows: cachedRows } = await query("SELECT config_address FROM dbc_configs WHERE preset_id = $1 AND quote_mint = $2", [presetId, quoteMint]);
  if (cachedRows.length > 0) return new PublicKey(cachedRows[0].config_address);

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate(); // new account - the config address is random, not deterministic (unlike the "customizable" DAMM v2 pool in poolCreator.js)
  const configParams = await buildConfigParameters(preset, quoteMint);
  const tokenBadge = await resolveTokenBadge(quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey, // we withdraw the fee as both "partner" (config owner) AND "creator" (pool owner) - we're both parties here
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
    tokenBadge,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new config created for preset "${presetId}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  // ON CONFLICT: if a concurrent request for this exact preset+quote won
  // the race and inserted first, keep ITS row (RETURNING nothing means we
  // fall through to the SELECT below) rather than ours - we already paid
  // for and created an extra on-chain config account in that rare case,
  // but every future launch still converges on a single reused address.
  await query(
    `INSERT INTO dbc_configs (preset_id, quote_mint, config_address, signature)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (preset_id, quote_mint) WHERE preset_id NOT LIKE 'pyth:%' DO NOTHING`,
    [presetId, quoteMint, configKeypair.publicKey.toBase58(), signature]
  );
  const { rows: finalRows } = await query("SELECT config_address FROM dbc_configs WHERE preset_id = $1 AND quote_mint = $2", [presetId, quoteMint]);

  return new PublicKey(finalRows[0].config_address);
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
  const tokenBadge = await resolveTokenBadge(quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey,
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
    tokenBadge,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new Pyth-anchored config created for "${symbol}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  await query("INSERT INTO dbc_configs (preset_id, quote_mint, config_address, signature) VALUES ($1, $2, $3, $4)", [
    `pyth:${symbol}`,
    quoteMint,
    configKeypair.publicKey.toBase58(),
    signature,
  ]);

  return configKeypair.publicKey;
}
