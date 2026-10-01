// Wallet Standard integration - detects EVERY installed wallet that
// implements the standard (Phantom, Solflare, Backpack, and virtually
// every serious Solana wallet as of 2024+), not just one hardcoded
// provider. Loaded as a module (see index.html) so it can import
// @wallet-standard/app straight from a CDN (esm.sh resolves npm packages
// to real ESM on the fly) - this project has no bundler, so a plain
// `import` in a module script is the simplest way in without adding a
// build step. Exposes a small `window.WalletConnect` API for app.js
// (a classic, non-module script) to call.
//
// Why this exists (2026-09-17): the first version only checked
// `window.solana` (Phantom's own injected object) - works for Phantom,
// but the user immediately (and rightly) asked for other wallets too.
// See DBC-MIGRATION-PLAN.md section 5.7/5.8.
import { getWallets } from "https://esm.sh/@wallet-standard/app@1";

const SOLANA_CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet"];

function isSolanaWallet(wallet) {
  return wallet.chains.some((c) => SOLANA_CHAINS.includes(c)) && !!wallet.features["standard:connect"] && !!wallet.features["solana:signTransaction"];
}

function listWallets() {
  return getWallets().get().filter(isSolanaWallet);
}

const changeListeners = [];
function onWalletsChanged(cb) {
  changeListeners.push(cb);
}
function notifyChanged() {
  const wallets = listWallets();
  changeListeners.forEach((cb) => cb(wallets));
}

const { on } = getWallets();
on("register", notifyChanged);
on("unregister", notifyChanged);

async function connect(wallet) {
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account.`);
  return { address: account.address, account };
}

// Not every Wallet Standard wallet implements "standard:disconnect" (it's
// optional in the spec) - when it's missing, there's nothing more to do on
// the wallet's side; the caller (navBar.js) still forgets the local
// connected-wallet state either way.
async function disconnect(wallet) {
  await wallet.features["standard:disconnect"]?.disconnect();
}

/**
 * Signs a (possibly already partially-signed) transaction, given as raw
 * bytes, and returns the fully-signed bytes back. Wallet Standard wallets
 * are required to preserve any signatures already present and only fill
 * in their own - same guarantee Phantom's legacy API gives.
 */
async function signTransaction(wallet, account, transactionBytes) {
  const [{ signedTransaction }] = await wallet.features["solana:signTransaction"].signTransaction({
    transaction: transactionBytes,
    account,
  });
  return signedTransaction;
}

window.WalletConnect = { listWallets, onWalletsChanged, connect, disconnect, signTransaction };
