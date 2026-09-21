import fs from "fs";
import "dotenv/config";
import { ensureSchema, query, closePool } from "../src/db.js";

// One-time migration from the old data/launched-tokens.json and
// data/dbc-configs.json files into Postgres (see src/db.js). Run manually
// once per environment (local, then again against the Railway Postgres
// once its DATABASE_URL is set) - not part of the app's normal startup.
// Safe to re-run: launched_tokens is keyed by its own id (ON CONFLICT DO
// NOTHING), dbc_configs is deduped by config_address (a real on-chain
// address, so a natural dedup key regardless of the row's other columns).
//
//   node scripts/migrate-json-to-db.js

const LAUNCHED_TOKENS_FILE = new URL("../data/launched-tokens.json", import.meta.url);
const DBC_CONFIGS_FILE = new URL("../data/dbc-configs.json", import.meta.url);

function readJsonArray(fileUrl) {
  if (!fs.existsSync(fileUrl)) return [];
  try {
    return JSON.parse(fs.readFileSync(fileUrl, "utf-8"));
  } catch (err) {
    console.warn(`Couldn't read/parse ${fileUrl}:`, err.message);
    return [];
  }
}

async function migrateConfigs() {
  const configs = readJsonArray(DBC_CONFIGS_FILE);
  let inserted = 0;
  for (const c of configs) {
    const { rows: existing } = await query("SELECT 1 FROM dbc_configs WHERE config_address = $1", [c.configAddress]);
    if (existing.length > 0) continue;
    await query("INSERT INTO dbc_configs (preset_id, quote_mint, config_address, signature, created_at) VALUES ($1, $2, $3, $4, $5)", [
      c.presetId,
      c.quoteMint,
      c.configAddress,
      c.signature,
      c.createdAt ?? new Date().toISOString(),
    ]);
    inserted++;
  }
  console.log(`dbc_configs: ${inserted} inserted, ${configs.length - inserted} already present, ${configs.length} total in JSON.`);
}

async function migrateLaunchedTokens() {
  const tokens = readJsonArray(LAUNCHED_TOKENS_FILE);
  let inserted = 0;
  for (const t of tokens) {
    const result = await query(
      `INSERT INTO launched_tokens
         (id, name, symbol, quote_mint, quote_symbol, preset_id, pyth_symbol, first_buy_sol_ui, creator_public_key,
          dbc_migrated, created_at, status, mint, pool_address, dbc_pool_address, image_url, error, blockhash, last_valid_block_height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (id) DO NOTHING`,
      [
        t.id,
        t.name,
        t.symbol,
        t.quoteMint,
        t.quoteSymbol,
        t.presetId ?? null,
        t.pythSymbol ?? null,
        t.firstBuySolUi ?? 0,
        t.creatorPublicKey ?? null,
        t.dbcMigrated ?? false,
        t.createdAt ?? new Date().toISOString(),
        t.status,
        t.mint ?? null,
        t.poolAddress ?? null,
        t.dbcPoolAddress ?? null,
        t.imageUrl ?? null,
        t.error ?? null,
        t.blockhash ?? null,
        t.lastValidBlockHeight ?? null,
      ]
    );
    if (result.rowCount > 0) inserted++;
  }
  console.log(`launched_tokens: ${inserted} inserted, ${tokens.length - inserted} already present, ${tokens.length} total in JSON.`);
}

await ensureSchema();
await migrateConfigs();
await migrateLaunchedTokens();
await closePool();
console.log("Done.");
