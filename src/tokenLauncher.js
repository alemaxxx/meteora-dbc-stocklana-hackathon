import fs from "fs";
import { fileURLToPath } from "url";
import { SOL_MINT } from "./config.js";
import { uploadTokenAssets } from "./arweaveUpload.js";
import { prepareLaunchTransaction, submitLaunchTransaction } from "./dbcLaunchpad.js";
import { findDbcCurvePreset } from "./dbcConfig.js";
import { computePythAnchoredMarketCaps, isPythStockSymbolSupported } from "./pythPricing.js";

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
 * Phase 1 of a wallet-connected launch: validates the form, uploads the
 * image/metadata to Arweave (still platform-funded - see arweaveUpload.js
 * comment), and builds the (not-yet-fully-signed) DBC transaction paid
 * for by `creatorPublicKey`. Saves a "pending" record right away so the
 * launch shows up in the table even before the browser wallet signs.
 * Returns the transaction for the browser wallet to sign, plus the
 * record id needed to complete it via confirmTokenLaunch below.
 */
export async function prepareTokenLaunch({ name, symbol, imageDataUrl, presetId, pythSymbol, firstBuySolUi, creatorPublicKey }) {
  if (!name || !symbol) {
    throw new Error("Provide the token's name and symbol.");
  }
  // Length caps - defense in depth, not just the HTML maxlength on the
  // form (an attacker can call the API directly, bypassing any client-side
  // limit). Found in the same pass as the stored-XSS fix in app.js
  // (2026-09-20 pre-launch security review): nothing server-side was
  // stopping an arbitrarily long name/symbol from being written into
  // data/launched-tokens.json and served back to every visitor.
  if (name.length > 64 || symbol.length > 16) {
    throw new Error("Name must be 64 characters or fewer, symbol 16 or fewer.");
  }
  if (!imageDataUrl) {
    throw new Error("Choose an image for the token.");
  }
  if (!creatorPublicKey) {
    throw new Error("Connect a wallet before launching - it pays for and owns the new token.");
  }

  // Two mutually exclusive curve modes: a fixed SOL preset (the two
  // production ones), or a Pyth-anchored one (see pythPricing.js) -
  // pythSymbol takes priority when both would somehow be set.
  let migrationThresholdForValidation;
  if (pythSymbol) {
    if (!isPythStockSymbolSupported(pythSymbol)) {
      throw new Error(`Unsupported Pyth-anchored symbol: "${pythSymbol}".`);
    }
    // Fetched again (fresh) inside prepareLaunchTransaction/
    // createPythAnchoredDbcConfig when the config actually gets created -
    // this read is only used to validate the requested first buy below, a
    // live price move between the two reads is expected and fine.
    ({ migrationMarketCap: migrationThresholdForValidation } = await computePythAnchoredMarketCaps(pythSymbol));
  } else {
    const preset = findDbcCurvePreset(presetId);
    if (!preset) {
      throw new Error(`Unknown curve preset: "${presetId}".`);
    }
    migrationThresholdForValidation = preset.migrationQuoteThreshold;
  }

  // Found live on 2026-09-17 (see PLANO-DBC-MIGRACAO.md section 5.5): the
  // curve has no liquidity to sell past its own migration threshold, so a
  // first buy at or above it fails on-chain with AnchorError
  // InsufficientLiquidity (0x1791) - caught here with a clear message
  // instead of letting the raw simulation error reach the user.
  if (Number(firstBuySolUi) > 0 && Number(firstBuySolUi) >= migrationThresholdForValidation) {
    throw new Error(
      `Initial buy (${firstBuySolUi} SOL) can't reach or exceed this curve's migration threshold (${migrationThresholdForValidation} SOL) - the curve has no liquidity to sell beyond that point. Use a smaller amount.`
    );
  }

  const record = {
    id: `launch-${Date.now()}`,
    name,
    symbol,
    quoteMint: SOL_MINT,
    quoteSymbol: "SOL",
    presetId: pythSymbol ? null : presetId,
    pythSymbol: pythSymbol ?? null,
    firstBuySolUi: Number(firstBuySolUi) || 0,
    creatorPublicKey,
    dbcMigrated: false,
    createdAt: new Date().toISOString(),
    status: "pending",
    mint: null,
    poolAddress: null,
    imageUrl: null,
    error: null,
  };

  // 1) Upload the image + metadata JSON to Arweave - the "uri" that goes
  // on-chain in createPool (see dbcLaunchpad.js). Still funded by the
  // platform wallet, not the connecting one - a deliberate, small,
  // shared infra cost (see arweaveUpload.js), not part of the
  // wallet-connect rework.
  const { filePath, contentType } = saveImageToTempFile(imageDataUrl, record.id);
  const { imageUrl, metadataUrl } = await uploadTokenAssets({
    imagePath: filePath,
    contentType,
    name,
    symbol,
    description: pythSymbol
      ? `${name} - launched via Meteora DBC, curve anchored to ${pythSymbol}'s live Pyth price.`
      : `${name} - launched via Meteora DBC.`,
  });
  record.imageUrl = imageUrl;

  const { transactionBase64, mint, blockhash, lastValidBlockHeight } = await prepareLaunchTransaction({
    name,
    symbol,
    metadataUri: metadataUrl,
    presetId,
    pythSymbol,
    quoteMint: SOL_MINT,
    firstBuySolUi,
    creatorPublicKey,
  });
  record.mint = mint;
  record.blockhash = blockhash;
  record.lastValidBlockHeight = lastValidBlockHeight;

  const list = loadLaunchedTokens();
  list.unshift(record);
  saveLaunchedTokens(list);

  return { id: record.id, transactionBase64, mint };
}

/**
 * Phase 2: takes the transaction back once the browser wallet has signed
 * it, submits it, and updates the "pending" record from
 * prepareTokenLaunch above into "success" or "error".
 */
export async function confirmTokenLaunch({ id, signedTransactionBase64 }) {
  const list = loadLaunchedTokens();
  const record = list.find((t) => t.id === id);
  if (!record) throw new Error(`Pending launch "${id}" not found - did you already confirm it?`);

  try {
    const result = await submitLaunchTransaction({
      signedTransactionBase64,
      mint: record.mint,
      symbol: record.symbol,
      blockhash: record.blockhash,
      lastValidBlockHeight: record.lastValidBlockHeight,
    });
    record.poolAddress = result.poolAddress;
    record.dbcPoolAddress = result.poolAddress; // never overwritten (see markDbcPoolMigrated) - claiming DBC creator/partner fees always needs the ORIGINAL curve account, even after poolAddress itself starts pointing at the migrated DAMM v2 pool
    record.status = "success";
  } catch (err) {
    const message = extractErrorMessage(err);
    console.error(`[tokenLauncher] failed to confirm launch of ${record.symbol}:`, err);
    record.status = "error";
    record.error = message;
  }

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
 *
 * BUG FOUND LIVE (2026-09-20, first real migration test): this used to
 * overwrite `poolAddress` with the new DAMM v2 pool and nothing else -
 * fine for the UI's "open on Meteora" link, but claimDbcFees (dbcMigration.js)
 * needs the ORIGINAL DBC curve account, and ended up being called against
 * the DAMM v2 pool instead, failing with "Invalid account discriminator"
 * (Anchor rejecting a DAMM v2 account read as a DBC virtual pool). Fixed by
 * keeping the original address in `dbcPoolAddress` (set once at launch,
 * see confirmTokenLaunch, never touched here) and having the claim-fees
 * route (server.js) read that instead of `poolAddress`.
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
