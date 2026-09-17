// Ajuda a enviar transação Solana de forma resistente a "block height
// exceeded" (o horário de validade do blockhash expira antes de
// confirmar) - erro comum e TEMPORÁRIO da rede (congestionamento, RPC
// lento), não um bug do nosso código. Achado em 11/09/2026, no primeiro
// lançamento de token de verdade pelo "Lançar Token". Em vez de desistir
// na primeira falha, busca um blockhash NOVO e tenta de novo.

function isExpiryError(err) {
  const msg = err?.message ?? "";
  return msg.includes("block height exceeded") || msg.includes("has expired") || msg.includes("blockhash not found");
}

// RPC/API sobrecarregada (429) - achado ao vivo em 12/09/2026: o scanner
// de pools do Auto Buy (roda a cada 5s, independente do toggle) mais a
// observação StonkFun/pump.fun já deixam a RPC perto do limite o tempo
// todo, e um lançamento (rajada de chamadas concentrada) cai bem em cima
// disso. Algumas SDKs (Raydium incluída) rejeitam com objetos que não são
// `Error` de verdade (`.message` vem `undefined`) - por isso confere o
// JSON inteiro como último recurso, não só `.message`.
function isRateLimitError(err) {
  const msg = err?.message || err?.error?.message || "";
  if (/429|too many requests/i.test(msg)) return true;
  try {
    return /429|too many requests/i.test(JSON.stringify(err));
  } catch {
    return false;
  }
}

/**
 * Executa `fn` (recebe o número da tentativa, 1-based) e tenta de novo,
 * com espera fixa entre tentativas, enquanto `isRetryable(err)` disser que
 * vale a pena - útil pra operações inteiras (não só o envio de uma
 * transação) que podem falhar por RPC/API sobrecarregada em algum ponto no
 * meio do caminho, ex: lançar um token pela StonkFun/pump.fun.
 */
export async function retryWithDelay(fn, { attempts = 3, delayMs = 4000, isRetryable = () => true, label = "operação" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      console.warn(`[txHelpers] ${label}: tentativa ${attempt}/${attempts} falhou - esperando ${delayMs}ms antes de tentar de novo...`, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Assina e envia uma Transaction (legacy, não VersionedTransaction) já
 * montada com as instruções - preenche/atualiza feePayer e recentBlockhash
 * a cada tentativa (uma Transaction pode ser re-assinada quantas vezes
 * quiser, cada .sign() recalcula tudo do zero em cima do recentBlockhash
 * atual). O primeiro item de `signers` é sempre o fee payer, mesma
 * convenção já usada no resto do projeto.
 *
 * Só tenta de novo quando o erro é claramente de expiração - qualquer
 * outro erro (saldo insuficiente, conta já existe, etc) sobe na hora,
 * repetir não ia resolver e só atrasaria o retorno do erro real.
 */
export async function sendAndConfirmWithRetry(connection, transaction, signers, { maxAttempts = 3, commitment = "confirmed", rateLimitDelayMs = 3000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signers[0].publicKey;
      transaction.sign(...signers);

      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment);
      return signature;
    } catch (err) {
      lastError = err;
      const rateLimited = isRateLimitError(err);
      if ((!isExpiryError(err) && !rateLimited) || attempt === maxAttempts) throw err;
      if (rateLimited) {
        console.warn(`[txHelpers] tentativa ${attempt}/${maxAttempts} tomou rate limit (429) - esperando ${rateLimitDelayMs}ms antes de tentar de novo...`);
        await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs));
      } else {
        console.warn(`[txHelpers] tentativa ${attempt}/${maxAttempts} expirou (blockhash vencido) - buscando um horário novo e tentando de novo...`);
      }
    }
  }
  throw lastError;
}

/**
 * Espera uma conta recém-criada (numa transação ANTERIOR, já confirmada)
 * ficar visível pra essa RPC antes de montar a próxima transação que
 * depende dela - achado ao vivo em 13/09/2026 (dois casos reais no mesmo
 * dia: "IncorrectProgramId" na criação da ATA em tokenMinter.js,
 * "AccountNotInitialized" (base_mint) na recompra em pumpfunLaunchpad.js) -
 * a segunda transação simulava contra uma réplica de RPC que ainda não
 * tinha visto a primeira confirmar, mesmo standing commitment "confirmed".
 * Mesmo padrão de paciência já usado em getMintInfo (tokenInfo.js) - só
 * generalizado pra qualquer conta, não só mint.
 */
export async function waitForAccountVisible(connection, pubkey, { attempts = 6, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const info = await connection.getAccountInfo(pubkey);
    if (info) return info;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

export { isExpiryError, isRateLimitError };
