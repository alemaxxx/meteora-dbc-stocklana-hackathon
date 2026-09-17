// Helps send a Solana transaction resilient to "block height exceeded"
// (the blockhash's validity window expires before confirming) - a common
// and TEMPORARY network error (congestion, slow RPC), not a bug in our
// code. Found on 2026-09-11, during "Lançar Token"'s first real token
// launch. Instead of giving up on the first failure, fetches a NEW
// blockhash and tries again.

function isExpiryError(err) {
  const msg = err?.message ?? "";
  return msg.includes("block height exceeded") || msg.includes("has expired") || msg.includes("blockhash not found");
}

// Overloaded RPC/API (429) - found live on 2026-09-12: Auto Buy's pool
// scanner (runs every 5s regardless of the toggle) plus StonkFun/pump.fun
// monitoring already keep the RPC near its limit at all times, and a
// launch (a concentrated burst of calls) lands right on top of that. Some
// SDKs (Raydium included) reject with objects that aren't real `Error`
// instances (`.message` comes back `undefined`) - that's why this checks
// the whole JSON as a last resort, not just `.message`.
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
 * Runs `fn` (receives the attempt number, 1-based) and retries, with a
 * fixed wait between attempts, as long as `isRetryable(err)` says it's
 * worth it - useful for whole operations (not just sending a single
 * transaction) that can fail from an overloaded RPC/API somewhere along
 * the way, e.g. launching a token via StonkFun/pump.fun.
 */
export async function retryWithDelay(fn, { attempts = 3, delayMs = 4000, isRetryable = () => true, label = "operation" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      console.warn(`[txHelpers] ${label}: attempt ${attempt}/${attempts} failed - waiting ${delayMs}ms before retrying...`, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Signs and sends an already-built Transaction (legacy, not
 * VersionedTransaction) with its instructions - fills/refreshes feePayer
 * and recentBlockhash on every attempt (a Transaction can be re-signed as
 * many times as needed, each .sign() recomputes everything from scratch
 * on top of the current recentBlockhash). The first item in `signers` is
 * always the fee payer, same convention already used across the project.
 *
 * Only retries when the error is clearly an expiry - any other error
 * (insufficient balance, account already exists, etc) bubbles up
 * immediately, since retrying wouldn't fix it and would only delay
 * surfacing the real error.
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
        console.warn(`[txHelpers] attempt ${attempt}/${maxAttempts} hit a rate limit (429) - waiting ${rateLimitDelayMs}ms before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs));
      } else {
        console.warn(`[txHelpers] attempt ${attempt}/${maxAttempts} expired (stale blockhash) - fetching a new one and retrying...`);
      }
    }
  }
  throw lastError;
}

/**
 * Waits for a freshly created account (in a PREVIOUS, already-confirmed
 * transaction) to become visible to this RPC before building the next
 * transaction that depends on it - found live on 2026-09-13 (two real
 * cases the same day: "IncorrectProgramId" creating the ATA in
 * tokenMinter.js, "AccountNotInitialized" (base_mint) on the buyback in
 * pumpfunLaunchpad.js) - the second transaction was simulating against an
 * RPC replica that hadn't yet seen the first one confirm, even with
 * "confirmed" commitment. Same patience pattern already used in
 * getMintInfo (tokenInfo.js) - just generalized to any account, not only
 * a mint.
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
