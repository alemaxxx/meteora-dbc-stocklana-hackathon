import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";

// Segunda metade do ciclo de vida de um pool DBC - ver PLANO-DBC-MIGRACAO.md.
// Ao contrário do fluxo atual (createInfinitePool, em poolCreator.js), a
// pool DAMM v2 aqui NÃO é criada no lançamento: ela só passa a existir
// quando a curva "completa" (atinge o migrationQuoteThreshold configurado
// em dbcConfig.js) e alguém - qualquer um, não precisa ser o criador -
// chama migrateToDammV2. Esse arquivo cobre: checar se um pool tá pronto,
// migrar, e sacar as taxas acumuladas (de criador e de "partner" - somos os
// dois, ver dbcConfig.js).
//
// NUNCA TESTADO AO VIVO - mesma ressalva de dbcLaunchpad.js.

// migrationFeeOption tem que ser IGUAL ao usado na criação do config (ver
// dbcConfig.js - hoje fixo em FixedBps100) - cada opção de taxa de migração
// tem uma conta de config da DAMM v2 PRÓPRIA e pré-definida pela Meteora
// (DAMM_V2_MIGRATION_FEE_ADDRESS, exportado pelo próprio SDK - índice bate
// com o enum MigrationFeeOption, confirmado lendo o pacote instalado,
// v1.5.12). Se um dia dbcConfig.js passar a variar migrationFeeOption por
// preset, isso aqui precisa ler o mesmo valor do preset em vez de fixo.
const MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps100;

/**
 * Progresso da curva (0 a 1) em cima do quote token acumulado - 1 = pronto
 * pra migrar. Só leitura, não assina nada.
 */
export async function getDbcCurveProgress(poolAddress) {
  return dbcClient.state.getPoolQuoteTokenCurveProgress(new PublicKey(poolAddress));
}

/**
 * Migra um pool DBC completo pra uma pool DAMM v2 de verdade - equivalente
 * "automático" do createInfinitePool de poolCreator.js, só que aqui quem
 * decide o preço/liquidez inicial da pool nova é a própria curva que já
 * rodou, não um depósito manual nosso. Não faz nada (e não gasta SOL) se o
 * pool ainda não atingiu o limiar - checa isMigrated antes de tentar.
 */
export async function migrateDbcPoolIfReady(poolAddress) {
  const wallet = requireWalletKeypair();
  const poolPubkey = new PublicKey(poolAddress);

  // getPool devolve a conta Anchor CRUA - o IDL tem "virtualPool" como um
  // wrapper de UM campo (poolState), então os campos de verdade (isMigrated,
  // baseMint, config, ...) ficam em pool.poolState, não no objeto raiz
  // (confirmado lendo o IDL do pacote instalado, v1.5.12 - fácil de errar
  // essa camada a mais).
  const pool = await dbcClient.state.getPool(poolPubkey);
  if (!pool) throw new Error(`Pool DBC ${poolAddress} não encontrado on-chain.`);
  if (pool.poolState.isMigrated) {
    return { migrated: false, alreadyMigrated: true };
  }

  const progress = await dbcClient.state.getPoolQuoteTokenCurveProgress(poolPubkey);
  if (progress < 1) {
    return { migrated: false, progress };
  }

  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION];
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbcClient.migration.migrateToDammV2({
    payer: wallet.publicKey,
    pool: poolPubkey,
    dammConfig,
  });

  // Duas posições NFT novas (mesmo padrão de positionNftKeypair já usado em
  // poolCreator.js pro DAMM v2 "customizável") - a própria SDK monta os dois
  // no mesmo Keypair.generate() internamente, só devolve pra gente assinar.
  const signature = await sendAndConfirmWithRetry(connection, transaction, [wallet, firstPositionNftKeypair, secondPositionNftKeypair]);
  console.log(`[dbcMigration] pool ${poolAddress} migrado pra DAMM v2 (tx ${signature})`);

  // Endereço da pool DAMM v2 nova é determinístico (PDA derivada de
  // dammConfig + os dois mints - mesma família de deriveCustomizablePoolAddress
  // já usada em poolCreator.js) - calcula só pra devolver pra UI, sem
  // depender de nenhum retorno extra do migrateToDammV2 (que só devolve a
  // Transaction). Se ISSO aqui falhar por qualquer motivo, a migração em si
  // JÁ ACONTECEU (a transação acima já confirmou) - nunca reporta erro pro
  // usuário por causa disso, só loga e devolve sem o endereço.
  let newPoolAddress = null;
  try {
    const poolConfig = await dbcClient.state.getPoolConfig(pool.poolState.config);
    newPoolAddress = deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, poolConfig.quoteMint).toBase58();
  } catch (err) {
    console.warn(`[dbcMigration] migração de ${poolAddress} confirmada (tx ${signature}), mas não consegui calcular o endereço da pool DAMM v2 nova:`, err.message);
  }

  return { migrated: true, signature, newPoolAddress };
}

/**
 * Saca as taxas de negociação acumuladas na curva - de criador E de
 * "partner" (config), já que somos as duas partes (ver feeClaimer/creator em
 * dbcConfig.js). maxBaseAmount/maxQuoteAmount = BN máximo (U64) sacam tudo
 * que tiver disponível, mesma convenção de "0 = não sacar esse lado" que a
 * própria doc do SDK descreve pro lado que a gente NÃO quiser sacar.
 */
export async function claimDbcFees(poolAddress) {
  const wallet = requireWalletKeypair();
  const poolPubkey = new PublicKey(poolAddress);
  const maxAmount = new BN("18446744073709551615"); // U64_MAX - "sacar tudo"

  const creatorTx = await dbcClient.creator.claimCreatorTradingFee({
    creator: wallet.publicKey,
    payer: wallet.publicKey,
    pool: poolPubkey,
    maxBaseAmount: maxAmount,
    maxQuoteAmount: maxAmount,
  });
  const creatorSignature = await sendAndConfirmWithRetry(connection, creatorTx, [wallet]);

  const partnerTx = await dbcClient.partner.claimPartnerTradingFee({
    feeClaimer: wallet.publicKey,
    payer: wallet.publicKey,
    pool: poolPubkey,
    maxBaseAmount: maxAmount,
    maxQuoteAmount: maxAmount,
  });
  const partnerSignature = await sendAndConfirmWithRetry(connection, partnerTx, [wallet]);

  console.log(`[dbcMigration] taxas do pool ${poolAddress} sacadas (creator tx ${creatorSignature}, partner tx ${partnerSignature})`);
  return { creatorSignature, partnerSignature };
}
