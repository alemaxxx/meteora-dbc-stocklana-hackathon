import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair, SOL_MINT } from "./config.js";
import { sendAndConfirmWithRetry, waitForAccountVisible } from "./txHelpers.js";
import { getOrCreateDbcConfig, createPythAnchoredDbcConfig } from "./dbcConfig.js";

// Launch via Meteora DBC (Dynamic Bonding Curve) - see
// PLANO-DBC-MIGRACAO.md for context (evaluation for the Stocklana
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
// CONFIRMED LIVE on mainnet (2026-09-16, NARWAVE launch, and again on
// 2026-09-17 with a corrected preset) - method names/parameters match the
// installed package's .d.ts (v1.5.12) and createPoolWithFirstBuy has been
// exercised for real with a signed, confirmed transaction. See section 5
// (NARWAVE) and 5.5 of PLANO-DBC-MIGRACAO.md for the live test reports.

function toRawAmount(uiAmount, decimals) {
  const [whole, frac = ""] = String(uiAmount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return new BN(raw || "0");
}

/**
 * Launches a new token on the DBC curve. `firstBuySolUi` is optional -
 * like pump.fun/StonkFun's `buybackSolUi`, it gives an initial push by
 * buying from the creator right at creation, but unlike them it is NOT
 * required (the curve by itself is already the liquidity - the token
 * becomes buyable by anyone as soon as the pool exists, even without this
 * buy).
 *
 * `quoteMint`: only accepts whatever the config accepts
 * (getOrCreateDbcConfig creates a new config per preset+quote combination
 * the first time it's used).
 *
 * `pythSymbol`: when set, ignores `presetId` and anchors the curve to that
 * symbol's live Pyth price instead (see dbcConfig.js/pythPricing.js) -
 * always creates a fresh config, never cached.
 *
 * Returns the new token's mint and the DBC pool address ("virtual" pool -
 * pre-migration; see dbcMigration.js for the final DAMM v2 address).
 */
export async function launchOnDbc({ name, symbol, metadataUri, presetId, pythSymbol, quoteMint = SOL_MINT, firstBuySolUi }) {
  const wallet = requireWalletKeypair();
  const config = pythSymbol
    ? await createPythAnchoredDbcConfig(pythSymbol, quoteMint)
    : await getOrCreateDbcConfig(presetId, quoteMint);

  const hasFirstBuy = Number(firstBuySolUi) > 0;
  const baseMintKeypair = Keypair.generate();

  const createPoolParam = {
    name,
    symbol,
    uri: metadataUri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    config,
    baseMint: baseMintKeypair.publicKey,
  };

  // createPoolWithFirstBuy only ATTACHES the buy instruction when
  // firstBuyParam.buyAmount > 0 (behavior documented by the SDK itself) -
  // that's why the same function can be called in both cases (with or
  // without an initial buy), without needing two separate code paths.
  const tx = await dbcClient.creator.createPoolWithFirstBuy({
    createPoolParam,
    firstBuyParam: hasFirstBuy
      ? {
          buyer: wallet.publicKey,
          buyAmount: toRawAmount(firstBuySolUi, 9), // quote in SOL in most cases - if this ever accepts a quote != SOL for the initial buy, adjust decimals here
          minimumAmountOut: new BN(0), // no slippage guard on the first buy (we're the ones buying on the freshly created curve, price is deterministic) - revisit if this ever comes from outside
          referralTokenAccount: null,
        }
      : undefined,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, hasFirstBuy ? [wallet, baseMintKeypair] : [wallet, baseMintKeypair]);
  const mint = baseMintKeypair.publicKey.toBase58();

  // The DBC pool address doesn't come back from createPoolWithFirstBuy
  // (only the Transaction) - derive/confirm it by reading it back via
  // getPoolByBaseMint, with the same RPC-propagation patience used in
  // getMintInfo/waitForAccountVisible (the mint just confirmed, it might
  // not be visible yet on another replica).
  await waitForAccountVisible(connection, baseMintKeypair.publicKey);
  const poolAccount = await dbcClient.state.getPoolByBaseMint(baseMintKeypair.publicKey);
  if (!poolAccount) {
    const err = new Error(`Token ${symbol} created on DBC (mint ${mint}, tx ${signature}) but couldn't find the pool yet - check on-chain.`);
    err.mint = mint;
    throw err;
  }

  console.log(`[dbcLaunchpad] ${symbol} launched on DBC: mint ${mint}, pool ${poolAccount.publicKey.toBase58()} (tx ${signature})`);

  return {
    mint,
    poolAddress: poolAccount.publicKey.toBase58(),
    signature,
  };
}
