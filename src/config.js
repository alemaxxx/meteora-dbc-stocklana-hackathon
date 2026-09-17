import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Environment variable ${name} is not set. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

// Extracted from the Lançar Token Bot (github.com/alemaxxx/lauch-token) -
// a lean version for this project, focused only on the Meteora DBC flow.
// No VOLUME_WALLET_PRIVATE_KEY/JUPITER_API_KEY/OPENAI_API_KEY - none of
// those pieces from the original bot are used here (no volume generator,
// no Jupiter swap - the initial buy on the curve always uses plain SOL -
// and no AI image suggestion, just manual upload).
const rawKey = required("WALLET_PRIVATE_KEY");
export const wallet = Keypair.fromSecretKey(bs58.decode(rawKey));

export const config = {
  rpcUrl: required("RPC_URL"),
  walletAddress: wallet.publicKey,
  walletAddressStr: wallet.publicKey.toBase58(),
  walletKeypair: wallet,
  dashboardPort: Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000),
};

export function requireWalletKeypair() {
  return wallet;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
