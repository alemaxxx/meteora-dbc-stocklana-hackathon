import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config, SOL_MINT } from "./config.js";
import { getWalletTokenBalance } from "./walletBalance.js";
import { DBC_CURVE_PRESETS } from "./dbcConfig.js";
import { getDbcCurveProgress, migrateDbcPoolIfReady, claimDbcFees } from "./dbcMigration.js";
import { prepareTokenLaunch, confirmTokenLaunch, getLaunchedTokens, markDbcPoolMigrated } from "./tokenLauncher.js";
import { PYTH_STOCK_SYMBOLS, computePythAnchoredMarketCaps } from "./pythPricing.js";
import { getPublicPoolInfo } from "./dbcPoolInfo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function startServer() {
  const app = express();
  app.use(express.static(PUBLIC_DIR));
  // Higher than the default limit (100kb) - the image arrives as base64 in
  // the launch request body, up to ~5MB of original file (see
  // tokenLauncher.js).
  app.use(express.json({ limit: "8mb" }));

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

  // ---- Launch (wallet-connected, two phases - see PLANO-DBC-MIGRACAO.md
  // section 5.7 for why: the connecting browser wallet pays for and owns
  // the new token, the platform wallet never signs or spends here) ----

  // Phase 1: builds the transaction (not yet fully signed) and returns it
  // for the browser wallet to sign. No SOL moves yet.
  app.post("/api/launch/prepare", async (req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/launched-tokens", (req, res) => {
    try {
      res.json({ tokens: getLaunchedTokens() });
    } catch (err) {
      console.error("Failed to list launched tokens:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Curve progress, migration and fee withdrawal - all MANUAL, only
  // on explicit click, never automatic (same spirit as the original bot) ----

  app.get("/api/launched-tokens/:id/progress", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
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

  app.post("/api/launched-tokens/:id/migrate", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    if (!record.poolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const result = await migrateDbcPoolIfReady(record.poolAddress, record.presetId);
      if (result.migrated) markDbcPoolMigrated(record.id, result.newPoolAddress);
      res.json(result);
    } catch (err) {
      console.error("Failed to migrate pool to DAMM v2:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/claim-fees", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Launched token not found." });
    // Always the ORIGINAL DBC curve account, even after migration - see the
    // bug note on markDbcPoolMigrated (tokenLauncher.js). Falls back to
    // poolAddress for records launched before dbcPoolAddress existed
    // (those predate any real migration, so poolAddress is still the DBC
    // pool for them regardless).
    const dbcPoolAddress = record.dbcPoolAddress ?? record.poolAddress;
    if (!dbcPoolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const result = await claimDbcFees(dbcPoolAddress);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Failed to claim fees:", err);
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

  app.listen(config.dashboardPort, () => {
    console.log(`Meteora DBC Launchpad available at http://localhost:${config.dashboardPort}`);
  });
}
