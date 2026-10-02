import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config, SOL_MINT } from "./config.js";
import { getWalletTokenBalance } from "./walletBalance.js";
import { DBC_CURVE_PRESETS, simulatePresetBuys, simulatePythPresetBuys } from "./dbcConfig.js";
import { getDbcCurveProgress, migrateDbcPoolIfReady, claimPartnerFees, prepareClaimCreatorFeeTransaction, submitClaimCreatorFeeTransaction } from "./dbcMigration.js";
import { prepareTokenLaunch, confirmTokenLaunch, getLaunchedTokens, getLaunchedTokenById, markDbcPoolMigrated } from "./tokenLauncher.js";
import { PYTH_STOCK_SYMBOLS, computePythAnchoredMarketCaps } from "./pythPricing.js";
import { getPublicPoolInfo } from "./dbcPoolInfo.js";
import { getDammPoolInfo } from "./dammPoolInfo.js";
import { getConvictionPoolStatus, preparePoolCreationTransaction, preparePositionTransaction, submitConvictionTransaction } from "./dlmmConviction.js";
import { rateLimit } from "./rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function startServer() {
  const app = express();
  // Needed for req.ip (used by rateLimit below) to reflect the real
  // client address instead of Railway's own reverse proxy - without this,
  // every visitor behind the same proxy would share one rate-limit bucket.
  app.set("trust proxy", true);
  app.use(express.static(PUBLIC_DIR));
  // Higher than the default limit (100kb) - the image arrives as base64 in
  // the launch request body, up to ~5MB of original file (see
  // tokenLauncher.js).
  app.use(express.json({ limit: "8mb" }));

  // Only on routes that cost the PLATFORM wallet real SOL even when
  // called by an anonymous visitor with no wallet at all - see
  // rateLimit.js for why. Generous enough for real usage (a real launch
  // is a rare, deliberate click), tight enough to bound abuse.
  const costlyRouteLimit = rateLimit({ windowMs: 60_000, max: 5 });

  // ---- Wallet balance (top of the screen) ----
  app.get("/api/wallet/balance", async (req, res) => {
    try {
      const sol = await getWalletTokenBalance(SOL_MINT);
      res.json({ address: config.walletAddressStr, solBalance: sol.balance });
    } catch (err) {
      console.error("Failed to fetch wallet balance:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DBC curve presets ----
  app.get("/api/dbc-presets", (req, res) => {
    res.json({ presets: DBC_CURVE_PRESETS });
  });

  // ---- Pyth-anchored presets - see pythPricing.js for the real
  // constraints (trial API key, only a couple of symbols entitled). This
  // list is static (no Pyth call), so it always renders even if Pyth
  // itself is down or the trial has expired - only the preview/launch
  // below actually touch the Pyth API and can fail gracefully. ----
  app.get("/api/pyth-presets", (req, res) => {
    const symbols = Object.entries(PYTH_STOCK_SYMBOLS).map(([symbol, { label }]) => ({ symbol, label }));
    res.json({ symbols });
  });

  app.get("/api/pyth-presets/:symbol/preview", async (req, res) => {
    try {
      const preview = await computePythAnchoredMarketCaps(req.params.symbol);
      res.json(preview);
    } catch (err) {
      console.error("Failed to fetch Pyth preview:", err);
      res.status(502).json({ error: err.message });
    }
  });

  // ---- Pre-launch simulation (2026-09-30) - what buying into a curve
  // actually looks like before it exists, using the SDK's own quote math.
  // Read-only, no wallet/signature needed - see dbcConfig.js's
  // simulatePresetBuys/simulatePythPresetBuys for the real mechanics. ----
  app.get("/api/dbc-presets/:id/simulate", async (req, res) => {
    try {
      const simulation = await simulatePresetBuys(req.params.id);
      res.json(simulation);
    } catch (err) {
      console.error("Failed to simulate preset:", err);
      res.status(err.message?.startsWith("Unknown preset") ? 404 : 500).json({ error: err.message });
    }
  });

  app.get("/api/pyth-presets/:symbol/simulate", async (req, res) => {
    try {
      const simulation = await simulatePythPresetBuys(req.params.symbol);
      res.json(simulation);
    } catch (err) {
      console.error("Failed to simulate Pyth-anchored preset:", err);
      res.status(502).json({ error: err.message });
    }
  });

  // ---- Launch (wallet-connected, two phases - see DBC-MIGRATION-PLAN.md
  // section 5.7 for why: the connecting browser wallet pays for and owns
  // the new token, the platform wallet never signs or spends here) ----

  // Phase 1: builds the transaction (not yet fully signed) and returns it
  // for the browser wallet to sign. No SOL moves yet.
  app.post("/api/launch/prepare", costlyRouteLimit, async (req, res) => {
    const { name, symbol, imageDataUrl, presetId, pythSymbol, firstBuySolUi, creatorPublicKey } = req.body ?? {};
    if (!name || !symbol || !imageDataUrl || !(presetId || pythSymbol) || !creatorPublicKey) {
      return res.status(400).json({ error: "Provide name, symbol, imageDataUrl, either presetId or pythSymbol, and creatorPublicKey (connect a wallet)." });
    }
    try {
      const result = await prepareTokenLaunch({
        name,
        symbol,
        imageDataUrl,
        presetId,
        pythSymbol,
        firstBuySolUi: firstBuySolUi !== undefined ? Number(firstBuySolUi) : undefined,
        creatorPublicKey,
      });
      res.json(result);
    } catch (err) {
      console.error("Failed to prepare launch:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Phase 2: takes the transaction back once the browser wallet signed
  // it, sends it, and confirms it - this is the step that actually
  // spends the connecting wallet's SOL.
  app.post("/api/launch/submit", async (req, res) => {
    const { id, signedTransactionBase64 } = req.body ?? {};
    if (!id || !signedTransactionBase64) {
      return res.status(400).json({ error: "Provide id and signedTransactionBase64." });
    }
    try {
      const result = await confirmTokenLaunch({ id, signedTransactionBase64 });
      res.json(result);
    } catch (err) {
      console.error("Failed to submit launch:", err);
      // err.signature (see tokenLauncher.js/dbcLaunchpad.js) is set when
      // the transaction was actually broadcast before the failure - surfaced
      // here so the UI can show it instead of a dead-end error message.
      res.status(500).json({ error: err.message, signature: err.signature ?? null });
    }
  });

  app.get("/api/launched-tokens", async (req, res) => {
    try {
      res.json({ tokens: await getLaunchedTokens() });
    } catch (err) {
      console.error("Failed to list launched tokens:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Curve progress, migration and fee withdrawal - all MANUAL, only
  // on explicit click, never automatic (same spirit as the original bot) ----

  app.get("/api/launched-tokens/:id/progress", async (req, res) => {
    const record = await getLaunchedTokenById(req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    if (!record.poolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const progress = await getDbcCurveProgress(record.poolAddress);
      res.json({ progress });
    } catch (err) {
      console.error("Failed to read curve progress:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/migrate", costlyRouteLimit, async (req, res) => {
    const record = await getLaunchedTokenById(req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    if (!record.poolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const result = await migrateDbcPoolIfReady(record.poolAddress, record.presetId);
      if (result.migrated) await markDbcPoolMigrated(record.id, result.newPoolAddress);
      res.json(result);
    } catch (err) {
      console.error("Failed to migrate pool to DAMM v2:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Claiming fees is split in two, like launching: the PARTNER fee always
  // belongs to the platform wallet (server-signed, one call), but the
  // CREATOR fee belongs to whoever actually launched the token - the DBC
  // program requires that wallet's own signature (see the bug note on
  // prepareClaimCreatorFeeTransaction, dbcMigration.js), so it goes
  // through the same wallet-connected prepare/submit pattern as launch.
  function resolveDbcPoolAddress(record) {
    // Always the ORIGINAL DBC curve account, even after migration - see
    // the bug note on markDbcPoolMigrated (tokenLauncher.js). Falls back
    // to poolAddress for records launched before dbcPoolAddress existed
    // (those predate any real migration, so poolAddress is still the DBC
    // pool for them regardless).
    return record.dbcPoolAddress ?? record.poolAddress;
  }

  app.post("/api/launched-tokens/:id/claim-partner-fee", costlyRouteLimit, async (req, res) => {
    const record = await getLaunchedTokenById(req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    const dbcPoolAddress = resolveDbcPoolAddress(record);
    if (!dbcPoolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const result = await claimPartnerFees(dbcPoolAddress);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Failed to claim partner fee:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/claim-creator-fee/prepare", async (req, res) => {
    const record = await getLaunchedTokenById(req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    const dbcPoolAddress = resolveDbcPoolAddress(record);
    if (!dbcPoolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    const { creatorPublicKey } = req.body ?? {};
    if (!creatorPublicKey) return res.status(400).json({ error: "Connect a wallet (the one that launched this token) first." });
    try {
      const result = await prepareClaimCreatorFeeTransaction({ poolAddress: dbcPoolAddress, creatorPublicKey });
      res.json(result);
    } catch (err) {
      console.error("Failed to prepare creator fee claim:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/claim-creator-fee/submit", async (req, res) => {
    const { signedTransactionBase64, blockhash, lastValidBlockHeight } = req.body ?? {};
    if (!signedTransactionBase64 || !blockhash || !lastValidBlockHeight) {
      return res.status(400).json({ error: "Provide signedTransactionBase64, blockhash and lastValidBlockHeight." });
    }
    try {
      const result = await submitClaimCreatorFeeTransaction({ signedTransactionBase64, blockhash, lastValidBlockHeight });
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Failed to submit creator fee claim:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Public developer API - "Data Streams or Developer Tooling for
  // trading terminals and builders" from the Crypto World's Fair brief.
  // Works for ANY DBC pool on-chain, not just ones this app launched -
  // CORS is opened just for this one route so external trading
  // terminals/dashboards can call it directly from a browser, unlike
  // every other route here (which are same-origin, for this app's own
  // UI only). Read-only, no wallet needed. ----
  app.get("/api/dbc-pool/:address", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    try {
      const info = await getPublicPoolInfo(req.params.address);
      if (!info) return res.status(404).json({ error: "No DBC pool found for that address (tried as both a pool address and a base mint)." });
      res.json(info);
    } catch (err) {
      console.error("Failed to read public pool info:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Added 2026-10-01 - the migrated-pool counterpart to /api/dbc-pool
  // above: read-only price/liquidity/quote-preview for any Meteora DAMM
  // v2 pool, not just ones launched here. No swap-transaction endpoint
  // yet - see dammPoolInfo.js's header comment for why.
  app.get("/api/damm-pool/:address", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    try {
      const info = await getDammPoolInfo(req.params.address);
      if (!info) return res.status(404).json({ error: "No DAMM v2 pool found for that address." });
      res.json(info);
    } catch (err) {
      console.error("Failed to read public DAMM v2 pool info:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // "DLMM Conviction Pools" (2026-10-01) - a second, concentrated-liquidity
  // position opened alongside an already-migrated DBC pool, manually
  // triggered from Explore. Never automatic. See dlmmConviction.js's
  // header comment for the full design and the real on-chain
  // "token launch owner proof" requirement this surfaces to the caller.
  app.get("/api/conviction/:dammPoolAddress/status", async (req, res) => {
    try {
      const status = await getConvictionPoolStatus(req.params.dammPoolAddress, req.query.wallet || null);
      if (!status) return res.status(404).json({ error: "No migrated DAMM v2 pool found for that address." });
      res.json(status);
    } catch (err) {
      console.error("Failed to read Conviction Pool status:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/conviction/prepare-pool", costlyRouteLimit, async (req, res) => {
    try {
      const prep = await preparePoolCreationTransaction(req.body);
      res.json(prep);
    } catch (err) {
      console.error("Failed to prepare Conviction Pool creation:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/conviction/prepare-position", costlyRouteLimit, async (req, res) => {
    try {
      const prep = await preparePositionTransaction(req.body);
      res.json(prep);
    } catch (err) {
      console.error("Failed to prepare Conviction Pool position:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/conviction/submit", costlyRouteLimit, async (req, res) => {
    try {
      const result = await submitConvictionTransaction(req.body);
      res.json(result);
    } catch (err) {
      console.error("Failed to submit Conviction Pool transaction:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.listen(config.dashboardPort, () => {
    console.log(`CurveForge available at http://localhost:${config.dashboardPort}`);
  });
}
