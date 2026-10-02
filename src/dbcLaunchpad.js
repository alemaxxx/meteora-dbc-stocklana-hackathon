import BN from "bn.js";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { connection, dbcClient } from "./connection.js";
import { SOL_MINT } from "./config.js";
import { waitForAccountVisible } from "./txHelpers.js";
import { getOrCreateDbcConfig, createPythAnchoredDbcConfig } from "./dbcConfig.js";
import { getMintInfo } from "./tokenInfo.js";

// Launch via Meteora DBC (Dynamic Bonding Curve) - see
// DBC-MIGRATION-PLAN.md for context (evaluation for the Stocklana
// hackathon, 2026-09-15). Replaces, in a single step, what today are
// THREE separate stages for the "stonkfun"/"pumpfun" methods (see
// raydiumLaunchpad.js/pumpfunLaunchpad.js + tokenLauncher.js):
//   1. mint/launch the token on a third-party bonding curve,
//   2. buy the quote token with the configured SOL,
//   3. create the DAMM v2 pool pairing the two.
// Here, createPoolWithFirstBuy already mints the token, creates the curve
// (which IS the initial liquidity - no need to buy a quote token or pair
// anything by hand) and optionally makes the first buy as creator, all in
// one transaction. Migration to DAMM v2 happens LATER, once the curve
// reaches the threshold configured in the config (see dbcMigration.js) -
// it's not synchronous with the launch.
//
// WALLET-CONNECT REWORK (2026-09-17, see DBC-MIGRATION-PLAN.md section
// 5.7): launching used to be entirely server-signed, with the server's
// own WALLET_PRIVATE_KEY paying for every launch - since the app has no
// authentication, that meant anyone who found the public URL could spend
// the operator's real SOL just by clicking "Launch Token". Split into two
// phases so the CONNECTING WALLET pays and signs its own launch instead:
// prepareLaunchTransaction (server: builds the tx, partially signs with
// the new mint's own required keypair, does NOT touch the creator's
// signature) and submitLaunchTransaction (server: takes the tx back once
// the browser wallet has completed the signature, sends + confirms it).
// The DBC "config" (the curve's fee/curve recipe) still belongs to the
// server/platform wallet as "partner" - only pool ownership ("creator")
// and payment move to the connecting wallet, which maps cleanly onto
// DBC's own partner/creator role split (see dbcConfig.js).
//
// CONFIRMED LIVE on mainnet (2026-09-16, NARWAVE launch, and again on
// 2026-09-17 with a corrected preset) for the OLD server-signed flow -
// method names/parameters match the installed package's .d.ts (v1.5.12).
// See section 5 (NARWAVE) and 5.5 of DBC-MIGRATION-PLAN.md for those
// live test reports, and 5.7 for this rework's own live test.

function toRawAmount(uiAmount, decimals) {
  const [whole, frac = ""] = String(uiAmount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return new BN(raw || "0");
}

/**
 * Builds (but does not fully sign) the createPoolWithFirstBuy transaction
 * for a new DBC launch, paid for and owned by `creatorPublicKey` (the
 * connected browser wallet), not the server. The server only
 * partially-signs with the new mint's own keypair (required because
 * Solana account creation needs the new account to authorize itself) -
 * the connecting wallet still needs to add its own signature before this
 * can be submitted (see submitLaunchTransaction below).
 *
 * `pythSymbol`: when set, ignores `presetId` and anchors the curve to that
 * symbol's live Pyth price instead (see dbcConfig.js/pythPricing.js) -
 * always creates a fresh config, never cached. Config creation itself is
 * still server-signed (the config belongs to the platform, see above).
 *
 * Returns a base64-encoded, partially-signed transaction plus the new
 * mint's address (needed by the client to know what it's about to
 * create, and by submitLaunchTransaction afterward).
 */
export async function prepareLaunchTransaction({ name, symbol, metadataUri, presetId, pythSymbol, quoteMint = SOL_MINT, firstBuySolUi, creatorPublicKey }) {
  const creator = new PublicKey(creatorPublicKey);
  const config = pythSymbol
    ? await createPythAnchoredDbcConfig(pythSymbol, quoteMint)
    : await getOrCreateDbcConfig(presetId, quoteMint);

  const hasFirstBuy = Number(firstBuySolUi) > 0;
  const baseMintKeypair = Keypair.generate();

  const createPoolParam = {
    name,
    symbol,
    uri: metadataUri,
    payer: creator,
    poolCreator: creator,
    config,
    baseMint: baseMintKeypair.publicKey,
  };

  // BUG FOUND 2026-09-22 (adding stock-quoted presets, see dbcConfig.js):
  // this used to hardcode 9 decimals, assuming the quote is always SOL.
  // The real xStock quote mints use 8 decimals - a hardcoded 9 would have
  // silently bought 10x too much (or failed with insufficient balance).
  // Always read the quote's REAL decimals instead of assuming.
  const quoteInfo = hasFirstBuy ? await getMintInfo(connection, quoteMint) : null;

  // createPoolWithFirstBuy only ATTACHES the buy instruction when
  // firstBuyParam.buyAmount > 0 (behavior documented by the SDK itself) -
  // that's why the same function can be called in both cases (with or
  // without an initial buy), without needing two separate code paths.
  const tx = await dbcClient.creator.createPoolWithFirstBuy({
    createPoolParam,
    firstBuyParam: hasFirstBuy
      ? {
          buyer: creator,
          buyAmount: toRawAmount(firstBuySolUi, quoteInfo.decimals),
          minimumAmountOut: new BN(0), // no slippage guard on the first buy (the creator is buying on the freshly created curve, price is deterministic) - revisit if this ever comes from outside
          referralTokenAccount: null,
        }
      : undefined,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;
  tx.partialSign(baseMintKeypair); // only the mint's own signature - the creator's is still missing

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    mint: baseMintKeypair.publicKey.toBase58(),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Retries getPoolByBaseMint on its own, separately from the mint account -
 * found live on 2026-09-17 (see DBC-MIGRATION-PLAN.md section 5.8): even
 * after the mint account itself was visible, the pool account (a
 * DIFFERENT account) could still lag behind on the RPC replica serving
 * this request, so a single lookup right after confirmation isn't
 * reliably enough - same root cause as the propagation lag documented in
 * txHelpers.js/getMintInfo, just for a different account.
 */
async function waitForPoolByBaseMint(mintPubkey, { attempts = 10, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const pool = await dbcClient.state.getPoolByBaseMint(mintPubkey);
    if (pool) return pool;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Takes a transaction built by prepareLaunchTransaction, now fully signed
 * (mint keypair from the server + creator wallet from the browser),
 * sends and confirms it, then resolves the DBC pool address the same way
 * the old single-phase flow did.
 */
export async function submitLaunchTransaction({ signedTransactionBase64, mint, symbol, blockhash, lastValidBlockHeight }) {
  const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
  const signature = await connection.sendRawTransaction(tx.serialize());
  try {
    // Confirmation strategy object (blockhash + lastValidBlockHeight) instead
    // of the deprecated bare-signature overload - matches sendAndConfirmWithRetry
    // elsewhere and gives a well-defined expiry cutoff instead of guessing.
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (err) {
    // Found 2026-10-02 (code review): confirmTransaction can throw on a
    // confirmation TIMEOUT (slow/inconsistent RPC, blockhash expiry) even
    // when the transaction already landed or lands moments later - a real
    // "chain state vs our record" gap this project has already been bitten
    // by once (see project_launched_tokens_delete_incident.md). Without
    // this, confirmTokenLaunch's catch block would mark the launch
    // "error" with no way to trace the signature that was actually
    // broadcast - attaching it here lets the caller persist it for later
    // reconciliation instead of losing the one piece of evidence needed
    // to check what really happened on-chain.
    err.signature = signature;
    throw err;
  }

  const mintPubkey = new PublicKey(mint);

  // The DBC pool address doesn't come back from createPoolWithFirstBuy
  // (only the Transaction) - derive/confirm it by reading it back, with
  // extra patience on the pool account itself (see waitForPoolByBaseMint).
  await waitForAccountVisible(connection, mintPubkey);
  const poolAccount = await waitForPoolByBaseMint(mintPubkey);
  if (!poolAccount) {
    const err = new Error(`Token ${symbol} created on DBC (mint ${mint}, tx ${signature}) but couldn't find the pool yet - check on-chain.`);
    err.mint = mint;
    err.signature = signature;
    throw err;
  }

  console.log(`[dbcLaunchpad] ${symbol} launched on DBC: mint ${mint}, pool ${poolAccount.publicKey.toBase58()} (tx ${signature})`);

  return {
    mint,
    poolAddress: poolAccount.publicKey.toBase58(),
    signature,
  };
}
