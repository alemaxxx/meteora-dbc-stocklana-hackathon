import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import { cpAmm, connection } from "./connection.js";
import { getMintInfo } from "./tokenInfo.js";
import { SOL_MINT, USDC_MINT } from "./config.js";
import { STOCK_QUOTE_MINTS } from "./dbcConfig.js";

// Every quote mint this platform has ever used to launch a token - CP-AMM
// pools canonicalize tokenA/tokenB by raw pubkey byte comparison (confirmed
// by reading the DBC SDK's deriveDammV2PoolAddress -> getFirstKey/
// getSecondKey, which sort purely on Buffer.compare), NOT by which one was
// originally "the launched token" - so tokenA/tokenB alone can't tell a
// caller which side is base vs quote. Found 2026-10-02 as a real bug: the
// Explore page's live-price display (public/explore.js's loadDammPrices)
// was showing priceAInB directly as "1 token ≈ X <quote symbol>", which is
// only correct for the ~half of pools where the base happens to be tokenA.
const KNOWN_QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, ...Object.values(STOCK_QUOTE_MINTS).map((s) => s.mint)]);

/**
 * Pure (no RPC/network) resolution of which side of a DAMM v2 pool is base
 * vs quote, by checking which mint is a known quote mint this platform
 * actually uses. Extracted as its own pure function so this logic (the fix
 * for a real bug found 2026-10-02) can be unit-tested directly - see
 * test/dammPoolInfo.test.js.
 */
export function resolveBaseQuote({ tokenAMint, tokenBMint, priceAInB }) {
  const aIsQuote = KNOWN_QUOTE_MINTS.has(tokenAMint);
  const bIsQuote = KNOWN_QUOTE_MINTS.has(tokenBMint);
  // Defaults to true (tokenA=base) for the fallback case (neither/both
  // sides matched a known quote mint, most likely a pool this platform
  // didn't launch) - same A/B order the old code always assumed, so a pool
  // this logic can't classify behaves exactly as before, not worse.
  const baseIsA = !(aIsQuote && !bIsQuote);
  return {
    baseIsA,
    baseMint: baseIsA ? tokenAMint : tokenBMint,
    quoteMint: baseIsA ? tokenBMint : tokenAMint,
    priceBaseInQuote: baseIsA ? Number(priceAInB) : 1 / Number(priceAInB),
  };
}

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

  // Additive fields (baseMint/quoteMint/priceBaseInQuote) alongside the
  // existing tokenAMint/tokenBMint/priceAInB - those stay as-is since this
  // is a public, documented API (see docs.html) and existing external
  // callers may already parse them.
  const tokenAMintStr = poolState.tokenAMint.toBase58();
  const tokenBMintStr = poolState.tokenBMint.toBase58();
  const { baseIsA, baseMint, quoteMint, priceBaseInQuote } = resolveBaseQuote({
    tokenAMint: tokenAMintStr,
    tokenBMint: tokenBMintStr,
    priceAInB: priceAInB.toString(),
  });
  const baseInfo = baseIsA ? tokenAInfo : tokenBInfo;
  const quoteInfo = baseIsA ? tokenBInfo : tokenAInfo;
  const baseTokenMintPk = baseIsA ? poolState.tokenAMint : poolState.tokenBMint;
  const quoteTokenMintPk = baseIsA ? poolState.tokenBMint : poolState.tokenAMint;

  const currentTime = Math.floor(Date.now() / 1000);
  const currentSlot = 0; // only matters for a slot-activated pool; DBC migrations use timestamp activation

  // Always quotes "how much quote do I get for this much base" - the
  // economically meaningful direction for "what would selling some of the
  // launched token look like" - regardless of which side is tokenA/tokenB.
  function quoteFor(amountBaseUi) {
    const amountIn = new BN(Math.round(amountBaseUi * 10 ** baseInfo.decimals));
    const quote = cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint: baseTokenMintPk,
      slippage: 0.5,
      poolState,
      currentTime,
      currentSlot,
      inputTokenInfo: { mint: baseInfo.mint, currentEpoch: baseInfo.currentEpoch },
      outputTokenInfo: { mint: quoteInfo.mint, currentEpoch: quoteInfo.currentEpoch },
      tokenADecimal: tokenAInfo.decimals,
      tokenBDecimal: tokenBInfo.decimals,
    });
    return {
      amountInUi: amountBaseUi,
      amountOutUi: Number(quote.swapOutAmount.toString()) / 10 ** quoteInfo.decimals,
      priceImpactPct: quote.priceImpact,
    };
  }

  // Three fixed small/medium/large sample sizes relative to the pool's
  // own BASE liquidity, same spirit as the pre-launch simulator - not meant
  // to be a trading UI, just "what would a swap actually look like right now."
  const baseLiquidityRaw = baseIsA ? poolState.tokenAAmount : poolState.tokenBAmount;
  const liquidityUi = Number(baseLiquidityRaw?.toString() ?? 0) / 10 ** baseInfo.decimals;
  const sampleSizes = [0.001, 0.01, 0.05].map((pct) => liquidityUi * pct).filter((n) => n > 0);

  return {
    poolAddress: poolKey.toBase58(),
    tokenAMint: tokenAMintStr,
    tokenBMint: tokenBMintStr,
    priceAInB: priceAInB.toString(),
    baseMint,
    quoteMint,
    priceBaseInQuote,
    liquidity: poolState.liquidity.toString(),
    quotes: sampleSizes.length ? sampleSizes.map(quoteFor) : [],
  };
}
