import { Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");
// client.pool/partner/creator/migration/state - os quatro "services" do
// SDK (ver docs.md do pacote instalado). Nenhuma dependência do
// @meteora-ag/cp-amm-sdk aqui - diferente do Lançar Token Bot original,
// esse projeto não cria pool DAMM v2 "customizável" na mão em nenhum
// método; a migração pra DAMM v2 é feita pelo próprio DBC
// (client.migration.migrateToDammV2, ver dbcMigration.js).
export const dbcClient = DynamicBondingCurveClient.create(connection, "confirmed");
