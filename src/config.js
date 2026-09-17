import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variavel de ambiente ${name} nao definida. Copie .env.example para .env e preencha.`
    );
  }
  return value;
}

// Extraído do Lançar Token Bot (github.com/alemaxxx/lauch-token) - versão
// enxuta pra esse projeto, focado só no fluxo Meteora DBC. Sem
// VOLUME_WALLET_PRIVATE_KEY/JUPITER_API_KEY/OPENAI_API_KEY - nenhuma
// dessas peças do bot original é usada aqui (sem gerador de volume, sem
// swap via Jupiter - a compra inicial na curva sempre usa SOL puro - e sem
// sugestão de imagem por IA, só upload manual).
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
