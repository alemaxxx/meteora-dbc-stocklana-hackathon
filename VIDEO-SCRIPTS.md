# CurveForge — demo & pitch video scripts (draft)

Colosseum's Crypto World's Fair submission needs two separate videos:
- **Demo video** (≤3 min, required) — "Should show the live product, not a slide deck, not a code walkthrough."
- **Pitch video** (required, Public) — "introduce yourselves, tell us what you're building, and tell us why you're the people to build it."

Both scripts below are drafts to read from or adapt in your own words — not a transcript to recite verbatim. Timings are targets, not hard cuts.

---

## Demo video (target: 2:30-3:00)

**Screen: curveforge.finance home page**
> "This is CurveForge — a token launchpad on Solana's Meteora Dynamic Bonding Curve. Every token launches with instant liquidity, no presale, no team allocation. And you can quote it directly against a real tokenized stock — not just SOL."

**Screen: scroll to the ticker chips / click through to Launch**
> "157 stock-quoted presets, across three real issuers — xStocks, Backpack Securities, and Ondo — every single one individually verified on-chain before it's listed here."

**Screen: Launch page, open the "Live-priced (Pyth)" tab, select TSLA**
> "This one's anchored to Tesla's live price feed from Pyth — the migration target updates in real time as TSLA moves."
(Let the live price populate on screen — "TSLA @ $X, SOL @ $Y" — this is the proof it's real, not hardcoded.)

**Screen: scroll to "Simulated buys" panel**
> "Before anyone spends anything, you can see exactly what a small, medium, or large buy would actually cost — computed with the same math the on-chain program uses, not an estimate."

**Screen: Explore page, scroll to SOLBULL (migrated)**
> "This token launched, traded, and migrated to a permanent DAMM v2 pool — fully on mainnet, real transactions, no simulation." (Click "open on Meteora" to show the live pool.)

**Screen: the "My tokens" toggle (if a wallet is connected) and the Claim/Migrate buttons**
> "Creators manage their own tokens from here — track progress, migrate once the threshold hits, claim trading fees — every action is an explicit click, nothing automatic in the background."

**Screen: Docs page, the public API section (optionally curl it live)**
> "And the whole thing exposes a public, CORS-open API — anyone can read any Meteora DBC pool's live state, not just ones launched here."

**Close, back on Home:**
> "Real stock-quoted launches, verified on-chain, tested end-to-end on mainnet. That's CurveForge."

---

## Pitch video (target: 1:30-2:00)

**Opening (who you are):**
> "Hi, I'm Davi — I'm a solo builder from Cascavel, Brazil. CurveForge isn't my first Solana project — it's a focused cut of a larger Telegram bot I'd already built and run in production, with just the Meteora DBC launch flow pulled out into its own app for this hackathon."

**The opportunity:**
> "Tokenized real-world stocks on Solana are growing fast right now — Backpack Securities has publicly said they're scaling from around 200 tickers toward 10,000, and Ondo's own catalog already lists over 450. But no launchpad lets you quote a *new* token directly against one of those stocks — everyone still defaults to SOL or USDC."

**What CurveForge does differently:**
> "CurveForge makes the stock itself the quote asset. Not a rewards layer bolted onto a normal curve — the curve trades in AAPL, TSLA, or any of 157 verified presets directly. Every single mint is checked on-chain — Meteora's own token badge, the right Token-2022 extensions — never trusted from a registry alone."

**Why you specifically / proof of execution:**
> "I ran the entire lifecycle for real — launch, curve completion, migration to DAMM v2, fee claiming — with real transactions on mainnet, and I found and fixed a real bug doing it, not in a simulation. That discipline — verify everything on-chain, never assume — is how the whole project got built."

**What's next:**
> "Next is turning these presets into a real pay-to-use config marketplace — the model Meteora itself suggested — and keeping the stock catalog growing automatically as issuers add new tickers."

**Close:**
> "That's CurveForge — real stock-quoted launches, built and proven on mainnet. Thanks for watching."

---

## Notes for recording day

- Record the demo video FIRST against a fresh mainnet launch if possible (a brand-new token, not just SOLBULL/STKLAN again) — a live launch happening on-camera is stronger proof than narrating an old one.
- Keep the Pyth-anchored TSLA/QQQ demo ready as a fallback in case the trial key from the new account isn't live yet when you record.
- The "Notes for judges" field already discloses AI-assisted development via Claude Code — the pitch video doesn't need to re-explain that, just focus on the product and the verification discipline.
