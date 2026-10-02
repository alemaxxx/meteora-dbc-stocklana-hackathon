import pg from "pg";

// Replaces data/launched-tokens.json and data/dbc-configs.json (2026-09-21).
// Those files were read-whole/mutate/write-whole on every single request - a
// real race condition under any concurrent traffic (two people launching at
// the same time could each read the same state and overwrite each other's
// write), and impossible to share across more than one app instance. A real
// database fixes both: single-row UPDATE/INSERT statements are atomic, and
// any number of app instances can point at the same one.
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Creates the tables if they don't exist yet - run once at startup (see
 * src/index.js). Idempotent, same spirit as the old ensureDataDirs()
 * helpers it replaces. No migration framework - the schema is small enough
 * (two tables) that hand-written DDL is simpler than adding a dependency
 * for it.
 */
export async function ensureSchema() {
  // No PRIMARY KEY on (preset_id, quote_mint): Pyth-anchored configs
  // (preset_id = "pyth:<symbol>") are NEVER reused - a fresh one is
  // created on every launch on purpose (see dbcConfig.js), so the same
  // preset_id+quote_mint pair legitimately repeats across rows. Only the
  // FIXED presets need the reuse guarantee, enforced with a partial
  // unique index instead of a table-wide primary key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dbc_configs (
      id SERIAL PRIMARY KEY,
      preset_id TEXT NOT NULL,
      quote_mint TEXT NOT NULL,
      config_address TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dbc_configs_reusable_key
      ON dbc_configs (preset_id, quote_mint)
      WHERE preset_id NOT LIKE 'pyth:%'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launched_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quote_mint TEXT NOT NULL,
      quote_symbol TEXT NOT NULL,
      preset_id TEXT,
      pyth_symbol TEXT,
      first_buy_sol_ui NUMERIC,
      creator_public_key TEXT,
      dbc_migrated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      mint TEXT,
      pool_address TEXT,
      dbc_pool_address TEXT,
      image_url TEXT,
      error TEXT,
      blockhash TEXT,
      last_valid_block_height BIGINT
    )
  `);
  // Added 2026-10-02 (code review): the launch transaction's signature,
  // once it's actually broadcast - including on the 'error' path, where
  // confirmTransaction can time out even though the transaction already
  // landed or lands moments later. Without this there was no way to trace
  // an on-chain launch that our own record incorrectly shows as failed -
  // additive, nullable column, safe on an existing table (see db.js's own
  // "CREATE TABLE IF NOT EXISTS" note above for why ALTER is needed here
  // instead - that statement does nothing once the table already exists).
  await pool.query(`ALTER TABLE launched_tokens ADD COLUMN IF NOT EXISTS signature TEXT`);
}

export async function closePool() {
  await pool.end();
}
