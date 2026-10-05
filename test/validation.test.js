import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPublicKey } from "../src/validation.js";

test("accepts real Solana addresses", () => {
  assert.equal(isValidPublicKey("So11111111111111111111111111111111111111112"), true);
  assert.equal(isValidPublicKey("4tar3zNMmnBFwzQzM5JYr6LEXnB3qNbQ9PekGQ112H5m"), true);
});

test("rejects malformed input", () => {
  assert.equal(isValidPublicKey("notanaddress"), false);
  assert.equal(isValidPublicKey(""), false);
  assert.equal(isValidPublicKey("0OIl"), false); // characters outside the base58 alphabet
  assert.equal(isValidPublicKey("So1111"), false); // too short
});

test("rejects non-string values", () => {
  assert.equal(isValidPublicKey(undefined), false);
  assert.equal(isValidPublicKey(null), false);
  assert.equal(isValidPublicKey(123), false);
  assert.equal(isValidPublicKey(["So11111111111111111111111111111111111111112"]), false);
});
