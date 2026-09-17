import fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildCurve,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";
import { sendAndConfirmWithRetry } from "./txHelpers.js";

// Etapa "config" do DBC (Dynamic Bonding Curve) - ver PLANO-DBC-MIGRACAO.md
// pro desenho completo. Um "config" é uma conta SEPARADA do pool: define o
// formato da curva (taxa, supply, limiar de migração pra DAMM v2, etc) e é
// FEITO PRA SER REUSADO - a própria Meteora recomenda um config por
// combinação de (quote token + regras de taxa/curva), não um por token
// lançado. Criar um novo custa uma transação + rent; reusar não custa nada
// além da leitura. Por isso esse arquivo cacheia o endereço criado em
// data/dbc-configs.json, do mesmo jeito que tokenLauncher.js cacheia
// lançamentos em data/launched-tokens.json.

const DBC_CONFIGS_FILE = new URL("../data/dbc-configs.json", import.meta.url);

function ensureDataDir() {
  const dir = new URL("../data/", import.meta.url);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfigs() {
  ensureDataDir();
  if (!fs.existsSync(DBC_CONFIGS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DBC_CONFIGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfigs(list) {
  ensureDataDir();
  fs.writeFileSync(DBC_CONFIGS_FILE, JSON.stringify(list, null, 2));
}

// CONFIRMADO (17/09/2026) contra a config de referência oficial da própria
// Meteora (github.com/MeteoraAg/meteora-invent, studio/config/dbc_config.jsonc,
// buildCurveMode 0 - o mesmo modo usado abaixo) e contra a tabela de
// "migration keepers" em docs.meteora.ag/developer-guides/dbc: o exemplo
// oficial usa migrationQuoteThreshold: 10 (SOL) - o limiar canônico pra
// pools cotadas em SOL. O valor anterior aqui (85 SOL) era o número
// clássico de graduação do pump.fun, carregado por suposição e NUNCA
// confirmado pro DBC - com o docs.meteora.ag acessível agora (estava
// bloqueado pelo proxy de rede em 15/09/2026), confirmou-se que 85 estava
// 8,5x acima do valor de referência, o que exigiria acumular bem mais SOL
// de compras reais pra migrar. Ajustado pra 10 (mesmo valor do exemplo
// oficial). O campo "initialMarketCap" que existia antes foi removido -
// nunca era lido em lugar nenhum: só existe pros modos
// buildCurveWithMarketCap/... (não usados aqui, ver buildConfigParameters
// abaixo, que usa buildCurve puro com percentageSupplyOnMigration +
// migrationQuoteThreshold).
// ACHADO AO VIVO (16/09/2026, primeiro lançamento DBC de verdade -
// NARWAVE, mint 5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei): taxa inicial
// de 10% (preset "default-2h-linear") disparou o alerta automático de
// "high tax" no GMGN (mostrou "Dex 9.83%" ~2min depois do lançamento, e
// GMGN marcou com bandeira de segurança) - terminal de trade costuma
// rejeitar/alertar token com taxa alta assim, de propósito (heurística
// contra honeypot), o que espanta comprador de verdade mesmo o token
// sendo legítimo. Supply (1B) e o resto da config bateram certinho -
// só a taxa inicial que era alta demais pra esse efeito colateral.
// Por isso o preset "baixa-taxa" abaixo, SEM apagar o original (dá pra
// comparar os dois lançamentos lado a lado).
export const DBC_CURVE_PRESETS = [
  {
    id: "baixa-taxa-2h-linear",
    label: "Baixa taxa (3%→0,5% em 2h, migra em 10 SOL acumulados na curva) - recomendado após achado do NARWAVE",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 10,
    startingFeeBps: 300, // 3% - abaixo do que costuma disparar "high tax" em scanner de terminal (GMGN etc)
    endingFeeBps: 50, // 0,5%
    schedulerDurationSeconds: 7200,
  },
  {
    id: "default-2h-linear",
    label: "Padrão (taxa 10%→1% em 2h, migra em 10 SOL acumulados na curva) - dispara alerta de \"high tax\" no GMGN (achado no NARWAVE), use com cautela",
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20, // 20% do supply migra pra pool DAMM v2, resto fica com quem comprou na curva
    migrationQuoteThreshold: 10, // SOL acumulado na curva pra liberar migração - confirmado contra dbc_config.jsonc oficial
    startingFeeBps: 1000, // 10%
    endingFeeBps: 100, // 1%
    schedulerDurationSeconds: 7200, // 2h, mesmo padrão já usado em presets.js (SCHEDULER_DURATION_SECONDS)
  },
];

export function findDbcCurvePreset(id) {
  return DBC_CURVE_PRESETS.find((p) => p.id === id);
}

/**
 * Monta os ConfigParameters (curva + taxas + migração) a partir de um preset
 * + o quote escolhido - usa buildCurve, que faz toda a matemática de
 * sqrtPrice/liquidity pra gente (equivalente ao preparePoolCreationParams
 * que poolCreator.js já usa pro DAMM v2, só que do lado do DBC).
 */
async function buildConfigParameters(preset, quoteMint) {
  const quoteInfo = await getMintInfo(connection, quoteMint);

  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken, // token novo, mintado pelo próprio DBC - sem necessidade do Token-2022 que StonkFun/pump.fun às vezes exigem
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteInfo.decimals, // precisa bater com o decimals REAL do quote (SPYx = 8, SOL = 9, USDC/USDT = 6)
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // sem mint/update authority sobrando com a gente depois de lançado - mesmo espírito do "direct" (mintNewToken já revoga authority, ver tokenMinter.js)
      totalTokenSupply: preset.totalTokenSupply,
      leftover: 0, // nada retido de propósito - todo o supply que não migra fica com quem comprou na curva
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: preset.startingFeeBps,
          endingFeeBps: preset.endingFeeBps,
          numberOfPeriod: preset.schedulerDurationSeconds,
          totalDuration: preset.schedulerDurationSeconds,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken, // taxa sempre no quote (SOL/SPYx/...), nunca no token novo - mais previsível pra sacar depois (ver dbcMigration.js)
      creatorTradingFeePercentage: 100, // 100% da taxa de criador fica com a gente (não tem parceiro terceiro nesse projeto)
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // V1 tá deprecated pra config novo
      migrationFeeOption: MigrationFeeOption.FixedBps100, // 1% de taxa na pool DAMM v2 pós-migração - meio-termo, revisitar
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // sem taxa EXTRA de migração além da acima
    },
    liquidityDistribution: {
      // 100% da liquidez de migração fica travada (permanent locked) em nome
      // do creator - sem isso, dá pra sacar a liquidez inteira da pool
      // recém-migrada e rugar; não é o que esse bot faz nos outros métodos
      // (createInfinitePool também trava via posição NFT, nunca dá approve
      // de remoção livre).
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,
    },
    lockedVesting: {
      // Sem vesting nenhum sobre o supply que fica de fora da migração -
      // mesmo comportamento que "direct" já tem hoje (supply inteiro líquido,
      // sem cadeado).
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp, // mesma convenção já usada em poolCreator.js (activationType: 1)
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
    migrationQuoteThreshold: preset.migrationQuoteThreshold,
  });
}

/**
 * Devolve o endereço de um config já criado (cache local) pra essa
 * combinação (preset, quote), criando um novo on-chain só na primeira vez.
 * Nunca cria dois configs pro mesmo par preset+quote - sempre reusa.
 */
export async function getOrCreateDbcConfig(presetId, quoteMint) {
  const preset = findDbcCurvePreset(presetId);
  if (!preset) throw new Error(`Preset de curva DBC desconhecido: "${presetId}".`);

  const list = loadConfigs();
  const cached = list.find((c) => c.presetId === presetId && c.quoteMint === quoteMint);
  if (cached) return new PublicKey(cached.configAddress);

  const wallet = requireWalletKeypair();
  const configKeypair = Keypair.generate(); // conta nova - endereço do config é aleatório, não determinístico (ao contrário da pool "customizável" do DAMM v2 em poolCreator.js)
  const configParams = await buildConfigParameters(preset, quoteMint);

  const tx = await dbcClient.partner.createConfig({
    ...configParams,
    config: configKeypair.publicKey,
    feeClaimer: wallet.publicKey, // sacamos a taxa de "partner" (dono do config) E de "creator" (dono do pool) - somos as duas partes aqui
    leftoverReceiver: wallet.publicKey,
    quoteMint: new PublicKey(quoteMint),
    payer: wallet.publicKey,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, [wallet, configKeypair]);
  console.log(`[dbcConfig] config novo criado pra preset "${presetId}" / quote ${quoteMint}: ${configKeypair.publicKey.toBase58()} (tx ${signature})`);

  list.push({
    presetId,
    quoteMint,
    configAddress: configKeypair.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    signature,
  });
  saveConfigs(list);

  return configKeypair.publicKey;
}
