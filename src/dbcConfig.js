import fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildCurve,
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
];

export function findDbcCurvePreset(id) {
  return DBC_CURVE_PRESETS.find((p) => p.id === id);
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
    token: {
      tokenType: TokenType.SPLToken, // new token, minted by DBC itself - no need for the Token-2022 that StonkFun/pump.fun sometimes require
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteInfo.decimals, // needs to match the quote's REAL decimals (SPYx = 8, SOL = 9, USDC/USDT = 6)
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // no mint/update authority left with us after launch - same spirit as "direct" (mintNewToken already revokes authority, see tokenMinter.js)
      totalTokenSupply: preset.totalTokenSupply,
      leftover: 0, // nothing withheld on purpose - all supply that doesn't migrate stays with whoever bought on the curve
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: preset.startingFeeBps,
          endingFeeBps: preset.endingFeeBps,
          numberOfPeriod: preset.schedulerDurationSeconds,
          totalDuration: preset.schedulerDurationSeconds,
        },
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
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
    migrationQuoteThreshold: preset.migrationQuoteThreshold,
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
