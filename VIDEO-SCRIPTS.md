# CurveForge — demo & pitch video scripts, weekly update, Superteam Earn texts

Updated 2026-10-02 to match what's actually shipped (331 stock-quoted presets, DLMM Conviction
Pools, automated tests, MIT license). Recording is planned for Sunday 2026-10-04.

Colosseum's Crypto World's Fair submission needs two separate videos:
- **Demo video** (≤3 min, required) — "Should show the live product, not a slide deck, not a code walkthrough."
- **Pitch video** (≤2 min, required, Public) — "introduce yourselves, tell us what you're building, and tell us why you're the people to build it."

The scripts below are drafts to read from or adapt in your own words — not a transcript to recite
verbatim. Timings are targets, not hard cuts.

**Key dates (Brasília time):** weekly update (optional) Mon 10/05 12:00 · Colosseum draft Tue 10/06
08:00 · final Tue 10/13 03:59 (= Oct 12 11:59 PM PDT).

---

## Demo video (target: 2:30-3:00)

**Screen: curveforge.finance home page**
> "This is CurveForge — a token launchpad on Solana's Meteora Dynamic Bonding Curve. Every token launches with instant liquidity, no presale, no team allocation. And you can quote it directly against a real tokenized stock — not just SOL."

**Screen: Launch page, click through the preset category tabs (point at the counts), type "tesla" in the search box**
> "331 stock-quoted presets across three real issuers — 31 from xStocks, 61 from Backpack Securities, 239 from Ondo — plus SOL and USDC curves. Every single stock mint was individually checked on-chain before it was listed."

**Screen: Launch page, open the "Live-priced (Pyth)" tab, select TSLA**
> "This one's anchored to Tesla's live price feed from Pyth — the migration target moves with the market."
(Let the live price populate on screen — "TSLA @ $X, SOL @ $Y" — this is the proof it's real, not hardcoded.)

**Screen: scroll to the "Simulated buys" panel**
> "Before anyone spends anything, you can see what a small, medium, or large buy would actually cost — computed with the same math the on-chain program uses."

**Screen: Explore page, scroll to SOLBULL (migrated), point at the live price line**
> "This token launched, traded, and migrated to a permanent DAMM v2 pool — fully on mainnet, real transactions. The price you see is read live from that pool." (Click "open on Meteora" to show the real pool.)

**Screen: Explore page, SOLBULL row, point at "Open Conviction Pool"** (optional: click it with a wallet connected)
> "After migration, a creator can open a second, concentrated position on Meteora's DLMM — a Conviction Pool. It's an explicit, wallet-signed action, never automatic, and it checks the on-chain requirement up front instead of failing with a cryptic error."
Honest framing, do not overclaim: the pool-creation and position transactions were verified against live mainnet state by simulation, but no real position has been opened end to end — so say "built and verified against mainnet", not "I opened one".

**Screen: the Claim fees / Migrate buttons**
> "Creators manage their own tokens from here — track progress, migrate once the threshold hits, claim trading fees. Every action is an explicit click; nothing runs in the background."

**Screen: Docs page, the public API section (optionally open `/api/damm-pool/4tar3zNMmnBFwzQzM5JYr6LEXnB3qNbQ9PekGQ112H5m` in a tab)**
> "And there's a public, CORS-open API — anyone can read the live state of any Meteora DBC or DAMM v2 pool, not just ones launched here."

**Close, back on Home:**
> "Real stock-quoted launches, verified on-chain, tested on mainnet. The code is open-source under MIT. That's CurveForge."

---

## Pitch video (target: 1:30-2:00, hard limit 2:00)

**Opening (who you are):**
> "Hi, I'm Davi — a solo builder from Cascavel, Brazil. CurveForge is a focused cut of a larger token-launch bot I built and ran, with just the Meteora Dynamic Bonding Curve flow pulled out. I'm also building PowerDamm, a platform for Meteora DAMM v2 pools."

**The opportunity:**
> "Tokenized stocks on Solana are growing fast — Backpack's CEO has talked publicly about going from around 200 tickers toward 10,000, and Ondo lists over 450. But new tokens still mostly quote against SOL or USDC."

**What CurveForge does differently:**
> "CurveForge makes the stock itself the quote asset — the curve trades in AAPL, TSLA, or any of 331 verified presets. Every mint is checked on-chain, Meteora's token badge and the right Token-2022 extensions, never trusted from a registry alone."

**Why you specifically / proof of execution:**
> "I ran the whole lifecycle for real on mainnet — launch, completion, migration to DAMM v2, fee claiming — and fixed real bugs along the way. A later code review caught five more, including one that would have inverted prices on about half of migrated pools. There are automated tests, and the repo is MIT open-source."

**What's next:**
> "Next: a pay-to-use preset marketplace, the model Meteora suggested. It's already designed — Meteora's creator and partner fee split means no custom payment system is needed. And I'll keep growing the stock catalog."

**Close:**
> "That's CurveForge — real stock-quoted launches, built and proven on mainnet. Thanks for watching."

---

## Weekly update video (optional, ~1 minute — due Mon 10/05 12:00 Brasília)

Only your team, the judges and Colosseum can see it. Answers "What changed this week?".

> "Quick update on CurveForge. This week the stock catalog went from 157 to 331 verified quote assets across xStocks, Backpack and Ondo — every mint checked on-chain. I shipped DLMM Conviction Pools, so after a token migrates to DAMM v2 its creator can open a concentrated liquidity position from the Explore page.
>
> I also ran a full code review and fixed five real bugs — including one that would have shown inverted prices on about half of migrated pools — added the project's first automated tests, plus SEO and accessibility fixes, and the repo is now MIT-licensed.
>
> Next: recording the demo and pitch videos and submitting. Thanks!"

---

## Superteam Earn — "Best use of Meteora's DBC" submission texts (do NOT submit before the Colosseum project is submitted)

Form: `superteam.fun/earn/listing/meteora-dbc` → Submit Now. Required fields are marked `*`.

| Field | What to put |
|---|---|
| Link to Your Submission `*` | `https://curveforge.finance` (or the pitch video once it exists) |
| Tweet Link (optional) | a tweet about the submission, if you post one |
| Project Name `*` | `CurveForge` |
| Project Description `*` | see below |
| Project Github Link `*` | `https://github.com/alemaxxx/meteora-dbc-stocklana-hackathon` |
| Project Website | `https://curveforge.finance` |
| Project X Link | `https://x.com/CurveForge` |
| Pitch deck or Loom/video `*` | the pitch video link (a pitch deck link is also accepted) |
| Submitted to Colosseum? `*` | `Yes` — only once it's really submitted there |
| Link to Colosseum project | `https://colosseum.com/arena/projects/curveforge-1` |
| Link to Colosseum profile | copy it from your Colosseum avatar menu |
| Anything Else? | see below |

**Project Description:**
```
CurveForge is a token launchpad on Meteora's Dynamic Bonding Curve where the curve can be quoted directly against a real tokenized stock instead of SOL. It covers 331 verified quote assets across three issuers (xStocks, Backpack Securities, Ondo) - every mint individually checked on-chain (Meteora token badge + Token-2022 extension profile) - plus SOL and USDC curves. Launch, curve completion, migration to DAMM v2 and fee claiming have been run end to end on Solana mainnet. Also included: a pre-launch buy simulator, Pyth-anchored curves, DLMM Conviction Pools after migration, and a public CORS-open API for any DBC or DAMM v2 pool. Every action is wallet-signed: the connected wallet signs and owns each launch. Open-source (MIT) with automated tests.
```

**Anything Else?** (maps the project to the track's own "ideas we'd love to see"; honest about what is not built):
```
Live: https://curveforge.finance - Repo: https://github.com/alemaxxx/meteora-dbc-stocklana-hackathon
Mainnet proof: SOLBULL (mint 8z6M8QLJKPmRuJjg1Kzox4iCTCYgkzbD7GXyub2pWwT2) launched and migrated to the DAMM v2 pool 4tar3zNMmnBFwzQzM5JYr6LEXnB3qNbQ9PekGQ112H5m; the full lifecycle including fee claiming was run on mainnet.
Track ideas covered: stock-paired launches (xStocks, Backpack, Ondo), novel curve/fee configs (flat, exponential, long, compounding DAMM v2), end-to-end flows with DLMM Conviction Pools, developer tooling (public API). The DBC Config Preset Marketplace is designed (PRESET-MARKETPLACE-PLAN.md) but not built.
```

---

## Notes for recording day

- Record the pitch video first: it unlocks both the Colosseum submission and the Superteam Earn form. The demo video (≤3 min) is only required by Colosseum.
- A brand-new mainnet launch on camera is stronger proof than narrating an old one, but it costs real SOL from your wallet — optional, your call. SOLBULL (already migrated) is enough to show the full lifecycle.
- Don't say a Conviction Pool position was opened end to end — it hasn't been (see the honest framing in the demo script).
- Pyth-anchored TSLA/QQQ works with the current trial key (verified 2026-10-02, expires ~10/15) — fine for recording this weekend.
- The "Notes for judges" field already discloses AI-assisted development via Claude Code — the videos don't need to re-explain that, just focus on the product and the verification discipline.
- Check the clock: a 2:00 pitch is roughly 270-300 spoken words at a steady pace, so the ~235-word script (about 1:40) leaves a safety margin; the demo (≤3:00) roughly 380-420.
