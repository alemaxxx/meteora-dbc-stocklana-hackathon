import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, dbcClient } from "./connection.js";
import { requireWalletKeypair, SOL_MINT } from "./config.js";
import { sendAndConfirmWithRetry, waitForAccountVisible } from "./txHelpers.js";
import { getOrCreateDbcConfig } from "./dbcConfig.js";

// Lançamento via Meteora DBC (Dynamic Bonding Curve) - ver
// PLANO-DBC-MIGRACAO.md pro contexto (avaliação em cima do hackathon
// Stocklana, 15/09/2026). Substitui, num único passo, o que hoje são TRÊS
// etapas separadas pro método "stonkfun"/"pumpfun" (ver
// raydiumLaunchpad.js/pumpfunLaunchpad.js + tokenLauncher.js):
//   1. mintar/lançar o token numa bonding curve de terceiro,
//   2. comprar o quote token com o SOL configurado,
//   3. criar a pool DAMM v2 pareando os dois.
// Aqui, createPoolWithFirstBuy já minta o token, cria a curva (que É a
// liquidez inicial - não precisamos comprar quote nem parear nada com a
// mão) e opcionalmente faz a primeira compra como criador, tudo numa
// transação. A migração pra DAMM v2 acontece DEPOIS, quando a curva atinge
// o limiar configurado no config (ver dbcMigration.js) - não é síncrona com
// o lançamento.
//
// NUNCA TESTADO AO VIVO (diferente do resto do arquivo neste projeto) - os
// nomes de método/parâmetro batem com o .d.ts do pacote instalado (v1.5.12),
// mas nenhuma chamada real foi feita ainda (sem RPC/wallet configurados
// nesse ambiente). Antes de usar com dinheiro de verdade, rodar numa
// devnet/testnet primeiro - ver seção "Riscos" do PLANO-DBC-MIGRACAO.md.

function toRawAmount(uiAmount, decimals) {
  const [whole, frac = ""] = String(uiAmount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return new BN(raw || "0");
}

/**
 * Lança um token novo na curva do DBC. `firstBuySolUi` é opcional - igual ao
 * `buybackSolUi` do pump.fun/StonkFun, dá um empurrão inicial comprando do
 * próprio criador logo na criação, mas ao contrário deles NÃO é obrigatório
 * (a curva por si só já é a liquidez - o token fica comprável por qualquer
 * um assim que a pool existe, mesmo sem essa compra).
 *
 * `quoteMint`: só aceita o que o config aceitar (getOrCreateDbcConfig cria
 * um config novo por combinação preset+quote na primeira vez que for usada).
 *
 * Devolve o mint do token novo e o endereço da pool DBC (pool "virtual" -
 * pré-migração; ver dbcMigration.js pro endereço final na DAMM v2).
 */
export async function launchOnDbc({ name, symbol, metadataUri, presetId, quoteMint = SOL_MINT, firstBuySolUi }) {
  const wallet = requireWalletKeypair();
  const config = await getOrCreateDbcConfig(presetId, quoteMint);

  const hasFirstBuy = Number(firstBuySolUi) > 0;
  const baseMintKeypair = Keypair.generate();

  const createPoolParam = {
    name,
    symbol,
    uri: metadataUri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    config,
    baseMint: baseMintKeypair.publicKey,
  };

  // createPoolWithFirstBuy só ANEXA a instrução de compra quando
  // firstBuyParam.buyAmount > 0 (comportamento documentado no próprio SDK) -
  // por isso dá pra chamar a mesma função nos dois casos (com ou sem
  // compra inicial), sem precisar de dois caminhos de código diferentes.
  const tx = await dbcClient.creator.createPoolWithFirstBuy({
    createPoolParam,
    firstBuyParam: hasFirstBuy
      ? {
          buyer: wallet.publicKey,
          buyAmount: toRawAmount(firstBuySolUi, 9), // quote em SOL na maioria dos casos - se um dia aceitar quote != SOL na compra inicial, ajustar decimals aqui
          minimumAmountOut: new BN(0), // sem slippage guard na primeira compra (somos nós comprando na curva recém-criada, preço é determinístico) - revisitar se algum dia isso vier de fora
          referralTokenAccount: null,
        }
      : undefined,
  });

  const signature = await sendAndConfirmWithRetry(connection, tx, hasFirstBuy ? [wallet, baseMintKeypair] : [wallet, baseMintKeypair]);
  const mint = baseMintKeypair.publicKey.toBase58();

  // Endereço da pool DBC não vem no retorno de createPoolWithFirstBuy (só a
  // Transaction) - deriva/confirma lendo de volta via getPoolByBaseMint,
  // com a mesma paciência de propagação de RPC usada em getMintInfo/
  // waitForAccountVisible (mint acabou de confirmar, pode não estar visível
  // ainda pra outra réplica).
  await waitForAccountVisible(connection, baseMintKeypair.publicKey);
  const poolAccount = await dbcClient.state.getPoolByBaseMint(baseMintKeypair.publicKey);
  if (!poolAccount) {
    const err = new Error(`Token ${symbol} criado no DBC (mint ${mint}, tx ${signature}) mas não encontrei a pool ainda - confira on-chain.`);
    err.mint = mint;
    throw err;
  }

  console.log(`[dbcLaunchpad] ${symbol} lançado no DBC: mint ${mint}, pool ${poolAccount.publicKey.toBase58()} (tx ${signature})`);

  return {
    mint,
    poolAddress: poolAccount.publicKey.toBase58(),
    signature,
  };
}
