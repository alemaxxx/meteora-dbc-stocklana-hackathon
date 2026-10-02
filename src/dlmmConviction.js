import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createRequire } from "module";
import BN from "bn.js";
import { connection } from "./connection.js";
import { SOL_MINT, USDC_MINT } from "./config.js";
import { STOCK_QUOTE_MINTS } from "./dbcConfig.js";
import { getMintInfo } from "./tokenInfo.js";
import { getDammPoolInfo } from "./dammPoolInfo.js";

// Every quote mint this platform has ever used to launch a token - used
// below to figure out which side of a DAMM v2 pool is actually the base
// (launched) token vs the quote, since CP-AMM pools (like DLMM, see the
// tokenX/Y handling in preparePositionTransaction below) canonicalize
// tokenA/tokenB by raw pubkey byte comparison, NOT by which one was
// originally "the launched token" - confirmed by reading
// deriveDammV2PoolAddress's getFirstKey/getSecondKey helpers in the DBC
// SDK, which sort purely on Buffer.compare. Assuming tokenA is always
// base (as an earlier version of this file did) is only an even-odds bet
// per pool - wrong for roughly half of all migrated pools, depending on
// nothing more meaningful than whether the launched token's randomly
// generated mint address happens to sort before its quote's.
const KNOWN_QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, ...Object.values(STOCK_QUOTE_MINTS).map((s) => s.mint)]);

// @meteora-ag/dlmm's published ESM build (dist/index.mjs) has a broken
// nested dependency (its own node_modules/@coral-xyz/anchor ships a
// directory import Node's ESM resolver rejects) - confirmed this isn't
// project-specific or fixable from our side (same failure cloning
// Meteora's own meteora-invent repo). The CJS build works fine and is
// functionally identical, so load it via createRequire - standard Node
// interop for a broken ESM export map, not a workaround for our own code.
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm");
const { ActivationType, StrategyType, deriveCustomizablePermissionlessLbPair, LBCLMM_PROGRAM_IDS } = DLMM;
// Confirmed real (matches Meteora's own AI-agent reference doc,
// skills/meteora/references/dlmm.md: "Program ID (mainnet and devnet):
// LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo") - read from the SDK's own
// exported constant rather than hardcoded, so it tracks any future change.
const DLMM_PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

// "DLMM Conviction Pools" - a second, concentrated-liquidity position
// opened alongside an already-migrated DBC->DAMM v2 pool, explicitly
// named in Meteora's own Crypto World's Fair brief ("Creative end-to-end
// launch flows using all of our stack... Conviction Pools with DLMM").
// A competitor (ExpertVagabond/stockcurve) already ships this as a
// manually-triggered action post-migration - same pattern followed here:
// never automatic, always a separate, explicit, wallet-signed step.
//
// IMPORTANT CORRECTION (2026-10-01): an earlier research pass concluded
// "@meteora-ag/dlmm has no high-level API" - that was a testing bug (it
// checked `require(...).default`, which is undefined; the package's
// module.exports IS the DLMM class directly). The real SDK has a full
// high-level API, confirmed by reading Meteora's own production code in
// github.com/MeteoraAg/meteora-invent (studio/src/lib/dlmm/index.ts) and
// their AI-agent reference doc (skills/meteora/references/dlmm.md) -
// both cited inline below wherever a specific choice follows their
// pattern or guidance.

// Bin step and range are a reasoned default, not a precisely researched
// optimum (same honesty standard as the USDC migration threshold choice
// in dbcConfig.js) - matches the lower-middle of the reference doc's own
// "new/volatile tokens: 80-400 bps" heuristic, landing on a clean 3 bins
// each side for a ~3% band (close to competitor stockcurve's own ±3%).
const CONVICTION_BIN_STEP = 100; // 1% per bin
const CONVICTION_RANGE_BINS = 3; // ~3% each side at a 1% bin step
const CONVICTION_POOL_FEE_BPS = 100; // 1%, same order of magnitude as this project's other "low fee" presets

// baseFactor/baseFeePowerFactor are DERIVED from binStep+feeBps (confirmed
// via DLMM.computeBaseFactorFromFeeBps: binStep=100, feeBps=100 -> 10000,
// 0) - NOT arbitrary, and must be computed the same way everywhere this
// pair's pool address/existence is checked (getPairPubkeyIfExists uses
// them to verify an existing account's stored params match, not just to
// derive the address) or a status check can silently disagree with what
// pool creation actually produced.
function getConvictionPoolFactors() {
  const [baseFactor, baseFeePowerFactor] = DLMM.computeBaseFactorFromFeeBps(new BN(CONVICTION_BIN_STEP), new BN(CONVICTION_POOL_FEE_BPS));
  return { baseFactor, baseFeePowerFactor };
}

/**
 * Checks whether a DLMM pool already exists for this (base, quote) pair,
 * returns the live DAMM v2 price to use as the DLMM pool's own initial
 * price if it needs to be created, and - if a wallet is given - whether
 * that wallet currently satisfies Meteora's own on-chain requirement to
 * create a permissionless pool.
 *
 * REAL FINDING (2026-10-01, confirmed via live mainnet simulation, not
 * assumed): creating a permissionless DLMM pool requires the creator's
 * own standard Associated Token Account for the base mint to hold a
 * non-zero balance - the on-chain program calls this a "token launch
 * owner proof" (error 6060, MissingTokenAmountAsTokenLaunchProof) and
 * enforces it regardless of ConcreteFunctionType (tested both
 * LimitOrder and LiquidityMining - both failed identically for a wallet
 * with no balance in its canonical ATA, confirmed with TWO different real
 * mainnet wallets, one holding zero SOLBULL and one holding millions of
 * it in non-standard token accounts rather than its canonical ATA).
 * Meteora's own SDK test suite (ts-client/src/test/bug_fix.test.ts,
 * `createMintAndPair`) confirms the mechanism directly: it mints tokens
 * into the creator's canonical ATA immediately before a successful pool
 * creation in their own working test. This is a real, sensible anti-spam
 * check - it naturally passes for any genuine CurveForge user opening a
 * Conviction Pool for a token they actually hold - so this function
 * surfaces it as a clear, actionable precondition instead of letting the
 * user hit a cryptic on-chain error.
 */
export async function getConvictionPoolStatus(dammPoolAddress, walletPublicKey) {
  const dammInfo = await getDammPoolInfo(dammPoolAddress);
  if (!dammInfo) return null;

  // Figure out which side is base vs quote by matching against every known
  // quote mint this platform uses, rather than assuming tokenA is always
  // base - see the KNOWN_QUOTE_MINTS comment above for why that assumption
  // is wrong roughly half the time.
  const aIsQuote = KNOWN_QUOTE_MINTS.has(dammInfo.tokenAMint);
  const bIsQuote = KNOWN_QUOTE_MINTS.has(dammInfo.tokenBMint);
  let baseMintStr, quoteMintStr, livePrice;
  if (aIsQuote && !bIsQuote) {
    baseMintStr = dammInfo.tokenBMint;
    quoteMintStr = dammInfo.tokenAMint;
    livePrice = 1 / Number(dammInfo.priceAInB); // priceAInB is A-in-terms-of-B; we need base-in-terms-of-quote = B-in-terms-of-A
  } else if (bIsQuote && !aIsQuote) {
    baseMintStr = dammInfo.tokenAMint;
    quoteMintStr = dammInfo.tokenBMint;
    livePrice = Number(dammInfo.priceAInB);
  } else {
    // Neither side (or both) matched a known quote mint - most likely a
    // pool this platform didn't launch. Fall back to the DAMM pool's own
    // A/B order rather than failing outright, since this endpoint is a
    // public, works-for-any-pool API, not restricted to our own launches.
    baseMintStr = dammInfo.tokenAMint;
    quoteMintStr = dammInfo.tokenBMint;
    livePrice = Number(dammInfo.priceAInB);
  }

  const baseMint = new PublicKey(baseMintStr);
  const quoteMint = new PublicKey(quoteMintStr);

  const { baseFactor, baseFeePowerFactor } = getConvictionPoolFactors();
  const existingPoolAddress = await DLMM.getPairPubkeyIfExists(
    connection,
    baseMint,
    quoteMint,
    new BN(CONVICTION_BIN_STEP),
    baseFactor,
    baseFeePowerFactor,
    DLMM.ConcreteFunctionType.LiquidityMining // must match what preparePoolCreationTransaction actually creates
  ).catch(() => null);

  let creatorHasRequiredBalance = null;
  if (walletPublicKey && !existingPoolAddress) {
    const baseInfo = await getMintInfo(connection, baseMintStr);
    const ata = getAssociatedTokenAddressSync(baseMint, new PublicKey(walletPublicKey), true, baseInfo.programId);
    const balance = await connection.getTokenAccountBalance(ata).catch(() => null);
    creatorHasRequiredBalance = Boolean(balance && Number(balance.value.amount) > 0);
  }

  return {
    baseMint: baseMintStr,
    quoteMint: quoteMintStr,
    livePrice,
    dlmmPoolExists: Boolean(existingPoolAddress),
    dlmmPoolAddress: existingPoolAddress ? existingPoolAddress.toBase58() : null,
    // null when no wallet was given to check, or a pool already exists (not needed then)
    creatorHasRequiredBalance,
  };
}

/**
 * Builds (unsigned) the transaction that creates a new permissionless
 * DLMM pool for this pair, initialized at the live DAMM v2 price. Same
 * prepare/sign/submit shape as every other wallet-facing action in this
 * project (see WALLET-INTEGRATION.md) - the connecting wallet pays and
 * is the pool's creator, never the platform's own keypair.
 */
export async function preparePoolCreationTransaction({ baseMint, quoteMint, creatorPublicKey, livePrice }) {
  const baseMintKey = new PublicKey(baseMint);
  const quoteMintKey = new PublicKey(quoteMint);
  const creator = new PublicKey(creatorPublicKey);

  if (!(Number(livePrice) > 0)) {
    throw new Error("A valid live price (from the migrated DAMM v2 pool) is required to initialize the Conviction Pool at the market rate.");
  }

  const [baseInfo, quoteInfo] = await Promise.all([getMintInfo(connection, baseMint), getMintInfo(connection, quoteMint)]);

  const initPrice = DLMM.getPricePerLamport(baseInfo.decimals, quoteInfo.decimals, Number(livePrice));
  const activeId = DLMM.getBinIdFromPrice(initPrice, CONVICTION_BIN_STEP, true);

  const tx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(CONVICTION_BIN_STEP),
    baseMintKey,
    quoteMintKey,
    new BN(activeId),
    new BN(CONVICTION_POOL_FEE_BPS),
    ActivationType.Timestamp,
    false, // hasAlphaVault
    creator,
    undefined, // activationPoint - omitted = active immediately, same convention DBC pools in this project already use
    false, // creatorPoolOnOffControl
    // concreteFunctionType: the SDK's own default (LimitOrder) requires a
    // "token launch proof" check (error 6060, MissingTokenAmountAsTokenLaunchProof)
    // that even a wallet holding millions of the base token failed in
    // live mainnet simulation testing - confirmed by reading the SDK's
    // own bug_fix.test.ts, which explicitly uses LiquidityMining (not the
    // default) for its own working pool-creation test. We want
    // concentrated-liquidity fee generation, not limit orders, so
    // LiquidityMining is also the semantically correct choice here, not
    // just the one that avoids the check.
    DLMM.ConcreteFunctionType.LiquidityMining,
    undefined // collectFeeMode - SDK default (DLMM's own enum, NOT the DBC/CP-AMM one - see dlmm.md's version-fence note)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;

  const [poolAddress] = deriveCustomizablePermissionlessLbPair(baseMintKey, quoteMintKey, DLMM_PROGRAM_ID);

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    poolAddress: poolAddress.toBase58(),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Builds (unsigned, but partially signed by the new position's own
 * required keypair) the transaction that opens a concentrated ("Curve"
 * strategy) position around the DLMM pool's current active bin - the
 * actual "conviction" liquidity. Same partial-sign-then-wallet-signs
 * pattern already proven for a brand new mint keypair in the launch flow
 * (src/tokenLauncher.js) - here it's the position's keypair instead.
 */
export async function preparePositionTransaction({ dlmmPoolAddress, baseMint, quoteMint, creatorPublicKey, baseAmountUi, quoteAmountUi }) {
  if (!(Number(baseAmountUi) > 0) || !(Number(quoteAmountUi) > 0)) {
    throw new Error("Both a base and a quote amount are required to open a Conviction Pool position - this deposits real capital into the position.");
  }

  const poolKey = new PublicKey(dlmmPoolAddress);
  const creator = new PublicKey(creatorPublicKey);
  const dlmm = await DLMM.create(connection, poolKey);

  const activeBin = await dlmm.getActiveBin();
  const minBinId = activeBin.binId - CONVICTION_RANGE_BINS;
  const maxBinId = activeBin.binId + CONVICTION_RANGE_BINS;

  // IMPORTANT: DLMM's tokenX/tokenY on an EXISTING pool are whatever order
  // that pool was actually created with - not necessarily base=X, quote=Y,
  // since the pool's own address is derived from a byte-sorted pair
  // (sortTokenMints internally) independent of argument order, and a pool
  // for this exact pair could in principle already exist from someone
  // else's prior creation with the opposite ordering. Determine X/Y
  // against the known base/quote mints explicitly rather than assuming -
  // getting this backwards would deposit the wrong amount of each token.
  const tokenXMint = dlmm.tokenX.publicKey.toBase58();
  const tokenYMint = dlmm.tokenY.publicKey.toBase58();
  const baseIsX = tokenXMint === baseMint;
  if (!baseIsX && tokenYMint !== baseMint) {
    throw new Error("This DLMM pool's tokens don't match the expected base/quote mints - refusing to guess which side is which.");
  }

  const [baseInfo, quoteInfo] = await Promise.all([getMintInfo(connection, baseMint), getMintInfo(connection, quoteMint)]);
  const baseAmountRaw = new BN(Math.round(Number(baseAmountUi) * 10 ** baseInfo.decimals));
  const quoteAmountRaw = new BN(Math.round(Number(quoteAmountUi) * 10 ** quoteInfo.decimals));
  const totalXAmount = baseIsX ? baseAmountRaw : quoteAmountRaw;
  const totalYAmount = baseIsX ? quoteAmountRaw : baseAmountRaw;

  const positionKeypair = Keypair.generate();

  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Curve },
    user: creator,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;
  tx.partialSign(positionKeypair);

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    positionAddress: positionKeypair.publicKey.toBase58(),
    activeBinId: activeBin.binId,
    minBinId,
    maxBinId,
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Generic submit for either of the two transactions above, once the
 * connected wallet has added its own signature - identical shape to
 * submitClaimCreatorFeeTransaction in dbcMigration.js.
 */
export async function submitConvictionTransaction({ signedTransactionBase64, blockhash, lastValidBlockHeight }) {
  const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`[dlmmConviction] transaction confirmed (tx ${signature})`);
  return { signature };
}
