import BN from "bn.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";
import { getMigrationFeeOptionForPreset } from "./dbcConfig.js";

const MAX_CLAIM_AMOUNT = new BN("18446744073709551615"); // U64_MAX - "withdraw everything"

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
 * Withdraws the accumulated PARTNER trading fee - always server-signed,
 * since the DBC "config" (and its feeClaimer) is platform-owned for every
 * preset, regardless of who launched with it (see dbcConfig.js).
 */
export async function claimPartnerFees(poolAddress) {
  const wallet = requireWalletKeypair();
  const poolPubkey = new PublicKey(poolAddress);

  const partnerTx = await dbcClient.partner.claimPartnerTradingFee({
    feeClaimer: wallet.publicKey,
    payer: wallet.publicKey,
    pool: poolPubkey,
    maxBaseAmount: MAX_CLAIM_AMOUNT,
    maxQuoteAmount: MAX_CLAIM_AMOUNT,
  });
  const signature = await sendAndConfirmWithRetry(connection, partnerTx, [wallet]);
  console.log(`[dbcMigration] partner fee for pool ${poolAddress} withdrawn (tx ${signature})`);
  return { signature };
}

/**
 * Builds (unsigned) the CREATOR fee claim transaction - wallet-connected,
 * NOT server-signed. BUG FOUND LIVE (2026-09-20, pre-launch security
 * review): the DBC program requires `creator` to be a SIGNER matching the
 * pool's own on-chain creator field (confirmed against the installed
 * SDK's real IDL - `claimCreatorTradingFee`'s `creator` account has
 * `signer: true`). Since the wallet-connect rework (section 5.7) made the
 * CONNECTING wallet the on-chain creator of every real launch (not the
 * platform wallet), the old single server-signed claimDbcFees could only
 * ever succeed for pools the platform wallet itself happened to launch -
 * every real user's own creator fee claim would fail on-chain with a
 * signer/constraint mismatch. Fixed the same way launching was: the
 * actual creator wallet signs their own claim. The creator pays their own
 * tiny tx fee too (payer = creator), consistent with "your connected
 * wallet pays for its own actions" elsewhere in this app.
 */
export async function prepareClaimCreatorFeeTransaction({ poolAddress, creatorPublicKey }) {
  const creator = new PublicKey(creatorPublicKey);
  const poolPubkey = new PublicKey(poolAddress);

  const tx = await dbcClient.creator.claimCreatorTradingFee({
    creator,
    payer: creator,
    pool: poolPubkey,
    maxBaseAmount: MAX_CLAIM_AMOUNT,
    maxQuoteAmount: MAX_CLAIM_AMOUNT,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Takes the creator's own signed claim transaction (from
 * prepareClaimCreatorFeeTransaction) and sends + confirms it.
 */
export async function submitClaimCreatorFeeTransaction({ signedTransactionBase64, blockhash, lastValidBlockHeight }) {
  const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`[dbcMigration] creator fee claimed (tx ${signature})`);
  return { signature };
}
