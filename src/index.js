import { config, wallet } from "./config.js";
import { startServer } from "./server.js";

console.log("=== Meteora DBC Launchpad ===");
console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
console.log(`RPC: ${config.rpcUrl}`);

startServer();
