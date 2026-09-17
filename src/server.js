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
  // Limite maior que o padrão (100kb) - a imagem chega em base64 no corpo
  // do lançamento, até uns 5MB de arquivo original (ver tokenLauncher.js).
  app.use(express.json({ limit: "8mb" }));

  // ---- Saldo da wallet (topo da tela) ----
  app.get("/api/wallet/balance", async (req, res) => {
    try {
      const sol = await getWalletTokenBalance(SOL_MINT);
      res.json({ address: config.walletAddressStr, solBalance: sol.balance });
    } catch (err) {
      console.error("Erro ao consultar saldo da wallet:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Presets de curva do DBC ----
  app.get("/api/dbc-presets", (req, res) => {
    res.json({ presets: DBC_CURVE_PRESETS });
  });

  // ---- Lançamento ----
  // Dispara uma transação real na blockchain (mint + curva DBC) - só
  // chamada quando o usuário confirma no formulário depois de revisar
  // nome/símbolo/imagem/preset.
  app.post("/api/launch", async (req, res) => {
    const { name, symbol, imageDataUrl, presetId, firstBuySolUi } = req.body ?? {};
    if (!name || !symbol || !imageDataUrl || !presetId) {
      return res.status(400).json({ error: "Informe name, symbol, imageDataUrl e presetId." });
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
      console.error("Erro ao lançar token:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/launched-tokens", (req, res) => {
    try {
      res.json({ tokens: getLaunchedTokens() });
    } catch (err) {
      console.error("Erro ao listar tokens lançados:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Progresso da curva, migração e saque de taxa - tudo MANUAL, sob
  // clique explícito, nunca automático (mesmo espírito do bot original) ----

  app.get("/api/launched-tokens/:id/progress", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Token lançado não encontrado." });
    if (!record.poolAddress) return res.status(400).json({ error: "Esse registro não tem pool associada." });
    try {
      const progress = await getDbcCurveProgress(record.poolAddress);
      res.json({ progress });
    } catch (err) {
      console.error("Erro ao ler progresso da curva:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/migrate", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Token lançado não encontrado." });
    if (!record.poolAddress) return res.status(400).json({ error: "Esse registro não tem pool associada." });
    try {
      const result = await migrateDbcPoolIfReady(record.poolAddress);
      if (result.migrated) markDbcPoolMigrated(record.id, result.newPoolAddress);
      res.json(result);
    } catch (err) {
      console.error("Erro ao migrar pool pra DAMM v2:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/launched-tokens/:id/claim-fees", async (req, res) => {
    const record = getLaunchedTokens().find((t) => t.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Token lançado não encontrado." });
    if (!record.poolAddress) return res.status(400).json({ error: "Esse registro não tem pool associada." });
    try {
      const result = await claimDbcFees(record.poolAddress);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Erro ao sacar taxas:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.dashboardPort, () => {
    console.log(`Meteora DBC Launchpad disponível em http://localhost:${config.dashboardPort}`);
  });
}
