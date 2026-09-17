import fs from "fs";
import { fileURLToPath } from "url";
import { SOL_MINT } from "./config.js";
import { uploadTokenAssets } from "./arweaveUpload.js";
import { launchOnDbc } from "./dbcLaunchpad.js";
import { findDbcCurvePreset } from "./dbcConfig.js";

// Launch orchestration - a lean version of the Lançar Token Bot's
// tokenLauncher.js (github.com/alemaxxx/lauch-token), cutting everything
// that isn't Meteora DBC: no wave candidate (name/symbol/image come from
// the form, typed in by whoever is launching), no
// StonkFun/pump.fun/direct mint, no AI suggestion. What's left is just
// step 1 (Arweave upload) + the DBC step from the original file.

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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB - same cap as the original Lançar Token Bot

/**
 * Saves the image chosen on the form (upload or Ctrl+V, arrives as a data
 * URL - "data:image/png;base64,...") to a temp file, so it can be
 * uploaded to Arweave.
 */
function saveImageToTempFile(dataUrl, fileId) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl ?? "");
  if (!match) {
    throw new Error("Invalid image - accepted formats: PNG, JPEG, WEBP, GIF.");
  }
  const [, contentType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB) - 5MB max.`);
  }
  ensureDataDirs();
  const ext = CUSTOM_IMAGE_MIME_TO_EXT[contentType];
  const filePath = fileURLToPath(new URL(`${fileId}.${ext}`, IMAGES_DIR));
  fs.writeFileSync(filePath, buffer);
  return { filePath, contentType };
}

function extractErrorMessage(err) {
  if (!err) return "Unknown error (no details available).";
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
 * Launches a new token directly on the Meteora DBC curve. Everything
 * typed on the form - doesn't depend on any detected candidate/wave (this
 * project doesn't have the original Lançar Token Bot's hype detector).
 */
export async function launchToken({ name, symbol, imageDataUrl, presetId, firstBuySolUi }) {
  if (!name || !symbol) {
    throw new Error("Provide the token's name and symbol.");
  }
  if (!imageDataUrl) {
    throw new Error("Choose an image for the token.");
  }
  const preset = findDbcCurvePreset(presetId);
  if (!preset) {
    throw new Error(`Unknown curve preset: "${presetId}".`);
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
    // 1) Upload the image + metadata JSON to Arweave - the "uri" that
    // goes on-chain in createPool (see dbcLaunchpad.js).
    const { filePath, contentType } = saveImageToTempFile(imageDataUrl, record.id);
    const { imageUrl, metadataUrl } = await uploadTokenAssets({
      imagePath: filePath,
      contentType,
      name,
      symbol,
      description: `${name} - launched via Meteora DBC.`,
    });
    record.imageUrl = imageUrl;

    // 2) Mint the token + initialize the DBC curve in a single
    // transaction (createPoolWithFirstBuy) - optional initial buy.
    const launched = await launchOnDbc({
      name,
      symbol,
      metadataUri: metadataUrl,
      presetId,
      quoteMint: SOL_MINT,
      firstBuySolUi,
    });
    record.mint = launched.mint;
    record.poolAddress = launched.poolAddress; // DBC pool (pre-migration)
    record.status = "success";
  } catch (err) {
    const message = extractErrorMessage(err);
    console.error(`[tokenLauncher] failed to launch ${symbol}:`, err);
    record.status = "error";
    record.error = message;
    // Same caution as the original bot: if the mint was already created
    // on-chain before a later step failed, keep the address anyway -
    // never lose that data just because something afterward went wrong.
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
 * Updates the record after dbcMigration.js actually migrates the curve to
 * DAMM v2 - see the /dbc-migrate route in server.js.
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
