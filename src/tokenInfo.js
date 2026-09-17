import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const KNOWN_TOKENS = {
  SOL: { symbol: "SOL", name: "Wrapped SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { symbol: "USDC", name: "USD Coin", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { symbol: "USDT", name: "Tether USD", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  GPRO: { symbol: "GPRO", name: "GoPro - Backpack Securities", address: "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH", decimals: 6 },
  USD1: { symbol: "USD1", name: "World Liberty Financial USD", address: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6 },
};

const mintCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Descobre os decimais e o token program (classico ou Token2022) de um mint,
 * necessario pra montar a transacao de criacao de pool corretamente.
 */
export async function getMintInfo(connection, mintAddress) {
  const key = mintAddress.toString();
  if (mintCache.has(key)) return mintCache.get(key);

  const mintPubkey = new PublicKey(mintAddress);

  // Um mint RECÉM-criado (mesma transação, segundos atrás) pode ainda não
  // ter propagado pra essa leitura, principalmente com a RPC sobrecarregada
  // (ver conversa de 12/09/2026 - "Custom: 6025"/CRYTGLOW, mesma causa
  // raiz) - insiste um pouco antes de desistir. Pra um mint que realmente
  // não existe (endereço errado, rede errada), só atrasa o erro em uns
  // segundos, sem custo real.
  let accountInfo = null;
  for (let i = 0; i < 6; i++) {
    accountInfo = await connection.getAccountInfo(mintPubkey);
    if (accountInfo) break;
    await sleep(2000);
  }
  if (!accountInfo) {
    throw new Error(`Mint ${key} não encontrado on-chain.`);
  }

  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mintPubkey, undefined, programId);

  // `mint` (o objeto bruto retornado por getMint, com os dados de extensão
  // do Token-2022 quando existirem) + `currentEpoch` vão direto pro
  // preparePoolCreationParams da Meteora (ver poolCreator.js) - é a própria
  // SDK deles que já sabe descontar a taxa de transferência (Token-2022,
  // ex: StonkFun exigindo 1%/3% em alguns lançamentos - conversa de
  // 12/09/2026) igual o programa on-chain faz, sem a gente ter que
  // recalcular na mão. Pra um mint sem essa extensão, a própria função da
  // Meteora ignora e não muda nada.
  // Token clássico (TOKEN_PROGRAM_ID) nunca tem extensão nenhuma - só vale
  // a pena gastar mais uma chamada de RPC pra saber a época atual quando o
  // mint é Token-2022 (único que pode ter taxa de transferência).
  const currentEpoch = programId.equals(TOKEN_2022_PROGRAM_ID) ? (await connection.getEpochInfo()).epoch : 0;

  const result = { decimals: mintInfo.decimals, programId, mint: mintInfo, currentEpoch };
  mintCache.set(key, result);
  return result;
}
