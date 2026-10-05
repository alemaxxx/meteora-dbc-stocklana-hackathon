import { PublicKey } from "@solana/web3.js";

// True only for a real base58 Solana public key (32 bytes). The public
// read-only routes use this to answer 400 for malformed input instead of
// letting `new PublicKey(...)` throw and surface as a 500.
export function isValidPublicKey(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
