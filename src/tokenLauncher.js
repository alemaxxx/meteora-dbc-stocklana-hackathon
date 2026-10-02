import fs from "fs";
import { fileURLToPath } from "url";
import { SOL_MINT } from "./config.js";
import { uploadTokenAssets } from "./arweaveUpload.js";
import { prepareLaunchTransaction, submitLaunchTransaction } from "./dbcLaunchpad.js";
import { findDbcCurvePreset } from "./dbcConfig.js";
import { computePythAnchoredMarketCaps, isPythStockSymbolSupported } from "./pythPricing.js";
import { query } from "./db.js";

// Launch orchestration - a lean version of the Lançar Token Bot's
// tokenLauncher.js (github.com/alemaxxx/lauch-token), cutting everything
// that isn't Meteora DBC: no wave candidate (name/symbol/image come from
// the form, typed in by whoever is launching), no
// StonkFun/pump.fun/direct mint, no AI suggestion. What's left is just
// step 1 (Arweave upload) + the DBC step from the original file.
//
// Launch records moved to Postgres (2026-09-21, see db.js) - the old
// data/launched-tokens.json was read-whole/mutated/written-whole on every
// single launch, migration and fee claim, which is a real race condition
// under concurrent traffic and impossible to share across more than one
// app instance. Every write below is now a single-row INSERT/UPDATE.

const IMAGES_DIR = new URL("../data/images/", import.meta.url);

function ensureImagesDir() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// DB rows are snake_case; the rest of the app (server.js routes, the
// frontend) has always used camelCase - this is the one place that
// translates between them, so nothing else needs to know the storage
// changed. last_valid_block_height comes back as a STRING from
// node-postgres (BIGINT columns aren't auto-converted to JS numbers, to
// avoid silent precision loss) - Solana block heights are nowhere near
// Number.MAX_SAFE_INTEGER, so converting back here is safe, and callers
// downstream (connection.confirmTransaction) expect a plain number.
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    quoteMint: row.quote_mint,
    quoteSymbol: row.quote_symbol,
    presetId: row.preset_id,
    pythSymbol: row.pyth_symbol,
    firstBuySolUi: row.first_buy_sol_ui === null ? 0 : Number(row.first_buy_sol_ui),
    creatorPublicKey: row.creator_public_key,
    dbcMigrated: row.dbc_migrated,
    createdAt: row.created_at,
    status: row.status,
    mint: row.mint,
    poolAddress: row.pool_address,
    dbcPoolAddress: row.dbc_pool_address,
    imageUrl: row.image_url,
    error: row.error,
    signature: row.signature,
    blockhash: row.blockhash,
    lastValidBlockHeight: row.last_valid_block_height === null ? null : Number(row.last_valid_block_height),
  };
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
  ensureImagesDir();
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
  // storage and served back to every visitor.
  if (name.length > 64 || symbol.length > 16) {
    throw new Error("Name must be 64 characters or fewer, symbol 16 or fewer.");
  }
  if (!imageDataUrl) {
    throw new Error("Choose an image for the token.");
  }
  if (!creatorPublicKey) {
    throw new Error("Connect a wallet before launching - it pays for and owns the new token.");
  }

  // Three mutually exclusive curve modes: a fixed preset quoted in SOL, a
  // fixed preset quoted in a real xStock (see dbcConfig.js's
  // "stock-quoted-*" presets, added 2026-09-22), or a Pyth-anchored one
  // (pythPricing.js) - pythSymbol takes priority when both would somehow
  // be set.
  let migrationThresholdForValidation;
  let quoteMint = SOL_MINT;
  let quoteSymbol = "SOL";
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
    if (preset.quoteMint) {
      quoteMint = preset.quoteMint;
      quoteSymbol = preset.quoteSymbol ?? quoteSymbol;
    }
  }

  // Found live on 2026-09-17 (see DBC-MIGRATION-PLAN.md section 5.5): the
  // curve has no liquidity to sell past its own migration threshold, so a
  // first buy at or above it fails on-chain with AnchorError
  // InsufficientLiquidity (0x1791) - caught here with a clear message
  // instead of letting the raw simulation error reach the user.
  if (Number(firstBuySolUi) > 0 && Number(firstBuySolUi) >= migrationThresholdForValidation) {
    throw new Error(
      `Initial buy (${firstBuySolUi} ${quoteSymbol}) can't reach or exceed this curve's migration threshold (${migrationThresholdForValidation} ${quoteSymbol}) - the curve has no liquidity to sell beyond that point. Use a smaller amount.`
    );
  }

  const id = `launch-${Date.now()}`;

  // 1) Upload the image + metadata JSON to Arweave - the "uri" that goes
  // on-chain in createPool (see dbcLaunchpad.js). Still funded by the
  // platform wallet, not the connecting one - a deliberate, small,
  // shared infra cost (see arweaveUpload.js), not part of the
  // wallet-connect rework.
  const { filePath, contentType } = saveImageToTempFile(imageDataUrl, id);
  const { imageUrl, metadataUrl } = await uploadTokenAssets({
    imagePath: filePath,
    contentType,
    name,
    symbol,
    description: pythSymbol
      ? `${name} - launched via Meteora DBC, curve anchored to ${pythSymbol}'s live Pyth price.`
      : `${name} - launched via Meteora DBC.`,
  });

  const { transactionBase64, mint, blockhash, lastValidBlockHeight } = await prepareLaunchTransaction({
    name,
    symbol,
    metadataUri: metadataUrl,
    presetId,
    pythSymbol,
    quoteMint,
    firstBuySolUi,
    creatorPublicKey,
  });

  await query(
    `INSERT INTO launched_tokens
       (id, name, symbol, quote_mint, quote_symbol, preset_id, pyth_symbol, first_buy_sol_ui, creator_public_key, status, mint, image_url, blockhash, last_valid_block_height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13)`,
    [
      id,
      name,
      symbol,
      quoteMint,
      quoteSymbol,
      pythSymbol ? null : presetId,
      pythSymbol ?? null,
      Number(firstBuySolUi) || 0,
      creatorPublicKey,
      mint,
      imageUrl,
      blockhash,
      lastValidBlockHeight,
    ]
  );

  return { id, transactionBase64, mint };
}

/**
 * Phase 2: takes the transaction back once the browser wallet has signed
 * it, submits it, and updates the "pending" record from
 * prepareTokenLaunch above into "success" or "error".
 */
export async function confirmTokenLaunch({ id, signedTransactionBase64 }) {
  const record = await getLaunchedTokenById(id);
  if (!record) throw new Error(`Pending launch "${id}" not found - did you already confirm it?`);

  try {
    const result = await submitLaunchTransaction({
      signedTransactionBase64,
      mint: record.mint,
      symbol: record.symbol,
      blockhash: record.blockhash,
      lastValidBlockHeight: record.lastValidBlockHeight,
    });
    // dbc_pool_address is set here and never touched again (see
    // markDbcPoolMigrated below) - claiming DBC creator/partner fees
    // always needs the ORIGINAL curve account, even after pool_address
    // itself starts pointing at the migrated DAMM v2 pool.
    await query("UPDATE launched_tokens SET status = 'success', pool_address = $1, dbc_pool_address = $1, signature = $2 WHERE id = $3", [result.poolAddress, result.signature, id]);
    record.poolAddress = result.poolAddress;
    record.dbcPoolAddress = result.poolAddress;
    record.signature = result.signature;
    record.status = "success";
  } catch (err) {
    const message = extractErrorMessage(err);
    console.error(`[tokenLauncher] failed to confirm launch of ${record.symbol}:`, err);
    // err.signature (see dbcLaunchpad.js) is set when the transaction was
    // actually broadcast before the failure - persisted even on the error
    // path so a real on-chain launch can be found and reconciled later
    // instead of leaving only an error message with no signature to check.
    await query("UPDATE launched_tokens SET status = 'error', error = $1, signature = $2 WHERE id = $3", [message, err.signature ?? null, id]);
    record.status = "error";
    record.error = message;
    record.signature = err.signature ?? null;
  }

  if (record.status === "error") {
    const err = new Error(record.error);
    err.signature = record.signature;
    throw err;
  }
  return record;
}

export async function getLaunchedTokens() {
  const { rows } = await query("SELECT * FROM launched_tokens ORDER BY created_at DESC");
  return rows.map(mapRow);
}

export async function getLaunchedTokenById(id) {
  const { rows } = await query("SELECT * FROM launched_tokens WHERE id = $1", [id]);
  return mapRow(rows[0]);
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
 * keeping the original address in `dbc_pool_address` (set once at launch,
 * see confirmTokenLaunch, never touched here) and having the claim-fees
 * route (server.js) read that instead of `pool_address`.
 */
export async function markDbcPoolMigrated(id, newPoolAddress) {
  const { rows } = await query(
    `UPDATE launched_tokens
     SET dbc_migrated = true, pool_address = COALESCE($2, pool_address)
     WHERE id = $1
     RETURNING *`,
    [id, newPoolAddress]
  );
  return mapRow(rows[0]);
}
