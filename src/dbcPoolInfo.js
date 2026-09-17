import { PublicKey } from "@solana/web3.js";
import { dbcClient } from "./connection.js";

// Public, read-only lookup for ANY Meteora DBC pool on-chain - not just
// ones this app launched. Added 2026-09-17 as the "Data Streams or
// Developer Tooling for trading terminals and builders" idea named by
// the Crypto World's Fair brief: a trading terminal or dashboard that
// wants to show a DBC pool's live state shouldn't have to integrate the
// whole SDK itself just to read a few numbers - this is that plug-and-play
// surface, exposed publicly (with CORS) via GET /api/dbc-pool/:address in
// server.js.
//
// Field names below (baseMint, isMigrated, quoteMint, ...) are confirmed
// against the installed SDK's real IDL (v1.5.12): PoolState/PoolConfig
// store snake_case fields on-chain, but Anchor's TS client decodes them
// to camelCase - same convention dbcMigration.js already relies on for
// `pool.poolState.isMigrated`.
export async function getPublicPoolInfo(addressOrMint) {
  const key = new PublicKey(addressOrMint);

  // Accept either a pool address or a base mint - callers off-chain often
  // only know one or the other. Found live testing (2026-09-17): getPool
  // does NOT return null for an address that exists but isn't a pool -
  // it THROWS ("Invalid account discriminator"), since Anchor's typed
  // account fetcher checks the account's discriminator bytes and rejects
  // a mismatch as an error, not a miss. So the base-mint fallback has to
  // be a catch, not just an `if (!pool)` check.
  let pool = null;
  let poolAddress = key;
  try {
    pool = await dbcClient.state.getPool(key);
  } catch {
    pool = null;
  }
  if (!pool) {
    const byMint = await dbcClient.state.getPoolByBaseMint(key);
    if (byMint) {
      pool = byMint.account;
      poolAddress = byMint.publicKey;
    }
  }
  if (!pool) return null;

  const [curveProgress, poolConfig, feeMetrics] = await Promise.all([
    dbcClient.state.getPoolQuoteTokenCurveProgress(poolAddress),
    dbcClient.state.getPoolConfig(pool.poolState.config),
    dbcClient.state.getPoolFeeMetrics(poolAddress).catch(() => null),
  ]);

  return {
    poolAddress: poolAddress.toBase58(),
    baseMint: pool.poolState.baseMint.toBase58(),
    quoteMint: poolConfig?.quoteMint?.toBase58?.() ?? null,
    isMigrated: Boolean(pool.poolState.isMigrated),
    curveProgress, // 0 to 1 - see getPoolQuoteTokenCurveProgress
    migrationQuoteThreshold: poolConfig?.migrationQuoteThreshold?.toString?.() ?? null, // raw quote-token units (lamports for SOL)
    feeMetrics: feeMetrics
      ? {
          creatorUnclaimedQuoteFee: feeMetrics.current.creatorQuoteFee.toString(),
          partnerUnclaimedQuoteFee: feeMetrics.current.partnerQuoteFee.toString(),
          totalTradingQuoteFee: feeMetrics.total.totalTradingQuoteFee.toString(),
        }
      : null,
  };
}
