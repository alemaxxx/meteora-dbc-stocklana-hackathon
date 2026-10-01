import { Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");
// client.pool/partner/creator/migration/state - the SDK's four "services"
// (see the installed package's docs). Migration to DAMM v2 is handled by
// DBC itself (client.migration.migrateToDammV2, see dbcMigration.js) -
// this project never creates a "customizable" DAMM v2 pool by hand.
export const dbcClient = DynamicBondingCurveClient.create(connection, "confirmed");
// Added 2026-10-01 for read-only post-migration pool info/quotes
// (dammPoolInfo.js) - NOT used to build or send any swap transaction yet,
// only fetchPoolState + getQuote (both pure reads/math, no fund risk).
export const cpAmm = new CpAmm(connection);
