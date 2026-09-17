import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { config } from "./config.js";
import { getMintInfo } from "./tokenInfo.js";

const connection = new Connection(config.rpcUrl, "confirmed");
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

/**
 * Returns the configured wallet's balance for a token. For SOL, reads the
 * native balance (not the wSOL account, since that's what the user
 * actually holds and the SDK wraps it automatically when creating the
 * pool).
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
      raw: bal.value.amount, // exact integer value as a string (no floating point)
    };
  } catch {
    // account doesn't exist yet = zero balance
    return { balance: 0, decimals, raw: "0" };
  }
}
