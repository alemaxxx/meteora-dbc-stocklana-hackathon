import { config, wallet } from "./config.js";
import { startServer } from "./server.js";
import { ensureSchema } from "./db.js";

// Redacts any query-string credential (Helius and most RPC providers pass
// the API key as ?api-key=... right in the URL) before it ever reaches a
// log line - found 2026-10-02 (code review): this used to log config.rpcUrl
// verbatim on every single startup, meaning the live Helius key has been
// sitting in plaintext in every deploy's Railway logs since day one. Not a
// cosmetic fix - a log line is exactly the kind of place that gets pasted
// into a support ticket, shared with a collaborator, or read by a debugging
// session (this one included) without a second thought.
function redactUrlCredentials(url) {
  try {
    const parsed = new URL(url);
    for (const param of parsed.searchParams.keys()) {
      parsed.searchParams.set(param, "***REDACTED***");
    }
    return parsed.toString();
  } catch {
    return "(unparseable URL, not logged)";
  }
}

console.log("=== CurveForge ===");
console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
console.log(`RPC: ${redactUrlCredentials(config.rpcUrl)}`);

await ensureSchema();
startServer();
