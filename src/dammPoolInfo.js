import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import { cpAmm, connection } from "./connection.js";
import { getMintInfo } from "./tokenInfo.js";

// Public, read-only lookup for a migrated DAMM v2 pool - the natural
// counterpart to getPublicPoolInfo (dbcPoolInfo.js) for pools that have
// ALREADY migrated out of DBC. Added 2026-10-01 after competitive
// research found several competitors let users trade a migrated pool
// in-app instead of linking out to Meteora's own site - this is the
// read-only half of that (live price + a quote preview at a few fixed
// sizes, same UX pattern as simulatePresetBuys in dbcConfig.js).
//
// Deliberately NOT building the actual swap-transaction endpoint yet:
// building it correctly needs the exact same Token-2022
// transfer-fee/transfer-hook handling this project's launch flow already
// relies on, but for a SWAP context specifically (both legs, either
// direction) - that's real transaction-construction code with no way to
// verify it against a real signed-and-submitted swap without spending
// real money, so it's being left for a session with devnet access
// instead of shipped untested.
export async function getDammPoolInfo(poolAddress) {
  const poolKey = new PublicKey(poolAddress);
  const poolState = await cpAmm.fetchPoolState(poolKey).catch(() => null);
  if (!poolState) return null;

  const [tokenAInfo, tokenBInfo] = await Promise.all([
    getMintInfo(connection, poolState.tokenAMint.toBase58()).catch(() => null),
    getMintInfo(connection, poolState.tokenBMint.toBase58()).catch(() => null),
  ]);
  if (!tokenAInfo || !tokenBInfo) return null;

  const priceAInB = getPriceFromSqrtPrice(poolState.sqrtPrice, tokenAInfo.decimals, tokenBInfo.decimals);

  const currentTime = Math.floor(Date.now() / 1000);
  const currentSlot = 0; // only matters for a slot-activated pool; DBC migrations use timestamp activation

  function quoteFor(amountAUi) {
    const amountIn = new BN(Math.round(amountAUi * 10 ** tokenAInfo.decimals));
    const quote = cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint: poolState.tokenAMint,
      slippage: 0.5,
      poolState,
      currentTime,
      currentSlot,
      inputTokenInfo: { mint: tokenAInfo.mint, currentEpoch: tokenAInfo.currentEpoch },
      outputTokenInfo: { mint: tokenBInfo.mint, currentEpoch: tokenBInfo.currentEpoch },
      tokenADecimal: tokenAInfo.decimals,
      tokenBDecimal: tokenBInfo.decimals,
    });
    return {
      amountInUi: amountAUi,
      amountOutUi: Number(quote.swapOutAmount.toString()) / 10 ** tokenBInfo.decimals,
      priceImpactPct: quote.priceImpact,
    };
  }

  // Three fixed small/medium/large sample sizes relative to the pool's
  // own liquidity, same spirit as the pre-launch simulator - not meant to
  // be a trading UI, just "what would a swap actually look like right now."
  const liquidityUi = Number(poolState.tokenAAmount?.toString() ?? 0) / 10 ** tokenAInfo.decimals;
  const sampleSizes = [0.001, 0.01, 0.05].map((pct) => liquidityUi * pct).filter((n) => n > 0);

  return {
    poolAddress: poolKey.toBase58(),
    tokenAMint: poolState.tokenAMint.toBase58(),
    tokenBMint: poolState.tokenBMint.toBase58(),
    priceAInB: priceAInB.toString(),
    liquidity: poolState.liquidity.toString(),
    quotes: sampleSizes.length ? sampleSizes.map(quoteFor) : [],
  };
}
