import fs from "fs";
import { fileURLToPath } from "url";
import { SOL_MINT } from "./config.js";
import { uploadTokenAssets } from "./arweaveUpload.js";
import { launchOnDbc } from "./dbcLaunchpad.js";
import { findDbcCurvePreset } from "./dbcConfig.js";

// Orquestração do lançamento - versão enxuta do tokenLauncher.js do Lançar
// Token Bot (github.com/alemaxxx/lauch-token), cortando tudo que não é
// Meteora DBC: sem candidato de onda (nome/símbolo/imagem vêm do
// formulário, digitados por quem lança), sem StonkFun/pump.fun/mint
// direto, sem sugestão por IA. O que sobra é só a etapa 1 (upload pra
// Arweave) + a etapa DBC do arquivo original.

const LAUNCHED_TOKENS_FILE = new URL("../data/launched-tokens.json", import.meta.url);
const IMAGES_DIR = new URL("../data/images/", import.meta.url);

function ensureDataDirs() {
  const dataDir = new URL("../data/", import.meta.url);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function loadLaunchedTokens() {
  ensureDataDirs();
  if (!fs.existsSync(LAUNCHED_TOKENS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LAUNCHED_TOKENS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveLaunchedTokens(list) {
  ensureDataDirs();
  fs.writeFileSync(LAUNCHED_TOKENS_FILE, JSON.stringify(list, null, 2));
}

const CUSTOM_IMAGE_MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB - mesmo teto do Lançar Token Bot original

/**
 * Salva a imagem escolhida no formulário (upload ou Ctrl+V, chega como
 * data URL - "data:image/png;base64,...") num arquivo temporário, pra
 * poder subir pro Arweave.
 */
function saveImageToTempFile(dataUrl, fileId) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl ?? "");
  if (!match) {
    throw new Error("Imagem inválida - formatos aceitos: PNG, JPEG, WEBP, GIF.");
  }
  const [, contentType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Imagem grande demais (${(buffer.length / 1024 / 1024).toFixed(1)}MB) - máximo de 5MB.`);
  }
  ensureDataDirs();
  const ext = CUSTOM_IMAGE_MIME_TO_EXT[contentType];
  const filePath = fileURLToPath(new URL(`${fileId}.${ext}`, IMAGES_DIR));
  fs.writeFileSync(filePath, buffer);
  return { filePath, contentType };
}

function extractErrorMessage(err) {
  if (!err) return "Erro desconhecido (nenhum detalhe disponível).";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.error?.message) return err.error.message;
  if (Array.isArray(err.logs) && err.logs.length) return err.logs.join("\n");
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Lança um token novo direto na curva do Meteora DBC. Tudo digitado no
 * formulário - não depende de nenhum candidato/onda detectada (esse
 * projeto não tem o detector de hype do Lançar Token Bot original).
 */
export async function launchToken({ name, symbol, imageDataUrl, presetId, firstBuySolUi }) {
  if (!name || !symbol) {
    throw new Error("Informe nome e símbolo do token.");
  }
  if (!imageDataUrl) {
    throw new Error("Escolha uma imagem pro token.");
  }
  const preset = findDbcCurvePreset(presetId);
  if (!preset) {
    throw new Error(`Preset de curva desconhecido: "${presetId}".`);
  }

  const record = {
    id: `launch-${Date.now()}`,
    name,
    symbol,
    quoteMint: SOL_MINT,
    quoteSymbol: "SOL",
    presetId,
    firstBuySolUi: Number(firstBuySolUi) || 0,
    dbcMigrated: false,
    createdAt: new Date().toISOString(),
    status: "pending",
    mint: null,
    poolAddress: null,
    imageUrl: null,
    error: null,
  };

  try {
    // 1) Sobe a imagem + JSON de metadata pra Arweave - o "uri" que vai
    // on-chain no createPool (ver dbcLaunchpad.js).
    const { filePath, contentType } = saveImageToTempFile(imageDataUrl, record.id);
    const { imageUrl, metadataUrl } = await uploadTokenAssets({
      imagePath: filePath,
      contentType,
      name,
      symbol,
      description: `${name} - lançado via Meteora DBC.`,
    });
    record.imageUrl = imageUrl;

    // 2) Minta o token + inicializa a curva DBC numa transação só
    // (createPoolWithFirstBuy) - compra inicial opcional.
    const launched = await launchOnDbc({
      name,
      symbol,
      metadataUri: metadataUrl,
      presetId,
      quoteMint: SOL_MINT,
      firstBuySolUi,
    });
    record.mint = launched.mint;
    record.poolAddress = launched.poolAddress; // pool DBC (pré-migração)
    record.status = "success";
  } catch (err) {
    const message = extractErrorMessage(err);
    console.error(`[tokenLauncher] falha ao lançar ${symbol}:`, err);
    record.status = "error";
    record.error = message;
    // Mesma cautela do bot original: se o mint já foi criado on-chain
    // antes de uma etapa seguinte falhar, guarda o endereço mesmo assim -
    // nunca perde esse dado só porque algo depois deu errado.
    if (err?.mint && !record.mint) record.mint = err.mint;
  }

  const list = loadLaunchedTokens();
  list.unshift(record);
  saveLaunchedTokens(list);

  if (record.status === "error") throw new Error(record.error);
  return record;
}

export function getLaunchedTokens() {
  return loadLaunchedTokens();
}

/**
 * Atualiza o registro depois que dbcMigration.js migra a curva pra DAMM v2
 * de verdade - ver rota /dbc-migrate em server.js.
 */
export function markDbcPoolMigrated(id, newPoolAddress) {
  const list = loadLaunchedTokens();
  const record = list.find((t) => t.id === id);
  if (!record) return null;
  record.dbcMigrated = true;
  if (newPoolAddress) record.poolAddress = newPoolAddress;
  saveLaunchedTokens(list);
  return record;
}
