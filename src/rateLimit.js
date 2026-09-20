// Minimal in-memory, per-IP rate limiter - no new dependency, just enough
// to stop unbounded abuse of routes that cost the PLATFORM wallet real
// SOL (launch/prepare's Arweave upload, migrate, claim-partner-fee).
// Added 2026-09-20 as part of a pre-launch security review: none of these
// routes require auth or a wallet signature to be CALLED (only the
// wallet-connected ones require a signature to actually spend money from
// the caller's own funds) - without a limiter, anyone could spam
// /api/launch/prepare and slowly drain the platform wallet via repeated
// real Arweave uploads that never get completed into an actual launch.
//
// In-memory means limits reset on every server restart/redeploy and don't
// share state across multiple instances - acceptable for this project's
// single-instance Railway deployment, not meant to be a hardened
// distributed rate limiter.

const buckets = new Map(); // key -> { count, resetAt }

/**
 * `max` requests per `windowMs`, keyed by IP. Trusts `req.ip`, which only
 * reflects the real client address if the app is configured with
 * `app.set("trust proxy", ...)` behind a reverse proxy (see server.js) -
 * otherwise every request behind the same proxy would share one bucket.
 */
export function rateLimit({ windowMs, max, message = "Too many requests - please slow down." }) {
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      return res.status(429).json({ error: message });
    }
    bucket.count += 1;
    next();
  };
}
