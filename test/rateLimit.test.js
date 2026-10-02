// Run with: node --test test/
//
// rateLimit.js has no imports of its own (no .env/network needed) - this
// file can run standalone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../src/rateLimit.js";

function fakeReqRes(ip) {
  const req = { ip };
  let statusCode = null;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

test("rateLimit: allows up to max requests per window, then blocks with 429", () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 3 });
  const ip = "1.2.3.4";
  let nextCalls = 0;
  const next = () => nextCalls++;

  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes(ip);
    limiter(req, res, next);
  }
  assert.equal(nextCalls, 3, "first 3 requests within the limit should all call next()");

  const fourth = fakeReqRes(ip);
  limiter(fourth.req, fourth.res, next);
  assert.equal(nextCalls, 3, "the 4th request should NOT call next()");
  assert.equal(fourth.getStatus(), 429);
  assert.match(fourth.getBody().error, /too many requests/i);
});

test("rateLimit: tracks separate buckets per IP - one IP's limit doesn't affect another's", () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  let nextCalls = 0;
  const next = () => nextCalls++;

  const a1 = fakeReqRes("1.1.1.1");
  limiter(a1.req, a1.res, next);
  const a2 = fakeReqRes("1.1.1.1");
  limiter(a2.req, a2.res, next);
  const b1 = fakeReqRes("2.2.2.2");
  limiter(b1.req, b1.res, next);

  assert.equal(nextCalls, 2, "IP A's first request and IP B's first request should both pass");
  assert.equal(a2.getStatus(), 429, "IP A's second request should be blocked");
  assert.equal(b1.getStatus(), null, "IP B's first request should not be blocked");
});

test("rateLimit: treats a missing req.ip as a shared \"unknown\" bucket, not a crash", () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  let nextCalls = 0;
  const next = () => nextCalls++;

  const first = fakeReqRes(undefined);
  assert.doesNotThrow(() => limiter(first.req, first.res, next));
  assert.equal(nextCalls, 1);
});
