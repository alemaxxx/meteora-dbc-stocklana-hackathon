import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config, SOL_MINT } from "./config.js";
import { getWalletTokenBalance } from "./walletBalance.js";
import { DBC_CURVE_PRESETS } from "./dbcConfig.js";
import { getDbcCurveProgress, migrateDbcPoolIfReady, claimDbcFees } from "./dbcMigration.js";
import { launchToken, getLaunchedTokens, markDbcPoolMigrated } from "./tokenLauncher.js";

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

  // ---- Launch ----
  // Sends a real on-chain transaction (mint + DBC curve) - only called
  // when the user confirms on the form after reviewing
  // name/symbol/image/preset.
  app.post("/api/launch", async (req, res) => {
    const { name, symbol, imageDataUrl, presetId, firstBuySolUi } = req.body ?? {};
    if (!name || !symbol || !imageDataUrl || !presetId) {
      return res.status(400).json({ error: "Provide name, symbol, imageDataUrl and presetId." });
    }
    try {
      const result = await launchToken({
        name,
        symbol,
        imageDataUrl,
        presetId,
        firstBuySolUi: firstBuySolUi !== undefined ? Number(firstBuySolUi) : undefined,
      });
      res.json(result);
    } catch (err) {
      console.error("Failed to launch token:", err);
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
      const result = await migrateDbcPoolIfReady(record.poolAddress);
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
    if (!record.poolAddress) return res.status(400).json({ error: "This record has no associated pool." });
    try {
      const result = await claimDbcFees(record.poolAddress);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Failed to claim fees:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.dashboardPort, () => {
    console.log(`Meteora DBC Launchpad available at http://localhost:${config.dashboardPort}`);
  });
}
