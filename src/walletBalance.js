import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { config } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";

const connection = new Connection(config.rpcUrl, "confirmed");
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

/**
 * Retorna o saldo da wallet configurada pra um token. Se for SOL, le o
 * saldo nativo (nao a conta de wSOL, ja que e isso que o usuario de fato
 * possui e o SDK embrulha automaticamente na hora de criar a pool).
 */
export async function getWalletTokenBalance(mintAddress) {
  if (mintAddress === NATIVE_SOL) {
    const lamports = await connection.getBalance(config.walletAddress);
    return { balance: lamports / 1e9, decimals: 9, raw: String(lamports) };
  }

  const { decimals, programId } = await getMintInfo(connection, mintAddress);

  try {
    const ata = await getAssociatedTokenAddress(
      new PublicKey(mintAddress),
      config.walletAddress,
      false,
      programId
    );
    const bal = await connection.getTokenAccountBalance(ata);
    return {
      balance: Number(bal.value.uiAmountString ?? bal.value.uiAmount ?? 0),
      decimals,
      raw: bal.value.amount, // string do valor inteiro exato (sem ponto flutuante)
    };
  } catch {
    // conta ainda nao existe = saldo zero
    return { balance: 0, decimals, raw: "0" };
  }
}
