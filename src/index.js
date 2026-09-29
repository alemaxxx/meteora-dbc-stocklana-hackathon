import { config, wallet } from "./config.js";
import { startServer } from "./server.js";
import { ensureSchema } from "./db.js";

console.log("=== CurveForge ===");
console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
console.log(`RPC: ${config.rpcUrl}`);

await ensureSchema();
startServer();
