import { Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");
// client.pool/partner/creator/migration/state - the SDK's four "services"
// (see the installed package's docs). No dependency on
// @meteora-ag/cp-amm-sdk here - unlike the original Lançar Token Bot, this
// project never creates a "customizable" DAMM v2 pool by hand in any
// method; migration to DAMM v2 is handled by DBC itself
// (client.migration.migrateToDammV2, see dbcMigration.js).
export const dbcClient = DynamicBondingCurveClient.create(connection, "confirmed");
