import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  buildCurve,
  buildCurveWithMarketCap,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
  SwapMode,
  deriveTokenBadgeAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair, SOL_MINT, USDC_MINT } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";
import { computePythAnchoredMarketCaps, PYTH_STOCK_SYMBOLS, isPythStockSymbolSupported } from "./pythPricing.js";
import { query } from "./db.js";

// DBC (Dynamic Bonding Curve) "config" step - see DBC-MIGRATION-PLAN.md for
// the full design. A "config" is a SEPARATE account from the pool: it
// defines the curve's shape (fee, supply, DAMM v2 migration threshold,
// etc) and is MEANT TO BE REUSED - Meteora itself recommends one config
// per (quote token + fee/curve rules) combination, not one per launched
// token. Creating a new one costs a transaction + rent; reusing costs
// nothing beyond a read. That's why this file caches the created address
// in the dbc_configs table (see db.js) - moved 2026-09-21 from a flat
// data/dbc-configs.json file, which had no protection against two
// concurrent requests for a brand-new preset both deciding to create one.

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

// Real xStock mints (Backed Finance, Token-2022) on Solana mainnet -
// confirmed via direct on-chain reads on 2026-09-22 (both the mint
// account itself and its Meteora DBC token badge), not just from
// announcements/docs. See the "stock-quoted" presets below for why this
// matters and dbcConfig.js's `resolveTokenBadge` for how the badge gets
// used automatically.
export const STOCK_QUOTE_MINTS = {
  AAPLx: { symbol: "AAPLx", label: "Apple (AAPLx)", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, issuer: "xStocks (Backed Finance)" },
  TSLAx: { symbol: "TSLAx", label: "Tesla (TSLAx)", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, issuer: "xStocks (Backed Finance)" },
  NVDAx: { symbol: "NVDAx", label: "NVIDIA (NVDAx)", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, issuer: "xStocks (Backed Finance)" },
  SPYx: { symbol: "SPYx", label: "S&P 500 (SPYx)", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, issuer: "xStocks (Backed Finance)" },
  // 27 more xStocks added 2026-10-01 - found by diffing this catalog against
  // the community-maintained usestrak/strak registry (public/data/equities.json)
  // after the daily @MeteoraEco ticker-watch routine stalled mid-run. Every
  // one individually re-verified on-chain (dbcClient.state.getTokenBadge +
  // Token-2022 extension profile via getMint/getExtensionTypes), not trusted
  // from the registry alone - same discipline as every other entry here.
  AMDx: { symbol: "AMDx", label: "AMD (AMDx)", mint: "XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF", decimals: 8, issuer: "xStocks (Backed Finance)" },
  AMZNx: { symbol: "AMZNx", label: "Amazon (AMZNx)", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", decimals: 8, issuer: "xStocks (Backed Finance)" },
  AVGOx: { symbol: "AVGOx", label: "Broadcom (AVGOx)", mint: "XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo", decimals: 8, issuer: "xStocks (Backed Finance)" },
  "BRK.Bx": { symbol: "BRK.Bx", label: "Berkshire Hathaway (BRK.Bx)", mint: "Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x", decimals: 8, issuer: "xStocks (Backed Finance)" },
  COINx: { symbol: "COINx", label: "Coinbase (COINx)", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8, issuer: "xStocks (Backed Finance)" },
  CRCLx: { symbol: "CRCLx", label: "Circle (CRCLx)", mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", decimals: 8, issuer: "xStocks (Backed Finance)" },
  DFDVx: { symbol: "DFDVx", label: "DeFi Development Corp (DFDVx)", mint: "Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy", decimals: 8, issuer: "xStocks (Backed Finance)" },
  GLDx: { symbol: "GLDx", label: "Gold (GLDx)", mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", decimals: 8, issuer: "xStocks (Backed Finance)" },
  GMEx: { symbol: "GMEx", label: "GameStop (GMEx)", mint: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc", decimals: 8, issuer: "xStocks (Backed Finance)" },
  GOOGLx: { symbol: "GOOGLx", label: "Alphabet (GOOGLx)", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", decimals: 8, issuer: "xStocks (Backed Finance)" },
  HOODx: { symbol: "HOODx", label: "Robinhood (HOODx)", mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", decimals: 8, issuer: "xStocks (Backed Finance)" },
  INTCx: { symbol: "INTCx", label: "Intel (INTCx)", mint: "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM", decimals: 8, issuer: "xStocks (Backed Finance)" },
  KOx: { symbol: "KOx", label: "Coca-Cola (KOx)", mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", decimals: 8, issuer: "xStocks (Backed Finance)" },
  MCDx: { symbol: "MCDx", label: "McDonald's (MCDx)", mint: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2", decimals: 8, issuer: "xStocks (Backed Finance)" },
  METAx: { symbol: "METAx", label: "Meta Platforms (METAx)", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", decimals: 8, issuer: "xStocks (Backed Finance)" },
  MSFTx: { symbol: "MSFTx", label: "Microsoft (MSFTx)", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", decimals: 8, issuer: "xStocks (Backed Finance)" },
  MSTRx: { symbol: "MSTRx", label: "MicroStrategy (MSTRx)", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8, issuer: "xStocks (Backed Finance)" },
  PLTRx: { symbol: "PLTRx", label: "Palantir (PLTRx)", mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4", decimals: 8, issuer: "xStocks (Backed Finance)" },
  QQQx: { symbol: "QQQx", label: "Nasdaq-100 (QQQx)", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8, issuer: "xStocks (Backed Finance)" },
  SPCXx: { symbol: "SPCXx", label: "SpaceX (SPCXx)", mint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", decimals: 8, issuer: "xStocks (Backed Finance)" },
  STRCx: { symbol: "STRCx", label: "Strategy Preferred (STRCx)", mint: "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH", decimals: 8, issuer: "xStocks (Backed Finance)" },
  TQQQx: { symbol: "TQQQx", label: "ProShares UltraPro QQQ (TQQQx)", mint: "XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc", decimals: 8, issuer: "xStocks (Backed Finance)" },
  TSMx: { symbol: "TSMx", label: "Taiwan Semiconductor (TSMx)", mint: "XsafvsGtzFqqHgTnA3aPC83EAMkacU5mcGtcSayhpVV", decimals: 8, issuer: "xStocks (Backed Finance)" },
  UNHx: { symbol: "UNHx", label: "UnitedHealth (UNHx)", mint: "XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe", decimals: 8, issuer: "xStocks (Backed Finance)" },
  VIDAx: { symbol: "VIDAx", label: "Vida Global (VIDAx)", mint: "XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk", decimals: 8, issuer: "xStocks (Backed Finance)" },
  WMTx: { symbol: "WMTx", label: "Walmart (WMTx)", mint: "Xs151QeqTCiuKtinzfRATnUESM2xTU6V9Wy8Vy538ci", decimals: 8, issuer: "xStocks (Backed Finance)" },
  XOMx: { symbol: "XOMx", label: "Exxon Mobil (XOMx)", mint: "XsaHND8sHyfMfsWPj6kSdd5VwvCayZvjYgKmmcNL5qh", decimals: 8, issuer: "xStocks (Backed Finance)" },
  // Backpack Securities - a SEPARATE, competing tokenized-stock issuer from
  // Backed Finance's xStocks above (confirmed 2026-09-26: different mints,
  // different legal structure - direct 1:1 redeemable security entitlement
  // vs xStocks' cash-settled tracker). Every single one below was
  // individually checked on-chain (dbcClient.state.getTokenBadge AND the
  // mint's real Token-2022 extensions, not assumed) before being added -
  // 59/59 checked so far came back badged, Token-2022, 6 decimals, with
  // the IDENTICAL extension set (permanentDelegate, inactive transferHook,
  // scaledUiAmountConfig, pausableConfig, etc.) - so the same DAMM v2
  // migration compatibility reasoning applies to all of them
  // (CreatePoolWithoutMintValidation is a DBC-program-level permission,
  // not mint-specific - see project_token_badge_feasibility.md). Real
  // mint addresses sourced from the community-maintained usestrak/strak
  // registry (github.com/usestrak/strak, public/data/equities.json) -
  // cross-checked against the 6 addresses already independently verified
  // via web search before trusting the rest of that list. Still only a
  // subset of Backpack's full catalog (~41-200+ and growing toward a
  // publicly-announced 10,000) - not exhaustive. Listed alphabetically by
  // symbol (also how the frontend renders each issuer's dropdown).
  AMC: { symbol: "AMC", label: "AMC Entertainment (AMC, Backpack Securities)", mint: "AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc", decimals: 6, issuer: "Backpack Securities" },
  AMD: { symbol: "AMD", label: "Advanced Micro Devices (AMD, Backpack Securities)", mint: "AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES", decimals: 6, issuer: "Backpack Securities" },
  BA: { symbol: "BA", label: "Boeing (BA, Backpack Securities)", mint: "BArimz1PcKZr8PcPh3tcZ2dg4S7FJLk3cw6R5F8GsHKg", decimals: 6, issuer: "Backpack Securities" },
  BABA: { symbol: "BABA", label: "Alibaba (BABA, Backpack Securities)", mint: "BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp", decimals: 6, issuer: "Backpack Securities" },
  BB: { symbol: "BB", label: "BlackBerry (BB, Backpack Securities)", mint: "BBosJLw8ZzoATiEyywiifx7AgmrD2Cm3XjFWbhbRhChy", decimals: 6, issuer: "Backpack Securities" },
  BOT: { symbol: "BOT", label: "RoboStrategy (BOT, Backpack Securities)", mint: "BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T", decimals: 6, issuer: "Backpack Securities" },
  BROS: { symbol: "BROS", label: "Dutch Bros (BROS, Backpack Securities)", mint: "BRVaZKg6J9iF2BEsdpsxJ9NyvN9PPxPZuoQUX2v8qqkk", decimals: 6, issuer: "Backpack Securities" },
  BULL: { symbol: "BULL", label: "BULL (Backpack Securities)", mint: "BULL151gUXcFV5wXEUqu9Am2L7Qt4bTJRLRuAUjkcspC", decimals: 6, issuer: "Backpack Securities" },
  COPX: { symbol: "COPX", label: "Global X Copper Miners ETF (COPX, Backpack Securities)", mint: "CzLTZppPdZtTjyq3WGpHLstoc3GLhu7zH5Zg6xUa6Gv5", decimals: 6, issuer: "Backpack Securities" },
  COST: { symbol: "COST", label: "Costco (COST, Backpack Securities)", mint: "CZEB3WNZuF2Yz1z2H81RcCk8T7fsw82KB33zqamASVsg", decimals: 6, issuer: "Backpack Securities" },
  CRWV: { symbol: "CRWV", label: "CoreWeave (CRWV, Backpack Securities)", mint: "CRWVJeR2yEZuDUKYfGuKCHvLz8ywn4LGvovHfy5WiFmi", decimals: 6, issuer: "Backpack Securities" },
  CYPH: { symbol: "CYPH", label: "Cypherpunk Technologies (CYPH, Backpack Securities)", mint: "CYPHuMmCL1GxJWa2tsPhLKykC7GrHJTCHwbXD4g5uawK", decimals: 6, issuer: "Backpack Securities" },
  DELL: { symbol: "DELL", label: "Dell Technologies (DELL, Backpack Securities)", mint: "DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy", decimals: 6, issuer: "Backpack Securities" },
  DJT: { symbol: "DJT", label: "Trump Media & Technology Group (DJT, Backpack Securities)", mint: "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF", decimals: 6, issuer: "Backpack Securities" },
  DKNG: { symbol: "DKNG", label: "DraftKings (DKNG, Backpack Securities)", mint: "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow", decimals: 6, issuer: "Backpack Securities" },
  DNUT: { symbol: "DNUT", label: "Krispy Kreme (DNUT, Backpack Securities)", mint: "DNUTsCvKbKwu2RM72cUuW3TD9YpzArzACcqYQssjPLSk", decimals: 6, issuer: "Backpack Securities" },
  DRAM: { symbol: "DRAM", label: "Roundhill DRAM Memory ETF (DRAM, Backpack Securities)", mint: "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw", decimals: 6, issuer: "Backpack Securities" },
  FLWS: { symbol: "FLWS", label: "1-800-Flowers.com (FLWS, Backpack Securities)", mint: "FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", decimals: 6, issuer: "Backpack Securities" },
  FLY: { symbol: "FLY", label: "Firefly Aerospace (FLY, Backpack Securities)", mint: "FLYRq3en8r2Z69gN3KyAnDrvnitEJNkwPYY7favinHeD", decimals: 6, issuer: "Backpack Securities" },
  FWDI: { symbol: "FWDI", label: "Forward Industries (FWDI, Backpack Securities)", mint: "FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz", decimals: 6, issuer: "Backpack Securities" },
  GPRO: { symbol: "GPRO", label: "GoPro (GPRO, Backpack Securities)", mint: "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH", decimals: 6, issuer: "Backpack Securities" },
  GRND: { symbol: "GRND", label: "Grindr (GRND, Backpack Securities)", mint: "GRNDYDpqwpCm6jVxpbh4xT5AM4r3p391qYsKTHqgaET2", decimals: 6, issuer: "Backpack Securities" },
  HIMS: { symbol: "HIMS", label: "Hims & Hers Health (HIMS, Backpack Securities)", mint: "HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx", decimals: 6, issuer: "Backpack Securities" },
  HOOD: { symbol: "HOOD", label: "Robinhood (HOOD, Backpack Securities)", mint: "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A", decimals: 6, issuer: "Backpack Securities" },
  HTZ: { symbol: "HTZ", label: "Hertz (HTZ, Backpack Securities)", mint: "HTZsLG4zqaNvWMwXSLHH3GG5KyJpKwpBRsKVdMG6hvzP", decimals: 6, issuer: "Backpack Securities" },
  IBM: { symbol: "IBM", label: "IBM (IBM, Backpack Securities)", mint: "BMKdM4yUxX12moFqVk195k7coMbaybd4RUKCUdm7D1Sk", decimals: 6, issuer: "Backpack Securities" },
  INTC: { symbol: "INTC", label: "Intel (INTC, Backpack Securities)", mint: "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF", decimals: 6, issuer: "Backpack Securities" },
  IONQ: { symbol: "IONQ", label: "IonQ (IONQ, Backpack Securities)", mint: "NQ5hSuXQZrbnrwcDVk2qN73njjd3E3v3badYHnj5thF", decimals: 6, issuer: "Backpack Securities" },
  IREN: { symbol: "IREN", label: "IREN (IREN, Backpack Securities)", mint: "RENzhrJQgmAnfcLhU1U5XwAMc6TC15UA6jCbPBaasnj", decimals: 6, issuer: "Backpack Securities" },
  JNJ: { symbol: "JNJ", label: "Johnson & Johnson (JNJ, Backpack Securities)", mint: "JNJg1znKdF712Phe7L7z52AATAvEjEytBdN2w8Lnh1Y", decimals: 6, issuer: "Backpack Securities" },
  LLY: { symbol: "LLY", label: "Eli Lilly (LLY, Backpack Securities)", mint: "LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD", decimals: 6, issuer: "Backpack Securities" },
  LMT: { symbol: "LMT", label: "Lockheed Martin (LMT, Backpack Securities)", mint: "LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV", decimals: 6, issuer: "Backpack Securities" },
  LULU: { symbol: "LULU", label: "Lululemon (LULU, Backpack Securities)", mint: "LULUmT9VMttkfAJE236LXJcYJ2tTP7nunrSWR5G1BdS", decimals: 6, issuer: "Backpack Securities" },
  LUV: { symbol: "LUV", label: "Southwest Airlines (LUV, Backpack Securities)", mint: "LUV9GB51PNZNRyzzyYK3rtqFfvDvWtRiXZ34wVq2HrX", decimals: 6, issuer: "Backpack Securities" },
  MGM: { symbol: "MGM", label: "MGM Resorts (MGM, Backpack Securities)", mint: "MGMuubtUEirmkhfEQdmGUh4pr7HuUdMWcZXFtpPbVJD", decimals: 6, issuer: "Backpack Securities" },
  MRNA: { symbol: "MRNA", label: "Moderna (MRNA, Backpack Securities)", mint: "MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT", decimals: 6, issuer: "Backpack Securities" },
  MRVL: { symbol: "MRVL", label: "Marvell Technology (MRVL, Backpack Securities)", mint: "MRVLSjkR2ceUBukujaD3xCyHP1H3B2SzpsNTZF546jo", decimals: 6, issuer: "Backpack Securities" },
  MSTR: { symbol: "MSTR", label: "Strategy (MSTR, Backpack Securities)", mint: "MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz", decimals: 6, issuer: "Backpack Securities" },
  MU: { symbol: "MU", label: "Micron (MU, Backpack Securities)", mint: "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1", decimals: 6, issuer: "Backpack Securities" },
  NBIS: { symbol: "NBIS", label: "Nebius Group (NBIS, Backpack Securities)", mint: "NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG", decimals: 6, issuer: "Backpack Securities" },
  NKE: { symbol: "NKE", label: "Nike (NKE, Backpack Securities)", mint: "NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg", decimals: 6, issuer: "Backpack Securities" },
  PFE: { symbol: "PFE", label: "Pfizer (PFE, Backpack Securities)", mint: "PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x", decimals: 6, issuer: "Backpack Securities" },
  PTN: { symbol: "PTN", label: "Palatin Technologies (PTN, Backpack Securities)", mint: "PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP", decimals: 6, issuer: "Backpack Securities" },
  QUBT: { symbol: "QUBT", label: "Quantum Computing Inc (QUBT, Backpack Securities)", mint: "QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw", decimals: 6, issuer: "Backpack Securities" },
  RBLX: { symbol: "RBLX", label: "Roblox (RBLX, Backpack Securities)", mint: "RBLXDGRD64AtRamHMFVcjqne3Ar7NLWtFtYNtsrf1cE", decimals: 6, issuer: "Backpack Securities" },
  RDDT: { symbol: "RDDT", label: "Reddit (RDDT, Backpack Securities)", mint: "RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh", decimals: 6, issuer: "Backpack Securities" },
  RIVN: { symbol: "RIVN", label: "Rivian (RIVN, Backpack Securities)", mint: "RcZmt84VMJv9bDhKqmw1uWDahYrUT468VwAChTnfD8p", decimals: 6, issuer: "Backpack Securities" },
  RKLB: { symbol: "RKLB", label: "Rocket Lab (RKLB, Backpack Securities)", mint: "RKLBnAXGqv31iZomqsuAWkQm1aqC7JwwvbCfzGdqAhz", decimals: 6, issuer: "Backpack Securities" },
  RUM: { symbol: "RUM", label: "Rumble (RUM, Backpack Securities)", mint: "RUMsPfFZFnN1ZmGANwP7FNMJMjKH4m9RiMePrtVtLe7", decimals: 6, issuer: "Backpack Securities" },
  SCHH: { symbol: "SCHH", label: "Schwab US REIT ETF (SCHH, Backpack Securities)", mint: "SCHHJ3jRdSjeFEVAaLrnYdx3Brphn92Ys7z1qkiCtPX", decimals: 6, issuer: "Backpack Securities" },
  SHOP: { symbol: "SHOP", label: "Shopify (SHOP, Backpack Securities)", mint: "SH55hfaipFAbwT42nQYhRoM5o5t61QpkmJ6p62vXB3m", decimals: 6, issuer: "Backpack Securities" },
  SKHY: { symbol: "SKHY", label: "SK Hynix (SKHY, Backpack Securities)", mint: "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3", decimals: 6, issuer: "Backpack Securities" },
  SNAP: { symbol: "SNAP", label: "Snap (SNAP, Backpack Securities)", mint: "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz", decimals: 6, issuer: "Backpack Securities" },
  SNDK: { symbol: "SNDK", label: "SanDisk (SNDK, Backpack Securities)", mint: "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH", decimals: 6, issuer: "Backpack Securities" },
  SPCX: { symbol: "SPCX", label: "SpaceX (SPCX, Backpack Securities)", mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", decimals: 6, issuer: "Backpack Securities" },
  SPHR: { symbol: "SPHR", label: "Sphere Entertainment (SPHR, Backpack Securities)", mint: "SPHRp8cZaSQBTp1KMNP4V1X821SXhXWt4Q2yLdyHzju", decimals: 6, issuer: "Backpack Securities" },
  TTWO: { symbol: "TTWO", label: "Take-Two Interactive (TTWO, Backpack Securities)", mint: "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo", decimals: 6, issuer: "Backpack Securities" },
  UPS: { symbol: "UPS", label: "United Parcel Service (UPS, Backpack Securities)", mint: "UPSqUeMHcWbkdg784XuBUEF9DtySSnW9ur5LAVdcuB9", decimals: 6, issuer: "Backpack Securities" },
  URA: { symbol: "URA", label: "Global X Uranium ETF (URA, Backpack Securities)", mint: "URARfsinxCRw4JpvQhuT4CxavdZXZEMjv9ZwWmWpwag", decimals: 6, issuer: "Backpack Securities" },
  WEN: { symbol: "WEN", label: "Wendy's (WEN, Backpack Securities)", mint: "WENAZ2WyPbmgvUcKfQ8hyMDfBQP9bZ65hsZ5KTFrRGZ", decimals: 6, issuer: "Backpack Securities" },
  WULF: { symbol: "WULF", label: "TeraWulf (WULF, Backpack Securities)", mint: "WULFeyfrj1VJKD9HhRTcW8R4g5HefUA11HDEdBv2WxD", decimals: 6, issuer: "Backpack Securities" },

  // Third stock issuer added (2026-10-01): Ondo (Ondo Finance's "Ondo
  // Stocks"/formerly "Ondo Global Markets" - a real competitive-research
  // find, named explicitly in Meteora's own Crypto World's Fair wishlist
  // ("xStocks, Backpack Onchain, Ondo RFQ, and the rest of the catalog").
  // 452 tickers exist in Ondo's own live catalog (`app.ondo.finance`'s
  // public `/api/v2/assets`); mint addresses cross-referenced via
  // Jupiter's token API (`lite-api.jup.ag/tokens/v2/search`, filtered to
  // `tags.includes("ondo")` + the real Token-2022 program id - never
  // trusted from a single source). 92 of 93 checked large/well-known
  // tickers passed the SAME on-chain discipline as every other issuer
  // here (real getTokenBadge + the identical 7-extension Token-2022
  // profile) - the one rejection (GOOG, Alphabet's Class C share) has no
  // Meteora token badge yet, unlike GOOGL (Class A), a genuine finding,
  // not an oversight. Decimals are 9 for every Ondo mint checked
  // (different from xStocks' 8 and Backpack's 6 - confirmed per-mint via
  // real getMint calls, not assumed uniform).
  AALon: { symbol: "AALon", label: "American Airlines Group (AALon, Ondo)", mint: "9wYZetvT8J2ptfsRca5gzLBGvcUug38mp9yT3xaondo", decimals: 9, issuer: "Ondo" },
  AAPLon: { symbol: "AAPLon", label: "Apple (AAPLon, Ondo)", mint: "123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo", decimals: 9, issuer: "Ondo" },
  ABBVon: { symbol: "ABBVon", label: "AbbVie (ABBVon, Ondo)", mint: "MFerpBVGKZh2jXN7cbJdXRXQTp6j6pbSnSZrfWrondo", decimals: 9, issuer: "Ondo" },
  ABNBon: { symbol: "ABNBon", label: "Airbnb (ABNBon, Ondo)", mint: "128qNYovdGv2YqayErcJgU7gDwbNVX1VuoxbtWz8ondo", decimals: 9, issuer: "Ondo" },
  ABTon: { symbol: "ABTon", label: "Abbott (ABTon, Ondo)", mint: "129gRoHKhVg7CvPMrqVsEB4uYZo6zV4yDZX6NBg9ondo", decimals: 9, issuer: "Ondo" },
  ACNon: { symbol: "ACNon", label: "Accenture (ACNon, Ondo)", mint: "12LxMMJYVSf4LoeqjFE47BQQNRciaH9E3nbDfjH4ondo", decimals: 9, issuer: "Ondo" },
  ADBEon: { symbol: "ADBEon", label: "Adobe (ADBEon, Ondo)", mint: "12Rh6JhfW4X5fKP16bbUdb4pcVCKDHFB48x8GG33ondo", decimals: 9, issuer: "Ondo" },
  ADIon: { symbol: "ADIon", label: "Analog Devices (ADIon, Ondo)", mint: "LmTMwmZLNZszn3qpjmnbhfP12U4qWDivaEBwSBSondo", decimals: 9, issuer: "Ondo" },
  AGon: { symbol: "AGon", label: "First Majestic Silver (AGon, Ondo)", mint: "hrZ5vs6c6v1iWyvEXjGSHs3sQuuj58VzXikNyRWondo", decimals: 9, issuer: "Ondo" },
  ALABon: { symbol: "ALABon", label: "Astera Labs (ALABon, Ondo)", mint: "cskxd6aqyqJMYgLZmFYfYecWkjasRJDEtm1QVxsondo", decimals: 9, issuer: "Ondo" },
  ALBon: { symbol: "ALBon", label: "Albemarle (ALBon, Ondo)", mint: "B5KufqHkskgGYwMXtL8FSHgREAkMQvE3ykhH5Kmondo", decimals: 9, issuer: "Ondo" },
  AMATon: { symbol: "AMATon", label: "Applied Materials (AMATon, Ondo)", mint: "7eRX747PSbVtGVx3qD5UFdkNM2BfTy86ikUiCMhondo", decimals: 9, issuer: "Ondo" },
  AMCon: { symbol: "AMCon", label: "AMC Entertainment (AMCon, Ondo)", mint: "C9xNaNujcF1a5fidWAAFReFYqhLRVbyk4yPyGqzondo", decimals: 9, issuer: "Ondo" },
  AMDon: { symbol: "AMDon", label: "AMD (AMDon, Ondo)", mint: "14diAn5z8kjrKwSC8WLqvBqqe5YmihJhjxRxd8Z6ondo", decimals: 9, issuer: "Ondo" },
  AMEon: { symbol: "AMEon", label: "AMETEK (AMEon, Ondo)", mint: "ko48myqhBuXyL9WAp6pTzHWsdKsGKSditJVoGTSondo", decimals: 9, issuer: "Ondo" },
  AMGNon: { symbol: "AMGNon", label: "Amgen (AMGNon, Ondo)", mint: "SS6AEWhzRrxhL2cXzKKjhFt3rCzmHHGKmFyugDTondo", decimals: 9, issuer: "Ondo" },
  AMZNon: { symbol: "AMZNon", label: "Amazon (AMZNon, Ondo)", mint: "14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo", decimals: 9, issuer: "Ondo" },
  ANETon: { symbol: "ANETon", label: "Arista Networks (ANETon, Ondo)", mint: "Cq6QtvHpXbJWtFaiMhUDtHy8YVZ95gcD1oZ1cohondo", decimals: 9, issuer: "Ondo" },
  APHon: { symbol: "APHon", label: "Amphenol (APHon, Ondo)", mint: "fFTZ9Jckm2X811mdqRBS4ckMz5bRAJVjH4Jwofwondo", decimals: 9, issuer: "Ondo" },
  APOon: { symbol: "APOon", label: "Apollo Global Management (APOon, Ondo)", mint: "14VXAhoa1R74vi1ZuiQyGLJrnDMfoFBPJSCpGVz3ondo", decimals: 9, issuer: "Ondo" },
  APPon: { symbol: "APPon", label: "AppLovin (APPon, Ondo)", mint: "14Z8rQQe2Aza33YgEUmj3g3QGNz8DXLiFPuCnsD1ondo", decimals: 9, issuer: "Ondo" },
  ARMon: { symbol: "ARMon", label: "Arm Holdings plc (ARMon, Ondo)", mint: "15SsCZqCsM9fZGhTmP4rdJTPT9WGZKazDSsgeQ8ondo", decimals: 9, issuer: "Ondo" },
  ASMLon: { symbol: "ASMLon", label: "ASML Holding NV (ASMLon, Ondo)", mint: "1eLZPRsn8bAKmoxsqDMH9Q2m2k7GMNp6RLSQGm8ondo", decimals: 9, issuer: "Ondo" },
  AVGOon: { symbol: "AVGOon", label: "Broadcom (AVGOon, Ondo)", mint: "1FWZtdWN7y38BSXGzbs8D6Shk88oL9atDNgbVz9ondo", decimals: 9, issuer: "Ondo" },
  AXPon: { symbol: "AXPon", label: "American Express (AXPon, Ondo)", mint: "1WxT6NdK7uqpfXuKpALxL2n3f7Rq61XXeHA8UM4ondo", decimals: 9, issuer: "Ondo" },
  BABAon: { symbol: "BABAon", label: "Alibaba (BABAon, Ondo)", mint: "1zvb9ELBFShBCWKEk5jRTJAaPAwtVt7quEXx1X4ondo", decimals: 9, issuer: "Ondo" },
  BACon: { symbol: "BACon", label: "Bank of America (BACon, Ondo)", mint: "Wk8gC6iTNp8dqd4ghkJ3h1giiUnyhykwHh7tYWjondo", decimals: 9, issuer: "Ondo" },
  BAon: { symbol: "BAon", label: "Boeing (BAon, Ondo)", mint: "1YVZ4LGpq8CAhpdpm3mgy7GgPb83gJczCpxLUQ3ondo", decimals: 9, issuer: "Ondo" },
  BEon: { symbol: "BEon", label: "Bloom Energy (BEon, Ondo)", mint: "bBMTGF7atoCizHMT3KCeqJzqR2gXFSUXr53AEDgondo", decimals: 9, issuer: "Ondo" },
  BIDUon: { symbol: "BIDUon", label: "Baidu (BIDUon, Ondo)", mint: "54CoRF2FYMZNJg9tS36xq5BUcLZ7rju1r59jGc2ondo", decimals: 9, issuer: "Ondo" },
  BILIon: { symbol: "BILIon", label: "Bilibili (BILIon, Ondo)", mint: "14kLsQVmc64qZexYuR4XGop9y8BeMkd77pJUm1Rhondo", decimals: 9, issuer: "Ondo" },
  BLKon: { symbol: "BLKon", label: "BlackRock, Inc. (BLKon, Ondo)", mint: "5H1VpMzRuoNtRbPTRCz35ETtEUtnkt8hJuQb9v7ondo", decimals: 9, issuer: "Ondo" },
  CATon: { symbol: "CATon", label: "Caterpillar (CATon, Ondo)", mint: "AErxJJxGbc9cZzZoZepN62BNfg5RXns8tmEc3Zpondo", decimals: 9, issuer: "Ondo" },
  CCJon: { symbol: "CCJon", label: "Cameco (CCJon, Ondo)", mint: "fVPj4hHHVEeUrzVnad5fvxFEPGAXD5X6wkw1Xjdondo", decimals: 9, issuer: "Ondo" },
  CIFRon: { symbol: "CIFRon", label: "Cipher Mining (CIFRon, Ondo)", mint: "WNZBSkNBNP3Ct1pcFn6Fu4sZQFhnu48EsM9voCEondo", decimals: 9, issuer: "Ondo" },
  CLFon: { symbol: "CLFon", label: "Cleveland-Cliffs (CLFon, Ondo)", mint: "fTuoE9pWbVK7EUpUEENBn8Vu226T7kF3YJBTRLPondo", decimals: 9, issuer: "Ondo" },
  CLSon: { symbol: "CLSon", label: "Celestica (CLSon, Ondo)", mint: "eL1buL9zFxFhfRbjMfyPu2q9HSAJkUUnHVUgkPdondo", decimals: 9, issuer: "Ondo" },
  CMGon: { symbol: "CMGon", label: "Chipotle (CMGon, Ondo)", mint: "5owVsVFSHACQuippFYdLp3qWRobp2EGcwxMmsr6ondo", decimals: 9, issuer: "Ondo" },
  COFon: { symbol: "COFon", label: "Capital One (COFon, Ondo)", mint: "R2uDbMtmHq5xSS5SserrovdRKdpiqnVBCd2AHLhondo", decimals: 9, issuer: "Ondo" },
  COHRon: { symbol: "COHRon", label: "Coherent (COHRon, Ondo)", mint: "BXMkru8ded26p71gJ3AMMwJmwZaYYfQjRo8vbZzondo", decimals: 9, issuer: "Ondo" },
  COINon: { symbol: "COINon", label: "Coinbase (COINon, Ondo)", mint: "5u6KDiNJXxX4rGMfYT4BApZQC5CuDNrG6MHkwp1ondo", decimals: 9, issuer: "Ondo" },
  COPon: { symbol: "COPon", label: "ConocoPhillips (COPon, Ondo)", mint: "X68p9qTpEMkR1TLpXUP2ZJo8PG4Qge2Y2ZLdjA2ondo", decimals: 9, issuer: "Ondo" },
  CORZon: { symbol: "CORZon", label: "Core Scientific (CORZon, Ondo)", mint: "f4ucqqnktrkdDAnwqcAAiA9Lggz6NAHJ3zFwipnondo", decimals: 9, issuer: "Ondo" },
  COSTon: { symbol: "COSTon", label: "Costco (COSTon, Ondo)", mint: "6btaz134wjHkR8sqhAYrtSM6tavftfxnRvnyMd8ondo", decimals: 9, issuer: "Ondo" },
  CPNGon: { symbol: "CPNGon", label: "Coupang (CPNGon, Ondo)", mint: "NKyzy31w2J7odLb2CW3Ft4fpKXkW3LBt1pvpkVLondo", decimals: 9, issuer: "Ondo" },
  CRCLon: { symbol: "CRCLon", label: "Circle Internet Group (CRCLon, Ondo)", mint: "6xHEyem9hmkGtVq6XGCiQUGpPsHBaoYuYdFNZa5ondo", decimals: 9, issuer: "Ondo" },
  CRMon: { symbol: "CRMon", label: "Salesforce (CRMon, Ondo)", mint: "7D7ukbcnUNYt7Et5vtsDZhAy28MKu9pkHka1Hp9ondo", decimals: 9, issuer: "Ondo" },
  CRWDon: { symbol: "CRWDon", label: "CrowdStrike (CRWDon, Ondo)", mint: "cdKfoNjbXgnSuxvoajhtH3uixfZhq1YXhQsS1Rwondo", decimals: 9, issuer: "Ondo" },
  CRWVon: { symbol: "CRWVon", label: "CoreWeave (CRWVon, Ondo)", mint: "BfPGpgNyxe6rjAru1EJarjSBAcCABuMF5L32v7nondo", decimals: 9, issuer: "Ondo" },
  CSCOon: { symbol: "CSCOon", label: "Cisco Systems (CSCOon, Ondo)", mint: "7DWcZE1uVc8m2mf9pV8KNov28ET7HsvHkhrhgr9ondo", decimals: 9, issuer: "Ondo" },
  CVNAon: { symbol: "CVNAon", label: "Carvana (CVNAon, Ondo)", mint: "FGmUDXqA3AbWfo5b3NUcsvwoUFCF4tr9ea6uercondo", decimals: 9, issuer: "Ondo" },
  CVXon: { symbol: "CVXon", label: "Chevron (CVXon, Ondo)", mint: "7tgKziACteG26VjV5xKufojKxwTgCFyTwmWUmz5ondo", decimals: 9, issuer: "Ondo" },
  DASHon: { symbol: "DASHon", label: "DoorDash (DASHon, Ondo)", mint: "83P1gCFBZfGRCwJuBt9juxJKEsZwejJoG66eTZ6ondo", decimals: 9, issuer: "Ondo" },
  DELLon: { symbol: "DELLon", label: "Dell Technologies (DELLon, Ondo)", mint: "cFDP5SsUBeKrV1RkKHdaofHBSfRW8cBd7DiaPTSLAon", decimals: 9, issuer: "Ondo" },
  DEon: { symbol: "DEon", label: "Deere (DEon, Ondo)", mint: "CqQyAZjB9LGFTG95eiadGTkfhd9QA12ProeKsQmondo", decimals: 9, issuer: "Ondo" },
  DISon: { symbol: "DISon", label: "Disney (DISon, Ondo)", mint: "mJf1xT3suXtkXBCfZcE9oUUuyxkvSgqYBWiX7v1ondo", decimals: 9, issuer: "Ondo" },
  EMRon: { symbol: "EMRon", label: "Emerson Electric (EMRon, Ondo)", mint: "nNyVbs9Qty6wU2YcP5KFh4SUxNWTdPtL2W1bTMrondo", decimals: 9, issuer: "Ondo" },
  ENBon: { symbol: "ENBon", label: "Enbridge (ENBon, Ondo)", mint: "aqEnHXRnXEQwDXEiFSEU4xHziw3Fco4b5JPkTtnondo", decimals: 9, issuer: "Ondo" },
  ENPHon: { symbol: "ENPHon", label: "Enphase Energy (ENPHon, Ondo)", mint: "Bp26APthMuM46gMFTo5KYpo7b92GN2xSCor7f9oondo", decimals: 9, issuer: "Ondo" },
  EQIXon: { symbol: "EQIXon", label: "Equinix (EQIXon, Ondo)", mint: "aheEdmuryJU8ymy8LjYheZH5i2BW1UMsfuWQKD2ondo", decimals: 9, issuer: "Ondo" },
  ETNon: { symbol: "ETNon", label: "Eaton (ETNon, Ondo)", mint: "BpYiU1dBXU1fdB64jbR93wHEw3Y47QeRLZvUyLQondo", decimals: 9, issuer: "Ondo" },
  FCXon: { symbol: "FCXon", label: "Freeport-McMoRan (FCXon, Ondo)", mint: "CY8ttw5rYCT6fFBJwqXofefqa7Ji9E8zfLmhRLmondo", decimals: 9, issuer: "Ondo" },
  FIGon: { symbol: "FIGon", label: "Figma (FIGon, Ondo)", mint: "aLDdFsr3VTUQaHFK6yNvQxztvxQ8nxW4AMuSGC7ondo", decimals: 9, issuer: "Ondo" },
  Fon: { symbol: "Fon", label: "Ford Motor (Fon, Ondo)", mint: "5hT2o25X9tGXipwhLckaUdgnxrZ6Y8eiUwdhpLeondo", decimals: 9, issuer: "Ondo" },
  FUTUon: { symbol: "FUTUon", label: "Futu Holdings (FUTUon, Ondo)", mint: "Ao5rKFRQ54W3DKSAtqfhBRPNHewwWRLNLao2JL9ondo", decimals: 9, issuer: "Ondo" },
  GDon: { symbol: "GDon", label: "General Dynamics (GDon, Ondo)", mint: "hESwwvKsJH4p7Xib5rrM921Ng19cwcQGtxyrgSJondo", decimals: 9, issuer: "Ondo" },
  GEon: { symbol: "GEon", label: "General Electric (GEon, Ondo)", mint: "aTBfDuLRqYHBiG82bHA7DzwjSDTFre2dRtGH3S5ondo", decimals: 9, issuer: "Ondo" },
  GEVon: { symbol: "GEVon", label: "GE Vernova (GEVon, Ondo)", mint: "CgZSv89BL58ybWfWobANKEU8nV9jYfFw23G2DZEondo", decimals: 9, issuer: "Ondo" },
  GFSon: { symbol: "GFSon", label: "GlobalFoundries (GFSon, Ondo)", mint: "etnBzce6pkJq67QUv78PefkVyCEaA6YBE4hvx1Gondo", decimals: 9, issuer: "Ondo" },
  GLWon: { symbol: "GLWon", label: "Corning (GLWon, Ondo)", mint: "YQzNQh2YSFQ6nh91E8Ja71U6JuZDLap5jJCsELGondo", decimals: 9, issuer: "Ondo" },
  GLXYon: { symbol: "GLXYon", label: "Galaxy Digital (GLXYon, Ondo)", mint: "CkWmEM2J79k6AjAwyQVHXteFucAL1zQrKLxLqJHondo", decimals: 9, issuer: "Ondo" },
  GMEon: { symbol: "GMEon", label: "GameStop (GMEon, Ondo)", mint: "aznKt8v32CwYMEcTcB4bGTv8DXWStCpHrcCtyy7ondo", decimals: 9, issuer: "Ondo" },
  GNRCon: { symbol: "GNRCon", label: "Generac Holdings (GNRCon, Ondo)", mint: "eqzwohR9oCR6sravF4y5HyUwyvCDbnfSYqiiFrXondo", decimals: 9, issuer: "Ondo" },
  GOOGLon: { symbol: "GOOGLon", label: "Alphabet Class A (GOOGLon, Ondo)", mint: "bbahNA5vT9WJeYft8tALrH1LXWffjwqVoUbqYa1ondo", decimals: 9, issuer: "Ondo" },
  GRABon: { symbol: "GRABon", label: "Grab Holdings (GRABon, Ondo)", mint: "m9GcsVgdjaL3KsdtSFHimnhtsUMpTHkjtwEG4Tzondo", decimals: 9, issuer: "Ondo" },
  GSon: { symbol: "GSon", label: "Goldman Sachs (GSon, Ondo)", mint: "BchJRy2snmhJZf3rQ9LJ3ePs2BGfYgfvQNo31d2ondo", decimals: 9, issuer: "Ondo" },
  HALon: { symbol: "HALon", label: "Halliburton (HALon, Ondo)", mint: "iFcwEB2LfeYLWKgZ2vogEzC5dP7s7xbhVX81XFwondo", decimals: 9, issuer: "Ondo" },
  HDon: { symbol: "HDon", label: "Home Depot (HDon, Ondo)", mint: "MtEXKVN3Pcggy8MPA3eJr15H6SK3RXheScqj9qtondo", decimals: 9, issuer: "Ondo" },
  HIIon: { symbol: "HIIon", label: "Huntington Ingalls Industries (HIIon, Ondo)", mint: "h73FNVBDq95fqGBy5eunHm2FVfu2jWZNkeXHDieondo", decimals: 9, issuer: "Ondo" },
  HOODon: { symbol: "HOODon", label: "Robinhood Markets (HOODon, Ondo)", mint: "BVdXGvmgi6A9oAiwWvBvP76fyTqcCNRJMM7zMN6ondo", decimals: 9, issuer: "Ondo" },
  HPEon: { symbol: "HPEon", label: "Hewlett Packard Enterprise (HPEon, Ondo)", mint: "axbgKgUMscTJ34DjA69kBJuf6UYq4Pzb8B8numYondo", decimals: 9, issuer: "Ondo" },
  HUTon: { symbol: "HUTon", label: "Hut 8 (HUTon, Ondo)", mint: "f7iz4BQsnjw95EUyFiBKAnKgo7oBrycfzQdtmDwondo", decimals: 9, issuer: "Ondo" },
  IBMon: { symbol: "IBMon", label: "IBM (IBMon, Ondo)", mint: "C8bZkgSxXkyT1RgxByp2teJ24hgimPLoyEYoNa9ondo", decimals: 9, issuer: "Ondo" },
  INTCon: { symbol: "INTCon", label: "Intel (INTCon, Ondo)", mint: "cJpUMp5R7rZ6fGeLHbHhrRuJzK9mkyKDjZqNpT3ondo", decimals: 9, issuer: "Ondo" },
  INTUon: { symbol: "INTUon", label: "Intuit (INTUon, Ondo)", mint: "CozoH5HBTyyeYSQxHcWpGzd4Sq5XBaKzBzvTtN3ondo", decimals: 9, issuer: "Ondo" },
  IONQon: { symbol: "IONQon", label: "IonQ (IONQon, Ondo)", mint: "DDZQijTbaSd3Kas1r1bgCnHPayk8vTP8SfZWp5Tondo", decimals: 9, issuer: "Ondo" },
  IRENon: { symbol: "IRENon", label: "IREN (IRENon, Ondo)", mint: "13QHuepdhtJ3urNsV9i1hdL8nQoca2G7ZaLzb5FYondo", decimals: 9, issuer: "Ondo" },
  ISRGon: { symbol: "ISRGon", label: "Intuitive Surgical (ISRGon, Ondo)", mint: "1MGRpPrkhEsCm2GCWD3rsvEU77xTTLAzfKXeFgFondo", decimals: 9, issuer: "Ondo" },
  JDon: { symbol: "JDon", label: "JD.com (JDon, Ondo)", mint: "E1aUS5nyv7kaBzdQzPVJW5zfaMgoUJpKYzdnFS2ondo", decimals: 9, issuer: "Ondo" },
  JNJon: { symbol: "JNJon", label: "Johnson & Johnson (JNJon, Ondo)", mint: "KUXt7LzHWSQXp5eyqMZRxWjAP6yM8BUh4LRHwiwondo", decimals: 9, issuer: "Ondo" },
  JPMon: { symbol: "JPMon", label: "JPMorgan Chase (JPMon, Ondo)", mint: "E5Gczsavxcomqf6Cw1sGCKLabL1xYD2FzKxVoB4ondo", decimals: 9, issuer: "Ondo" },
  KLACon: { symbol: "KLACon", label: "KLA (KLACon, Ondo)", mint: "149o8ppQf9SzKCKXZ4v3dzHkwumvtQSRzSEkr29uondo", decimals: 9, issuer: "Ondo" },
  KOon: { symbol: "KOon", label: "Coca-Cola (KOon, Ondo)", mint: "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo", decimals: 9, issuer: "Ondo" },
  LINon: { symbol: "LINon", label: "Linde plc (LINon, Ondo)", mint: "Edik9MoFp8LAXS9HNu2gRFyihwYqDqv4ZmNmVT9ondo", decimals: 9, issuer: "Ondo" },
  LIon: { symbol: "LIon", label: "Li Auto (LIon, Ondo)", mint: "v12TwfofSbvVqQ5N5KGG4d3J8rtEi4BjGfn2apyondo", decimals: 9, issuer: "Ondo" },
  LMTon: { symbol: "LMTon", label: "Lockheed (LMTon, Ondo)", mint: "EoReHwUnGGekbXFHLj5rbCVKiwWqu32GrETMfw4ondo", decimals: 9, issuer: "Ondo" },
  LOWon: { symbol: "LOWon", label: "Lowe's (LOWon, Ondo)", mint: "edLdFJVVR532qhcrNTJjLAmhmyV7NsctbWVokMBondo", decimals: 9, issuer: "Ondo" },
  LRCXon: { symbol: "LRCXon", label: "Lam Research (LRCXon, Ondo)", mint: "wFJoeEYpKg9oRhyJy6BWTT3J95gmXBLvoeikDQNondo", decimals: 9, issuer: "Ondo" },
  MAon: { symbol: "MAon", label: "Mastercard (MAon, Ondo)", mint: "EsVHcyRxXFJCLMiuYLWhoDygrNe1BJGpYeZ17X7ondo", decimals: 9, issuer: "Ondo" },
  MARAon: { symbol: "MARAon", label: "MARA Holdings (MARAon, Ondo)", mint: "ETCJUmuhs5aY62xgEVWCZ5JR8KPdeXUaJz3LuC5ondo", decimals: 9, issuer: "Ondo" },
  MCDon: { symbol: "MCDon", label: "McDonald's (MCDon, Ondo)", mint: "EUbJjmDt8JA222M91bVLZs211siZ2jzbFArH9N3ondo", decimals: 9, issuer: "Ondo" },
  MELIon: { symbol: "MELIon", label: "MercadoLibre (MELIon, Ondo)", mint: "EWwdgGshGngcMpDV34pWZRSu5bkAuiKuKTTHKQ8ondo", decimals: 9, issuer: "Ondo" },
  METAon: { symbol: "METAon", label: "Meta Platforms (METAon, Ondo)", mint: "fDxs5y12E7x7jBwCKBXGqt71uJmCWsAQ3Srkte6ondo", decimals: 9, issuer: "Ondo" },
  MRKon: { symbol: "MRKon", label: "Merck (MRKon, Ondo)", mint: "bn1fb8dwzafGePqNPrM8m8cbAKQiFqeEPuZkPySondo", decimals: 9, issuer: "Ondo" },
  MRNAon: { symbol: "MRNAon", label: "Moderna (MRNAon, Ondo)", mint: "14VP7DvCAdBCc5XGNZkPt6zhtPzJrWWS64Koxtxyondo", decimals: 9, issuer: "Ondo" },
  MRVLon: { symbol: "MRVLon", label: "Marvell Technology (MRVLon, Ondo)", mint: "FovBwhoV5KQjZCdhoM6jgXYwXLX3F8vgAfvmLH7ondo", decimals: 9, issuer: "Ondo" },
  MSFTon: { symbol: "MSFTon", label: "Microsoft (MSFTon, Ondo)", mint: "FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo", decimals: 9, issuer: "Ondo" },
  MSTRon: { symbol: "MSTRon", label: "MicroStrategy (MSTRon, Ondo)", mint: "FSz4ouiqXpHuGPcpacZfTzbMjScoj5FfzHkiyu2ondo", decimals: 9, issuer: "Ondo" },
  MUon: { symbol: "MUon", label: "Micron Technology (MUon, Ondo)", mint: "Fz9edBpaURPPzpKVRR1A8PENYDEgHqwx5D5th28ondo", decimals: 9, issuer: "Ondo" },
  NEEon: { symbol: "NEEon", label: "NextEra Energy (NEEon, Ondo)", mint: "t7eN6cGwRMFaZvsNW2SmVwkedmHtDdrxA4ycNE5ondo", decimals: 9, issuer: "Ondo" },
  NEMon: { symbol: "NEMon", label: "Newmont (NEMon, Ondo)", mint: "Dig28Tf1ufhCBAsjTmFkXCgcNgMqDMYj5A2rDQmondo", decimals: 9, issuer: "Ondo" },
  NETon: { symbol: "NETon", label: "Cloudflare (NETon, Ondo)", mint: "ZtAY65FCh3YB9H1wkbjRxxY5nXt9VfuTTz3Mzbuondo", decimals: 9, issuer: "Ondo" },
  NFLXon: { symbol: "NFLXon", label: "Netflix (NFLXon, Ondo)", mint: "g4KnPrxPLeeKkwvDmZFMtYQPM64eHeShbD55vK6ondo", decimals: 9, issuer: "Ondo" },
  NIOon: { symbol: "NIOon", label: "NIO (NIOon, Ondo)", mint: "yQ37dFiGAbzrb2FRAEhGNzRy5zFfoYGWYhAepFEondo", decimals: 9, issuer: "Ondo" },
  NKEon: { symbol: "NKEon", label: "Nike (NKEon, Ondo)", mint: "g646pcdG2Rt5DH9WZzL7VVnVDWCCMTTrnktwE74ondo", decimals: 9, issuer: "Ondo" },
  NOCon: { symbol: "NOCon", label: "Northrop Grumman (NOCon, Ondo)", mint: "Dm6FpQ76SsbVmAZ4NvD2mjZP7cxbw1CASr4WwCiondo", decimals: 9, issuer: "Ondo" },
  NOKon: { symbol: "NOKon", label: "Nokia (NOKon, Ondo)", mint: "amE2ANm5dyG6RTkJHdtzvWcuR8ChBZCEm5Jiqwdondo", decimals: 9, issuer: "Ondo" },
  NOWon: { symbol: "NOWon", label: "ServiceNow (NOWon, Ondo)", mint: "G7pTVoSECz5RQWubEnTP7AC83KHUsSyoiqYR1R2ondo", decimals: 9, issuer: "Ondo" },
  NTESon: { symbol: "NTESon", label: "NetEase (NTESon, Ondo)", mint: "YeK2TdPtGLAme3Phg4pb1GBN2YxKgX5UNVyD4asondo", decimals: 9, issuer: "Ondo" },
  NUEon: { symbol: "NUEon", label: "Nucor (NUEon, Ondo)", mint: "mvAUPvwKPW4rbbTXkqCvcZEG45XCeRHSVcLVym8ondo", decimals: 9, issuer: "Ondo" },
  NVDAon: { symbol: "NVDAon", label: "NVIDIA (NVDAon, Ondo)", mint: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo", decimals: 9, issuer: "Ondo" },
  ONon: { symbol: "ONon", label: "ON Semiconductor (ONon, Ondo)", mint: "13qtwy5fZi9Przz14pzo9xqFSr8QHmLyUpUCvP1xondo", decimals: 9, issuer: "Ondo" },
  OPENon: { symbol: "OPENon", label: "Opendoor Technologies (OPENon, Ondo)", mint: "ou1uE526v7zmUYP2qCb2LJgfXAyWAtWS9SETtr8ondo", decimals: 9, issuer: "Ondo" },
  ORCLon: { symbol: "ORCLon", label: "Oracle (ORCLon, Ondo)", mint: "GmDADFpfwjfzZq9MfCafMDTS69MgVjtzD7Fd9a4ondo", decimals: 9, issuer: "Ondo" },
  OXYon: { symbol: "OXYon", label: "Occidental Petroleum (OXYon, Ondo)", mint: "1GNFMryQ6c9ZpMhgNimmsbtgYM21qnBJgRAFoNiondo", decimals: 9, issuer: "Ondo" },
  PANWon: { symbol: "PANWon", label: "Palo Alto Networks (PANWon, Ondo)", mint: "M7hVQomhw4Q2D2op3HvBrZjHu9SryjNvD5haEZ1ondo", decimals: 9, issuer: "Ondo" },
  PDDon: { symbol: "PDDon", label: "PDD Holdings (PDDon, Ondo)", mint: "PnjETBCLC318DRejo9cMQKAmET9PvW8AEFGWMNtondo", decimals: 9, issuer: "Ondo" },
  PEPon: { symbol: "PEPon", label: "PepsiCo (PEPon, Ondo)", mint: "gud6b3fYekjhMG5F818BALwbg2vt4JKoow59Md9ondo", decimals: 9, issuer: "Ondo" },
  PFEon: { symbol: "PFEon", label: "Pfizer (PFEon, Ondo)", mint: "Gwh9fPsX1qWATXy63vNaJnAFfwebWQtZaVmPko6ondo", decimals: 9, issuer: "Ondo" },
  PGon: { symbol: "PGon", label: "Procter & Gamble (PGon, Ondo)", mint: "GZ8v4NdSG7CTRZqHMgNsTPRULeVi8CpdWd9wZY8ondo", decimals: 9, issuer: "Ondo" },
  PINSon: { symbol: "PINSon", label: "Pinterest (PINSon, Ondo)", mint: "sxyg1VTSzy5zYANUK7hntNtmFAWoXGJq95AcHuVondo", decimals: 9, issuer: "Ondo" },
  PLTRon: { symbol: "PLTRon", label: "Palantir Technologies (PLTRon, Ondo)", mint: "HfsnTS5qtdStwec9DfBrunRqnAMYMMz1kjv9Hu9ondo", decimals: 9, issuer: "Ondo" },
  PLUGon: { symbol: "PLUGon", label: "Plug Power (PLUGon, Ondo)", mint: "TnfswqdE1jAJ8sfnf5J7kSVLEH1cfpAYZ8MWmKfondo", decimals: 9, issuer: "Ondo" },
  PWRon: { symbol: "PWRon", label: "Quanta Services (PWRon, Ondo)", mint: "f1yQz2fo7S24NqrsfaWDkmQ8xoa8yU72c9rEEBdondo", decimals: 9, issuer: "Ondo" },
  PYPLon: { symbol: "PYPLon", label: "PayPal (PYPLon, Ondo)", mint: "hM7B3UQTTR81mS27SxDDPzBbjejmo8fnpFjzgv9ondo", decimals: 9, issuer: "Ondo" },
  QCOMon: { symbol: "QCOMon", label: "Qualcomm (QCOMon, Ondo)", mint: "hrmX7MV5hifoaBVjnrdpz698yABxrbBNAcWtWo9ondo", decimals: 9, issuer: "Ondo" },
  RDDTon: { symbol: "RDDTon", label: "Reddit (RDDTon, Ondo)", mint: "HXFrTf9v9NdjGUTnx4sojR3Cf92hoBsQFUxKTN7ondo", decimals: 9, issuer: "Ondo" },
  REGNon: { symbol: "REGNon", label: "Regeneron Pharmaceuticals (REGNon, Ondo)", mint: "E86mX2yb3HLbJM6gRtZQ6dCYmLh6MSDZadu9SCPondo", decimals: 9, issuer: "Ondo" },
  RIOTon: { symbol: "RIOTon", label: "Riot Platforms (RIOTon, Ondo)", mint: "i6f3DvZBuLpnGSqS8x6WPeStJ7jNe5KewD6afD5ondo", decimals: 9, issuer: "Ondo" },
  RIVNon: { symbol: "RIVNon", label: "Rivian Automotive (RIVNon, Ondo)", mint: "AXRsYFt7TXNQ3DcY6BkvRgPV6VsYMURyDtaeudjondo", decimals: 9, issuer: "Ondo" },
  RKLBon: { symbol: "RKLBon", label: "Rocket Lab (RKLBon, Ondo)", mint: "E9VQY3VnrpVSekFByzRmfeK1kxgM3UiKCoVVbdUondo", decimals: 9, issuer: "Ondo" },
  RTXon: { symbol: "RTXon", label: "RTX (RTXon, Ondo)", mint: "12BvLZtzjdssAycxPeBQUjukhmgQpULAvy6SroYdondo", decimals: 9, issuer: "Ondo" },
  SAPon: { symbol: "SAPon", label: "SAP (SAPon, Ondo)", mint: "bjbrNi96mXAzgvxSuGJ2SRJ5U4N8agbG7wUAKAjondo", decimals: 9, issuer: "Ondo" },
  SBETon: { symbol: "SBETon", label: "SharpLink Gaming, Inc (SBETon, Ondo)", mint: "iLDu2jjp2i3Uqc2Vm7K7GLiUj3hR4Un49MtD7c4ondo", decimals: 9, issuer: "Ondo" },
  SBUXon: { symbol: "SBUXon", label: "Starbucks (SBUXon, Ondo)", mint: "iPFqjcZQTNMNXA4kbShbMhfAVD8yr8Uq9UtXMV6ondo", decimals: 9, issuer: "Ondo" },
  SCCOon: { symbol: "SCCOon", label: "Southern Copper (SCCOon, Ondo)", mint: "EANjzFjj3nPXHdzN5CE3Z8LLVn69Ce77FE8X4cvondo", decimals: 9, issuer: "Ondo" },
  SCHWon: { symbol: "SCHWon", label: "Charles Schwab (SCHWon, Ondo)", mint: "cnc6M1zXLdrGR5LAQVcaJDfgezMiVWNtGQsVy1Kondo", decimals: 9, issuer: "Ondo" },
  SEDGon: { symbol: "SEDGon", label: "SolarEdge Technologies (SEDGon, Ondo)", mint: "EAwP9LGNjTkQ2YeKE6CGKqBYtrJ6APFvRe7KCMmondo", decimals: 9, issuer: "Ondo" },
  SHOPon: { symbol: "SHOPon", label: "Shopify (SHOPon, Ondo)", mint: "ivdDracs2s7jCP698dJXKSEQdVrNj9hasJL1Uq1ondo", decimals: 9, issuer: "Ondo" },
  SLBon: { symbol: "SLBon", label: "SLB (SLBon, Ondo)", mint: "i7ZS13SF6BCKbzvLujp2UqLNMgM1XVnZ7A7wC6tondo", decimals: 9, issuer: "Ondo" },
  SLVon: { symbol: "SLVon", label: "iShares Silver Trust (SLVon, Ondo)", mint: "iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo", decimals: 9, issuer: "Ondo" },
  SMCIon: { symbol: "SMCIon", label: "Super Micro Computer (SMCIon, Ondo)", mint: "jLca79XzcewRuBZyaJxVxuKpUHcEix1X4CP1RP9ondo", decimals: 9, issuer: "Ondo" },
  SNAPon: { symbol: "SNAPon", label: "Snap (SNAPon, Ondo)", mint: "a2cXfonVgQ6cKB4Lm8YZsPry39VZSA562bwmRSiondo", decimals: 9, issuer: "Ondo" },
  SNOWon: { symbol: "SNOWon", label: "Snowflake (SNOWon, Ondo)", mint: "JmFLCBwoNvcXy6B2VqABg6m784ubkXpaEx3p7S5ondo", decimals: 9, issuer: "Ondo" },
  SOFIon: { symbol: "SOFIon", label: "SoFi Technologies (SOFIon, Ondo)", mint: "mqL8yXQpeSvc7NgrAtLLPtRvUiWyLoG5RWLv16iondo", decimals: 9, issuer: "Ondo" },
  SOon: { symbol: "SOon", label: "Southern (SOon, Ondo)", mint: "aKzjn2ZdWySSGPSSDTY2HUpcSCmemSahTXihrpyondo", decimals: 9, issuer: "Ondo" },
  SOUNon: { symbol: "SOUNon", label: "SoundHound AI (SOUNon, Ondo)", mint: "vE2qArmjto6VfeMngyGAnzp2ipLYeXsxiARDnnXondo", decimals: 9, issuer: "Ondo" },
  SPCXon: { symbol: "SPCXon", label: "SpaceX (SPCXon, Ondo)", mint: "wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo", decimals: 9, issuer: "Ondo" },
  SPGIon: { symbol: "SPGIon", label: "S&P Global (SPGIon, Ondo)", mint: "JrTYw7A9jihX5TwpRStYviEbsYf2X2VJpZ13719ondo", decimals: 9, issuer: "Ondo" },
  SPOTon: { symbol: "SPOTon", label: "Spotify (SPOTon, Ondo)", mint: "jzCvs2Pk8tDcfsFRqnEMjurgaQW4iQfEkandUR8ondo", decimals: 9, issuer: "Ondo" },
  SPYon: { symbol: "SPYon", label: "SPDR S&P 500 ETF Trust (SPYon, Ondo)", mint: "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo", decimals: 9, issuer: "Ondo" },
  STLDon: { symbol: "STLDon", label: "Steel Dynamics (STLDon, Ondo)", mint: "n7DwzSkv1SBkcA9qj8LU9sZ9sRn72Z6spU2w2b9ondo", decimals: 9, issuer: "Ondo" },
  STMon: { symbol: "STMon", label: "STMicroelectronics (STMon, Ondo)", mint: "bM2VSRfbYPt29YRD9F2wTCSCSQaHtNCuz1znNDCondo", decimals: 9, issuer: "Ondo" },
  STXon: { symbol: "STXon", label: "Seagate (STXon, Ondo)", mint: "EXtprP1wzrNo2bByrU9JyzqEg2hQMSCVJakeHHYondo", decimals: 9, issuer: "Ondo" },
  SWKSon: { symbol: "SWKSon", label: "Skyworks Solutions (SWKSon, Ondo)", mint: "iJtKb1CWnWdgJhs7HgSZvLmSJABGGMc97QeuG7tondo", decimals: 9, issuer: "Ondo" },
  TCOMon: { symbol: "TCOMon", label: "Trip.com Group (TCOMon, Ondo)", mint: "9PMjLqd8zPdKkJUXarnit5t7tPL3cCscwHzy7ATondo", decimals: 9, issuer: "Ondo" },
  TELon: { symbol: "TELon", label: "TE Connectivity (TELon, Ondo)", mint: "ZjYCwYeG85TbV5oXkCkvWQTNPh2PgTQ8X4nxpbyondo", decimals: 9, issuer: "Ondo" },
  TMon: { symbol: "TMon", label: "Toyota (TMon, Ondo)", mint: "kbmF7ERJWMaaDswMprrH9gHSLya5D2RMBNgKqg3ondo", decimals: 9, issuer: "Ondo" },
  TMOon: { symbol: "TMOon", label: "Thermo Fisher Scientific (TMOon, Ondo)", mint: "T699bgtXQw4CJ59rQ4VzLsupVQUzoL5RmuhHnKrondo", decimals: 9, issuer: "Ondo" },
  TMUSon: { symbol: "TMUSon", label: "T-Mobile US (TMUSon, Ondo)", mint: "pDY4GPJfZcNETPG7myXeafQfgJqqVkn81bMYDyfondo", decimals: 9, issuer: "Ondo" },
  Ton: { symbol: "Ton", label: "AT&T (Ton, Ondo)", mint: "WKMZummev5UcXz5nNKQZvTD6QjNSM2X58uwmDReondo", decimals: 9, issuer: "Ondo" },
  TSLAon: { symbol: "TSLAon", label: "Tesla (TSLAon, Ondo)", mint: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo", decimals: 9, issuer: "Ondo" },
  TSMon: { symbol: "TSMon", label: "Taiwan Semiconductor Manufacturing (TSMon, Ondo)", mint: "keybg184d4vyXeQdFqs4o99YsMg7xBthxTJ6Ky3ondo", decimals: 9, issuer: "Ondo" },
  TTon: { symbol: "TTon", label: "Trane Technologies (TTon, Ondo)", mint: "erp2t2My8UoFgyRt39EmnnSiDUwUM5aNKw5piBKondo", decimals: 9, issuer: "Ondo" },
  TXNon: { symbol: "TXNon", label: "Texas Instruments (TXNon, Ondo)", mint: "81xLFvCzFaUM3KDxSHC75pXu3RPCeSeCbmGBY8aondo", decimals: 9, issuer: "Ondo" },
  UBERon: { symbol: "UBERon", label: "Uber (UBERon, Ondo)", mint: "KJNeFW3kk3ycPjXpC6cbuyckjeYHacc2ekhtAi5ondo", decimals: 9, issuer: "Ondo" },
  UNHon: { symbol: "UNHon", label: "UnitedHealth (UNHon, Ondo)", mint: "kPBGL8vAwKN3UGmr9cjkM2dU79SC3nzTC9yu7F8ondo", decimals: 9, issuer: "Ondo" },
  UNPon: { symbol: "UNPon", label: "Union Pacific Corporation (UNPon, Ondo)", mint: "EvsME8gdnEwPLbTnhrGVDwrY35zBuB8hEGCq59Hondo", decimals: 9, issuer: "Ondo" },
  Von: { symbol: "Von", label: "Visa (Von, Ondo)", mint: "kxEW4oJL75K37VeXaZF1ynbHQATQwhECQKN1374ondo", decimals: 9, issuer: "Ondo" },
  VRSNon: { symbol: "VRSNon", label: "VeriSign (VRSNon, Ondo)", mint: "ja4bMvHL3Hw9Ey33VGWyDeXvrHvQWyBnK4GSmCUondo", decimals: 9, issuer: "Ondo" },
  VRTXon: { symbol: "VRTXon", label: "Vertex Pharmaceuticals (VRTXon, Ondo)", mint: "FL7QzUq58pvkDxkftJm7RqRWgqYEFZwXuvAMsUnondo", decimals: 9, issuer: "Ondo" },
  VSTon: { symbol: "VSTon", label: "Vistra (VSTon, Ondo)", mint: "h6MW8GFpfzxFa1JNn6hZNnBF3t4fj9SHAXKy6LXondo", decimals: 9, issuer: "Ondo" },
  VZon: { symbol: "VZon", label: "Verizon (VZon, Ondo)", mint: "igu1coP6n3GPaWmbd8J9Z7UAyLpV254uQFFNfydondo", decimals: 9, issuer: "Ondo" },
  WDCon: { symbol: "WDCon", label: "Western Digital (WDCon, Ondo)", mint: "FLqH2jB2DZPJP5nnVFAakRKaNTcDZtq71Pnpp6Aondo", decimals: 9, issuer: "Ondo" },
  WFCon: { symbol: "WFCon", label: "Wells Fargo (WFCon, Ondo)", mint: "L6ZE5qCpVVSqLePz64CrwkgyWoPF9M7tB8BeFH4ondo", decimals: 9, issuer: "Ondo" },
  WMBon: { symbol: "WMBon", label: "Williams (WMBon, Ondo)", mint: "bvjmEwQBqbMr6rnx5a74boBz6nmA1DNThujPnNAondo", decimals: 9, issuer: "Ondo" },
  WMon: { symbol: "WMon", label: "Waste Management (WMon, Ondo)", mint: "FPvKvWzSzDZqgYmSZUetrkpUXSwo2VtpR4BynVYondo", decimals: 9, issuer: "Ondo" },
  WMTon: { symbol: "WMTon", label: "Walmart (WMTon, Ondo)", mint: "LZddqAqKqJW9oMZSjTxCUmbmzBRQtv9gMkD9hZ3ondo", decimals: 9, issuer: "Ondo" },
  WOLFon: { symbol: "WOLFon", label: "Wolfspeed (WOLFon, Ondo)", mint: "Zfb5PTVfGa8AV6VxrTQJuP8CjMXFPMVkVVNpcAWondo", decimals: 9, issuer: "Ondo" },
  XOMon: { symbol: "XOMon", label: "Exxon Mobil (XOMon, Ondo)", mint: "qCYD74QnXzd9pzv6pGHQKJVwoibL6sNcPQDnpDiondo", decimals: 9, issuer: "Ondo" },
  XYZon: { symbol: "XYZon", label: "Block (XYZon, Ondo)", mint: "BWxe2FVciUbwrCUZQPUKiREBh5LmVa5AiUqNLAkondo", decimals: 9, issuer: "Ondo" },
};

export const DBC_CURVE_PRESETS = [
  {
    id: "baixa-taxa-2h-linear",
    group: "Fee-shape curves",
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
    group: "Fee-shape curves",
    label: "Default (10%→1% fee over 2h, migrates at 10 SOL accumulated in the curve) - triggers GMGN's \"high tax\" alert (found on NARWAVE), use with caution",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20, // 20% of the supply migrates to the DAMM v2 pool, the rest stays with whoever bought on the curve
    migrationQuoteThreshold: 10, // SOL accumulated in the curve to unlock migration - confirmed against the official dbc_config.jsonc
    startingFeeBps: 1000, // 10%
    endingFeeBps: 100, // 1%
    schedulerDurationSeconds: 7200, // 2h, same default already used in presets.js (SCHEDULER_DURATION_SECONDS)
  },
  // Three more fee/curve shapes added 2026-09-17 in direct response to the
  // Crypto World's Fair brief's own "ideas we'd love to see": "novel curve
  // or fee configurations" naming "Flat Curve, Exponential Curve, or Long
  // Curve" as examples - all three below map onto one of those verbatim,
  // reusing the same 10 SOL threshold and 1B/20% supply split already
  // validated for the two presets above (only the fee shape changes).
  {
    id: "flat-1pct",
    group: "Fee-shape curves",
    label: "Flat curve (1% fee, never decays, migrates at 10 SOL accumulated in the curve) - simplest possible fee shape, no scheduler to reason about",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 100, // 1%, flat
    endingFeeBps: 100,
    // A real "no decay" fee needs numberOfPeriod/totalDuration at exactly
    // ZERO, not just startingFeeBps === endingFeeBps over some nonzero
    // duration - confirmed live against the installed SDK (v1.5.12):
    // buildCurve rejects a matching start/end with a nonzero duration
    // with "numberOfPeriod and totalDuration must both be zero".
    schedulerDurationSeconds: 0,
  },
  {
    id: "exponencial-2h",
    group: "Fee-shape curves",
    label: "Exponential curve (5%→0.5% over 2h, decays fast then slow, migrates at 10 SOL accumulated in the curve) - front-loads the fee harder than the linear presets",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 500, // 5% - still below the ~10% GMGN "high tax" line, with headroom for exponential's faster initial drop
    endingFeeBps: 50, // 0.5%
    schedulerDurationSeconds: 7200,
    baseFeeMode: BaseFeeMode.FeeSchedulerExponential, // SAME FeeSchedulerParams shape as linear - only this enum value differs (confirmed against the installed SDK's .d.ts)
  },
  {
    id: "long-24h-linear",
    group: "Fee-shape curves",
    label: "Long curve (3%→0.5% over 24h, migrates at 10 SOL accumulated in the curve) - same fee range as the low-fee preset, stretched over a full day instead of 2h",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 86400, // 24h instead of 7200 (2h) - the only thing that makes this "long"
  },
  // Added 2026-09-17, same round as the three above - the other explicit
  // idea named by the Crypto World's Fair brief: "Compounding Liquidity
  // DAMM v2 Pools". DBC already supports this at migration time via
  // MigrationFeeOption.Customizable + a migratedPoolFee block (confirmed
  // against the SDK's real .d.ts and validated offline with buildCurve,
  // same discipline as every other preset here) - the migrated DAMM v2
  // pool compounds half its trading fees back into its own liquidity
  // instead of paying all of it out. HIGHER RISK than the other five:
  // this is the first preset to use anything other than
  // MigrationFeeOption.FixedBps100, so it also exercises the
  // previously-unused dammConfig-selection branch in dbcMigration.js (see
  // getMigrationFeeOptionForPreset below) - untested live, on top of
  // migrate/claim already being untested live for every other preset too
  // (section 5.5/5.8).
  {
    id: "compounding-damm-v2",
    group: "Fee-shape curves",
    label: "Compounding DAMM v2 (3%→0.5% over 2h curve, migrates at 10 SOL, migrated pool compounds 50% of fees back into its own liquidity) - untested live, higher risk than the other presets",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 7200,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migratedPoolFee: {
      collectFeeMode: MigratedCollectFeeMode.Compounding,
      dynamicFee: DammV2DynamicFeeMode.Enabled,
      poolFeeBps: 100, // 1% - within the SDK's [10, 1000] bps bounds for a migrated pool fee
      compoundingFeeBps: 5000, // 50% of trading fees compound back into the pool's own liquidity, the rest still pays out
    },
  },
  // Added 2026-10-01 - competitive research found a direct competitor
  // (EquiCurve) accepts both SOL and USDC as quote, where this project
  // only offered SOL. Confirmed on-chain first (not assumed) that USDC
  // needs no Meteora token badge - it's a plain legacy SPL Token mint,
  // same no-op path as SOL (see resolveTokenBadge below). Reuses the
  // already-validated "low fee" 3%→0.5%/2h schedule rather than inventing
  // a new one. The 1,000 USDC threshold is a reasoned round-number default
  // (roughly in the same ballpark as 10 SOL at recent prices, ~$1,180) -
  // a genuine product-taste choice, not a precisely researched optimum;
  // worth revisiting once there's real usage data.
  {
    id: "usdc-quoted-low-fee",
    group: "USDC-quoted",
    quoteMint: USDC_MINT,
    quoteSymbol: "USDC",
    label: "Quoted in USDC (3%→0.5% over 2h, migrates at 1,000 USDC accumulated in the curve) - trades directly against USDC instead of SOL",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 1000,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 7200,
  },
  // Added 2026-09-22 - direct response to how several other Stocklana
  // submissions raised the bar on "tokenized stock" ideas: they quote the
  // DBC pool directly in a REAL tokenized stock (xStock), not just use one
  // to calibrate a SOL threshold (which is all the Pyth-anchored mode
  // above does). Verified this is actually possible before writing any of
  // this - Meteora controls token badge creation (no SDK method exposes
  // it to partners, confirmed by reading the installed SDK's real
  // exports), but a live on-chain read (dbcClient.state.getTokenBadge)
  // confirmed Meteora has ALREADY badged all four of Backed Finance's real
  // xStock mints below for DBC use - independently re-verified for AAPLx
  // by deriving the badge PDA and fetching it directly (owned by the DBC
  // program, real data, not a null/false-positive read).
  //
  // Migration threshold is 0.1 units of the xStock itself (not SOL) -
  // meaning "the curve is done" is now a literal, real amount of stock
  // exposure (e.g. 0.1 TSLAx), not a converted number. No Pyth call
  // needed for this mode at all: since 1 unit of quote already equals 1
  // real share by the mint's own design, there's no USD/SOL conversion to
  // do - Pyth stays reserved for the separate "Pyth-anchored" mode above.
  ...Object.values(STOCK_QUOTE_MINTS).map((stock) => ({
    id: `stock-quoted-${stock.symbol.toLowerCase()}`,
    group: `Real stock — ${stock.issuer}`,
    label: `Quoted in real ${stock.label} (3%→0.5% over 2h, migrates at 0.1 ${stock.symbol} accumulated in the curve) - trades directly against the tokenized stock, not SOL`,
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 0.1,
    startingFeeBps: 300,
    endingFeeBps: 50,
    schedulerDurationSeconds: 7200,
    quoteMint: stock.mint,
    quoteSymbol: stock.symbol,
  })),
];

export function findDbcCurvePreset(id) {
  return DBC_CURVE_PRESETS.find((p) => p.id === id);
}

/**
 * Which MigrationFeeOption a given launch's config actually used when it
 * was created - needed at migrate time to pick the matching DAMM v2
 * config key (DAMM_V2_MIGRATION_FEE_ADDRESS), since that address is
 * DIFFERENT per option and has to match exactly what createConfig used.
 * `presetId` null (Pyth-anchored launches) falls back to the same
 * FixedBps100 default every preset used before this file supported
 * per-preset overrides (see "compounding-damm-v2").
 */
export function getMigrationFeeOptionForPreset(presetId) {
  return findDbcCurvePreset(presetId)?.migrationFeeOption ?? MigrationFeeOption.FixedBps100;
}

/**
 * Everything a DBC config needs that ISN'T about the curve's shape itself
 * (token/fee/migration/liquidity/vesting/activation) - identical for both
 * the fixed SOL presets (buildCurve) and the Pyth-anchored ones
 * (buildCurveWithMarketCap), factored out so the two curve modes below
 * can't drift apart on anything except the numbers that actually define
 * the curve.
 */
function sharedCurveConfig(
  quoteInfo,
  {
    startingFeeBps,
    endingFeeBps,
    schedulerDurationSeconds,
    baseFeeMode = BaseFeeMode.FeeSchedulerLinear,
    totalTokenSupply = 1_000_000_000,
    migrationFeeOption = MigrationFeeOption.FixedBps100,
    migratedPoolFee,
    enableFirstSwapWithMinFee = false,
  }
) {
  return {
    token: {
      tokenType: TokenType.SPLToken, // new token, minted by DBC itself - no need for the Token-2022 that StonkFun/pump.fun sometimes require
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteInfo.decimals, // needs to match the quote's REAL decimals (SPYx = 8, SOL = 9, USDC/USDT = 6)
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // no mint/update authority left with us after launch - same spirit as "direct" (mintNewToken already revokes authority, see tokenMinter.js)
      totalTokenSupply,
      leftover: 0, // nothing withheld on purpose - all supply that doesn't migrate stays with whoever bought on the curve
    },
    fee: {
      baseFeeParams: {
        baseFeeMode,
        feeSchedulerParam: { startingFeeBps, endingFeeBps, numberOfPeriod: schedulerDurationSeconds, totalDuration: schedulerDurationSeconds },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken, // fee always in the quote (SOL/SPYx/...), never in the new token - more predictable to withdraw later (see dbcMigration.js)
      creatorTradingFeePercentage: 100, // 100% of the creator fee stays with us (no third-party partner in this project)
      poolCreationFee: 0,
      // Real on-chain anti-sniper field (not the quote-simulation-only
      // eligibleForFirstSwapWithMinFee used in simulatePresetBuys below) -
      // confirmed in the SDK's embedded IDL. Overridable per-preset, but
      // no preset sets it true yet: the on-chain validation only credits
      // the minimum fee to a swap bundled ATOMICALLY with pool creation
      // (a createPoolWithFirstBuy-style call), which this project doesn't
      // build yet - our "initial buy" is a separate, later transaction.
      // Turning this on without that atomic path would make the minimum
      // fee permanently unreachable at best, and risks every ineligible
      // swap hitting the program's FirstSwapValidationFailed error at
      // worst (undocumented condition - needs a real devnet swap test
      // before any preset relies on it).
      enableFirstSwapWithMinFee,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // V1 is deprecated for new configs
      migrationFeeOption, // FixedBps100 (1%) by default - middle ground, revisit; Customizable for presets that also set migratedPoolFee (see "compounding-damm-v2")
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // no EXTRA migration fee beyond the one above
      ...(migratedPoolFee ? { migratedPoolFee } : {}),
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
  };
}

/**
 * Builds the ConfigParameters (curve + fees + migration) from a preset +
 * the chosen quote - uses buildCurve, which does all the sqrtPrice/
 * liquidity math for us (equivalent to the preparePoolCreationParams that
 * poolCreator.js already uses for DAMM v2, just on the DBC side).
 */
export async function buildConfigParameters(preset, quoteMint) {
  const quoteInfo = await getMintInfo(connection, quoteMint);

  return buildCurve({
    ...sharedCurveConfig(quoteInfo, preset),
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
    migrationQuoteThreshold: preset.migrationQuoteThreshold,
  });
}

// Same fee schedule as the validated "low-fee" preset (see
// DBC_CURVE_PRESETS above) - reused as-is for Pyth-anchored launches
// rather than inventing a new number, since it's the one already proven
// live against GMGN's "high tax" heuristic.
const PYTH_ANCHORED_FEE_SCHEDULE = { startingFeeBps: 300, endingFeeBps: 50, schedulerDurationSeconds: 7200 };

/**
 * Builds ConfigParameters anchored to a real stock's live Pyth price
 * instead of a fixed SOL number - uses buildCurveWithMarketCap (a
 * DIFFERENT SDK curve-builder than the one above: it takes
 * initialMarketCap/migrationMarketCap directly, no
 * percentageSupplyOnMigration/migrationQuoteThreshold). See
 * pythPricing.js for where the market caps come from and the real
 * limitations found (trial API key, only TSLA/QQQ entitled).
 */
export async function buildPythAnchoredConfigParameters(symbol, quoteMint) {
  const quoteInfo = await getMintInfo(connection, quoteMint);
  const { initialMarketCap, migrationMarketCap } = await computePythAnchoredMarketCaps(symbol);

  return buildCurveWithMarketCap({
    ...sharedCurveConfig(quoteInfo, PYTH_ANCHORED_FEE_SCHEDULE),
    initialMarketCap,
    migrationMarketCap,
  });
}

// ---- Pre-launch simulation (2026-09-30) - "what would buying into this
// curve actually look like" BEFORE spending a single lamport, using the
// SDK's own getQuoteFromInputAmount (bit-exact against the on-chain
// program's swap math, not an approximation - confirmed live by probing
// its real output against several currentPoint values before trusting
// it). Several real competitors in this same Meteora DBC bounty
// (CurveLab, Curvature, CurveCraft, Barkbork) independently converged on
// this exact kind of simulation; see project_competitive_landscape
// memory. currentPoint is fixed at 0 (right at activation, zero elapsed
// time) since there's no real "now" for a curve that doesn't exist yet -
// this answers "what does the very first buyer see," the most honest
// reference point for a pre-launch preview. ----
function simulateCurveBuys(config, quoteDecimals) {
  const threshold = config.migrationQuoteThreshold;
  return [1, 10, 50].map((pct) => {
    const amountIn = threshold.muln(pct).divn(100);
    if (amountIn.isZero()) return { percentOfThreshold: pct, amountInUi: 0, outputTokensUi: 0, feeBps: 0 };
    const quote = dbcClient.pool.getQuoteFromInputAmount({
      config,
      swapBaseForQuote: false,
      amountIn,
      swapMode: SwapMode.ExactIn,
      currentPoint: new BN(0),
      // false = a normal buyer's experience, not an exempted anti-snipe
      // first-swap (confirmed live: passing true here forces the MINIMUM
      // fee regardless of currentPoint, which would misrepresent the
      // actual fee schedule every real buyer sees).
      eligibleForFirstSwapWithMinFee: false,
    });
    return {
      percentOfThreshold: pct,
      amountInUi: Number(amountIn.toString()) / 10 ** quoteDecimals,
      outputTokensUi: Number(quote.outputAmount.toString()) / 10 ** 6, // tokenBaseDecimal is always SIX, see sharedCurveConfig
      feeBps: (Number(quote.tradingFee.toString()) / Number(amountIn.toString())) * 10000,
    };
  });
}

/** Simulates buys for a regular (fee-shape or stock-quoted) preset. */
export async function simulatePresetBuys(presetId) {
  const preset = findDbcCurvePreset(presetId);
  if (!preset) throw new Error(`Unknown preset: "${presetId}".`);
  const quoteMint = preset.quoteMint ?? SOL_MINT;
  const [quoteInfo, config] = await Promise.all([getMintInfo(connection, quoteMint), buildConfigParameters(preset, quoteMint)]);
  return { quoteSymbol: preset.quoteSymbol ?? "SOL", points: simulateCurveBuys(config, quoteInfo.decimals) };
}

/**
 * Simulates buys for a Pyth-anchored preset, ALSO converting each
 * simulated SOL amount into its live real-world USD value - the specific
 * combination (pre-launch simulation + a real, currently-live asset
 * price) none of the simulation-focused competitors above actually do,
 * since their simulators work on generic/hypothetical curves.
 */
export async function simulatePythPresetBuys(symbol) {
  if (!isPythStockSymbolSupported(symbol)) throw new Error(`Unsupported Pyth-anchored symbol: "${symbol}".`);
  const [quoteInfo, config, { stockUsd, solUsd }] = await Promise.all([
    getMintInfo(connection, SOL_MINT),
    buildPythAnchoredConfigParameters(symbol, SOL_MINT),
    computePythAnchoredMarketCaps(symbol),
  ]);
  const points = simulateCurveBuys(config, quoteInfo.decimals).map((p) => ({ ...p, amountInUsd: p.amountInUi * solUsd }));
  return { quoteSymbol: "SOL", stockUsd, solUsd, points };
}

/**
 * Some quote mints (Token-2022 with extensions the DBC program doesn't
 * natively trust, like the real xStock tokenized-stock mints - see
 * STOCK_QUOTE_MINTS below) require a "token badge" - an account Meteora
 * itself creates to vouch for that specific mint. Badging is NOT something
 * a partner/developer can do (confirmed 2026-09-22 by reading the SDK's
 * actual exported methods: no service class exposes a create-badge call,
 * only read-only getTokenBadge/deriveTokenBadgeAddress - the raw IDL
 * instruction exists but its `operator` account is a Meteora-controlled
 * role). This just checks whether Meteora has ALREADY badged the given
 * quote mint (a real, free, on-chain read) and passes the address along if
 * so - for SOL and other "supported" mints, getTokenBadge returns null and
 * this is a no-op, identical to the previous behavior.
 */
async function resolveTokenBadge(quoteMint) {
  const badge = await dbcClient.state.getTokenBadge(quoteMint).catch(() => null);
  return badge ? deriveTokenBadgeAddress(new PublicKey(quoteMint)) : undefined;
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

  const { rows: cachedRows } = await query("SELECT config_address FROM dbc_configs WHERE preset_id = $1 AND quote_mint = $2", [presetId, quoteMint]);
  if (cachedRows.length > 0) return new PublicKey(cachedRows[0].config_address);

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate(); // new account - the config address is random, not deterministic (unlike the "customizable" DAMM v2 pool in poolCreator.js)
  const configParams = await buildConfigParameters(preset, quoteMint);
  const tokenBadge = await resolveTokenBadge(quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey, // we withdraw the fee as both "partner" (config owner) AND "creator" (pool owner) - we're both parties here
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
    tokenBadge,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new config created for preset "${presetId}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  // ON CONFLICT: if a concurrent request for this exact preset+quote won
  // the race and inserted first, keep ITS row (RETURNING nothing means we
  // fall through to the SELECT below) rather than ours - we already paid
  // for and created an extra on-chain config account in that rare case,
  // but every future launch still converges on a single reused address.
  await query(
    `INSERT INTO dbc_configs (preset_id, quote_mint, config_address, signature)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (preset_id, quote_mint) WHERE preset_id NOT LIKE 'pyth:%' DO NOTHING`,
    [presetId, quoteMint, configKeypair.publicKey.toBase58(), signature]
  );
  const { rows: finalRows } = await query("SELECT config_address FROM dbc_configs WHERE preset_id = $1 AND quote_mint = $2", [presetId, quoteMint]);

  return new PublicKey(finalRows[0].config_address);
}

/**
 * Creates a FRESH DBC config anchored to a stock's live Pyth price - on
 * purpose NEVER cached/reused like getOrCreateDbcConfig above: the whole
 * point is that the market caps reflect the price at the moment of
 * launch, so every Pyth-anchored launch gets its own config with a
 * current read, not a stale one from whenever the symbol was first used.
 * The extra config-account rent this costs is negligible.
 */
export async function createPythAnchoredDbcConfig(symbol, quoteMint) {
  if (!isPythStockSymbolSupported(symbol)) {
    throw new Error(`Unsupported Pyth-anchored symbol: "${symbol}". Supported: ${Object.keys(PYTH_STOCK_SYMBOLS).join(", ")}.`);
  }

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate();
  const configParams = await buildPythAnchoredConfigParameters(symbol, quoteMint);
  const tokenBadge = await resolveTokenBadge(quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey,
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
    tokenBadge,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] new Pyth-anchored config created for "${symbol}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  await query("INSERT INTO dbc_configs (preset_id, quote_mint, config_address, signature) VALUES ($1, $2, $3, $4)", [
    `pyth:${symbol}`,
    quoteMint,
    configKeypair.publicKey.toBase58(),
    signature,
  ]);

  return configKeypair.publicKey;
}
