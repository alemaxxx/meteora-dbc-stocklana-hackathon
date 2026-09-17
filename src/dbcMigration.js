import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";
import { getMigrationFeeOptionForPreset } from "./dbcConfig.js";

// Second half of a DBC pool's lifecycle - see PLANO-DBC-MIGRACAO.md.
// Unlike the current flow (createInfinitePool, in poolCreator.js), the
// DAMM v2 pool here is NOT created at launch time: it only comes into
// existence once the curve "completes" (reaches the migrationQuoteThreshold
// configured in dbcConfig.js) and someone - anyone, not necessarily the
// creator - calls migrateToDammV2. This file covers: checking whether a
// pool is ready, migrating, and withdrawing accumulated fees (both
// "creator" and "partner" - we're both, see dbcConfig.js).
//
// getDbcCurveProgress CONFIRMED LIVE on mainnet (2026-09-17, see
// PLANO-DBC-MIGRACAO.md section 5.5). migrateDbcPoolIfReady/claimDbcFees
// are still NEVER TESTED LIVE - stopped short of a full migration in that
// same test run due to the test wallet's budget (see section 5.5); their
// account structure was carefully checked against the SDK's real IDL in
// an earlier round (section 3), including a real bug found and fixed
// purely from reading the code (pool.poolState.isMigrated, not
// pool.isMigrated).

/**
 * Curve progress (0 to 1) based on accumulated quote token - 1 = ready to
 * migrate. Read-only, doesn't sign anything.
 */
export async function getDbcCurveProgress(poolAddress) {
  return dbcClient.state.getPoolQuoteTokenCurveProgress(new PublicKey(poolAddress));
}

/**
 * Migrates a completed DBC pool to a real DAMM v2 pool - the "automatic"
 * equivalent of poolCreator.js's createInfinitePool, except here the
 * initial price/liquidity of the new pool is decided by the curve that
 * already ran, not by a manual deposit from us. Does nothing (and spends
 * no SOL) if the pool hasn't reached the threshold yet - checks
 * isMigrated first.
 *
 * `presetId`: which preset the pool's config was originally built with
 * (null for Pyth-anchored launches) - needed to pick the matching
 * DAMM v2 config key, since that has to be the SAME MigrationFeeOption
 * used at createConfig time (see getMigrationFeeOptionForPreset in
 * dbcConfig.js - every preset defaults to FixedBps100 except
 * "compounding-damm-v2").
 */
export async function migrateDbcPoolIfReady(poolAddress, presetId = null) {
  const wallet = requireWalletKeypair();
  const poolPubkey = new PublicKey(poolAddress);

  // getPool returns the raw Anchor account - the IDL has "virtualPool" as
  // a wrapper around a SINGLE field (poolState), so the real fields
  // (isMigrated, baseMint, config, ...) live under pool.poolState, not on
  // the root object (confirmed by reading the installed package's IDL,
  // v1.5.12 - an easy layer to get wrong).
  const pool = await dbcClient.state.getPool(poolPubkey);
  if (!pool) throw new Error(`DBC pool ${poolAddress} not found on-chain.`);
  if (pool.poolState.isMigrated) {
    return { migrated: false, alreadyMigrated: true };
  }

  const progress = await dbcClient.state.getPoolQuoteTokenCurveProgress(poolPubkey);
  if (progress < 1) {
    return { migrated: false, progress };
  }

  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[getMigrationFeeOptionForPreset(presetId)];
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbcClient.migration.migrateToDammV2({
    payer: wallet.publicKey,
    pool: poolPubkey,
    dammConfig,
  });

  // Two new NFT positions (same pattern as the positionNftKeypair already
  // used in poolCreator.js for the "customizable" DAMM v2) - the SDK
  // itself builds both via Keypair.generate() internally, it just hands
  // them back for us to sign.
  const signature = await sendAndConfirmWithRetry(connection, transaction, [wallet, firstPositionNftKeypair, secondPositionNftKeypair]);
  console.log(`[dbcMigration] pool ${poolAddress} migrated to DAMM v2 (tx ${signature})`);

  // The new DAMM v2 pool's address is deterministic (a PDA derived from
  // dammConfig + the two mints - same family as deriveCustomizablePoolAddress
  // already used in poolCreator.js) - computed just to hand back to the
  // UI, without depending on any extra return value from migrateToDammV2
  // (which only returns the Transaction). If THIS part fails for any
  // reason, the migration itself has ALREADY HAPPENED (the transaction
  // above already confirmed) - never report an error to the user because
  // of this, just log it and return without the address.
  let newPoolAddress = null;
  try {
    const poolConfig = await dbcClient.state.getPoolConfig(pool.poolState.config);
    newPoolAddress = deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, poolConfig.quoteMint).toBase58();
  } catch (err) {
    console.warn(`[dbcMigration] migration of ${poolAddress} confirmed (tx ${signature}), but couldn't compute the new DAMM v2 pool address:`, err.message);
  }

  return { migrated: true, signature, newPoolAddress };
}

/**
 * Withdraws accumulated trading fees from the curve - both "creator" and
 * "partner" (config), since we're both parties (see feeClaimer/creator in
 * dbcConfig.js). maxBaseAmount/maxQuoteAmount = max BN (U64) withdraw
 * everything available, same "0 = don't withdraw this side" convention
 * the SDK's own docs describe for the side you don't want to withdraw.
 */
export async function claimDbcFees(poolAddress) {
  const wallet = requireWalletKeypair();
  const poolPubkey = new PublicKey(poolAddress);
  const maxAmount = new BN("18446744073709551615"); // U64_MAX - "withdraw everything"

  const creatorTx = await dbcClient.creator.claimCreatorTradingFee({
    creator: wallet.publicKey,
    payer: wallet.publicKey,
    pool: poolPubkey,
    maxBaseAmount: maxAmount,
    maxQuoteAmount: maxAmount,
  });
  const creatorSignature = await sendAndConfirmWithRetry(connection, creatorTx, [wallet]);

  const partnerTx = await dbcClient.partner.claimPartnerTradingFee({
    feeClaimer: wallet.publicKey,
    payer: wallet.publicKey,
    pool: poolPubkey,
    maxBaseAmount: maxAmount,
    maxQuoteAmount: maxAmount,
  });
  const partnerSignature = await sendAndConfirmWithRetry(connection, partnerTx, [wallet]);

  console.log(`[dbcMigration] fees for pool ${poolAddress} withdrawn (creator tx ${creatorSignature}, partner tx ${partnerSignature})`);
  return { creatorSignature, partnerSignature };
}
