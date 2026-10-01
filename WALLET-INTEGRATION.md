# How wallet connection + the Meteora DBC SDK work together

The architecture follows a strict rule: **the backend never holds or signs with the user's
private key.** The Meteora SDK is only ever used server-side to *build* transactions; the user's
own wallet extension is the only thing that ever signs with their key.

## 1. Wallet discovery & connect (client-side, `public/walletConnect.js`)

Uses the **Wallet Standard** (`@wallet-standard/app`), not a single hardcoded provider - this
auto-detects every installed wallet that implements the standard (Phantom, Solflare, Backpack,
etc.), not just one.

```js
import { getWallets } from "@wallet-standard/app";

const wallets = getWallets().get().filter(isSolanaWallet); // standard:connect + solana:signTransaction features
const { accounts } = await wallet.features["standard:connect"].connect();
```

The connected wallet's public key and account handle are kept in a small shared module
(`window.CurveForgeWallet`, set up in `public/navBar.js`) that other pages/scripts read from.

## 2. The two-phase prepare → sign → submit pattern (every on-chain action: launch, migrate, claim)

**Phase 1 - server builds the transaction** using the Meteora SDK
(`@meteora-ag/dynamic-bonding-curve-sdk`'s `DynamicBondingCurveClient`):

```js
// POST /api/launch/prepare
const tx = await dbcClient.pool.createPoolWithFirstBuy({ ...params, creator: creatorPublicKey });
tx.feePayer = creatorPublicKey;        // the USER pays, not the platform
tx.partialSign(newMintKeypair);        // server signs only for the NEW mint's own required keypair
return tx.serialize({ requireAllSignatures: false }).toString("base64");
```

No SOL moves at this point - it's just an unsigned (or partially-signed, for the mint keypair
only) transaction object.

**Phase 2 - the connected wallet signs it client-side:**

```js
const tx = Transaction.from(bytesFromBase64);
const signedBytes = await wallet.features["solana:signTransaction"].signTransaction({
  transaction: tx.serialize({ requireAllSignatures: false }),
  account,
});
// this pops the wallet's own approval UI - the user explicitly approves here
```

**Then the signed transaction is sent back to the server to broadcast:**

```js
// POST /api/launch/submit { signedTransactionBase64 }
const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
```

## Why this pattern specifically

A real bug was found and fixed doing this (documented in the codebase, `src/dbcMigration.js`):
some DBC program instructions (e.g. claiming creator trading fees) require the `creator` account
to be a **signer matching the pool's on-chain creator field**. A naive "server signs everything
with its own platform keypair" approach only works for pools the platform itself happens to own -
any real user's own claim would fail on-chain with a signer mismatch. So every wallet-facing
action (launch, migrate-to-DAMM-v2, claim creator fee) follows this same prepare/sign/submit
shape, with the **connected wallet as both `payer` and the on-chain authority field**, never the
platform's own keypair.

## The trust boundary, summarized

- Meteora SDK calls that only **read** on-chain state (quotes, pool info, simulations) run freely
  server-side with no signing involved.
- Any SDK call that **builds a transaction requiring the user's signature** returns an
  unsigned/partially-signed transaction; the actual private-key operation happens exclusively in
  the browser via the Wallet Standard interface, and never touches the server.
