import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const KNOWN_TOKENS = {
  SOL: { symbol: "SOL", name: "Wrapped SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { symbol: "USDC", name: "USD Coin", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { symbol: "USDT", name: "Tether USD", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  GPRO: { symbol: "GPRO", name: "GoPro - Backpack Securities", address: "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH", decimals: 6 },
  USD1: { symbol: "USD1", name: "World Liberty Financial USD", address: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6 },
};

const mintCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds a mint's decimals and token program (classic or Token2022),
 * needed to build the pool-creation transaction correctly.
 */
export async function getMintInfo(connection, mintAddress) {
  const key = mintAddress.toString();

  // Only the genuinely immutable fields are cached (decimals/programId/mint
  // never change for a given mint). `currentEpoch` is deliberately NOT part
  // of the cached value - found 2026-10-02 (code review): it used to be
  // cached forever alongside the rest, but a Solana epoch only lasts ~2-3
  // days, and this value feeds straight into real pool-creation transactions
  // (dbcLaunchpad.js/dbcConfig.js/dlmmConviction.js) for Token-2022 mints,
  // where it determines which side of a scheduled transfer-fee change is
  // active. A long-running server process caching a stale epoch for days
  // could silently use the wrong fee tier for a mint with a scheduled fee
  // change - recomputed fresh on every call instead (only costs an extra
  // RPC call for Token-2022 mints, same as before this fix).
  const cached = mintCache.get(key);
  if (cached) {
    const currentEpoch = cached.programId.equals(TOKEN_2022_PROGRAM_ID) ? (await connection.getEpochInfo()).epoch : 0;
    return { ...cached, currentEpoch };
  }

  const mintPubkey = new PublicKey(mintAddress);

  // A JUST-created mint (same transaction, seconds ago) might not have
  // propagated to this read yet, especially with an overloaded RPC (see
  // the 2026-09-12 conversation - "Custom: 6025"/CRYTGLOW, same root
  // cause) - retry a bit before giving up. For a mint that genuinely
  // doesn't exist (wrong address, wrong network), this only delays the
  // error by a few seconds, at no real cost.
  let accountInfo = null;
  for (let i = 0; i < 6; i++) {
    accountInfo = await connection.getAccountInfo(mintPubkey);
    if (accountInfo) break;
    await sleep(2000);
  }
  if (!accountInfo) {
    throw new Error(`Mint ${key} not found on-chain.`);
  }

  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mintPubkey, undefined, programId);

  // `mint` (the raw object returned by getMint, with Token-2022 extension
  // data when present) + `currentEpoch` go straight into Meteora's
  // preparePoolCreationParams (see poolCreator.js) - their own SDK already
  // knows how to deduct the transfer fee (Token-2022, e.g. StonkFun
  // requiring 1%/3% on some launches - 2026-09-12 conversation) the same
  // way the on-chain program does, without us having to recompute it by
  // hand. For a mint without that extension, Meteora's own function just
  // ignores it and changes nothing.
  // A classic token (TOKEN_PROGRAM_ID) never has any extension - only
  // worth spending an extra RPC call to find the current epoch when the
  // mint is Token-2022 (the only one that can have a transfer fee).
  const currentEpoch = programId.equals(TOKEN_2022_PROGRAM_ID) ? (await connection.getEpochInfo()).epoch : 0;

  const cacheable = { decimals: mintInfo.decimals, programId, mint: mintInfo };
  mintCache.set(key, cacheable);
  return { ...cacheable, currentEpoch };
}
