# Meteora DBC Launchpad

Submission for the **Meteora** track of two hackathons, with the same code:

1. **Stocklana** (`hackathons.solana.com/hackathons/stocklana`) - "Best Use of Meteora DBC" track,
   $5,000 USDC, deadline **2026-09-25, 4pm ET** (extended).
2. **Crypto World's Fair** (Colosseum, via Superteam Earn - `superteam.fun/earn/listing/meteora-dbc`) -
   "Best use of Meteora DBC" track, $20,000 USDC across 5 winners ($10k/$5k/$3k/$1.5k/$500), deadline
   **~2026-10-12** (winners announced by 2026-10-31).

Stocklana's own page points to Crypto World's Fair as the natural continuation ("Taking it
further after Stocklana? Colosseum's World's Fair is the next stop") - they aren't competing with
each other, so it's possible to submit to Stocklana first and keep evolving the same project for
Crypto World's Fair afterward.

Extracted from the [Lançar Token Bot](https://github.com/alemaxxx/lauch-token) - a larger bot that
detects hype waves on StonkFun/pump.fun and launches tokens on top of them. This project here is
just the **Meteora DBC** (Dynamic Bonding Curve) part, without the wave detection: a direct
form - name, symbol, image, curve preset - and the rest is automatic until the curve is ready to
migrate.

## What it does

1. **Launches a token on the curve** (official SDK's `createPoolWithFirstBuy`) - mints the token
   and initializes the bonding curve in a single transaction, **paid for and owned by your
   connected wallet** (click "Connect Wallet" first - Phantom, Solflare, Backpack, any Wallet
   Standard wallet), not the platform's. The curve already IS the liquidity: anyone can buy/sell as
   soon as the token exists, with no need for any initial buy from the creator (optional).
2. **Tracks the curve's progress** - how far it is from reaching the chosen preset's migration
   threshold.
3. **Migrates to a real DAMM v2 pool**, on explicit click, once the curve completes - never
   automatic.
4. **Withdraws accumulated trading fees** (creator + partner - the configured wallet is both
   parties).

None of this happens on its own: every action (launch, migrate, withdraw) requires a click +
explicit confirmation. No volume generator, no wave detection, no AI name/image suggestion - just
the DBC flow.

## Wallet-connect for launching (2026-09-17)

Launching used to be entirely server-signed (the platform's own wallet paid for every launch) -
since the app has no login, that meant anyone with the URL could spend the operator's real SOL just
by clicking "Launch Token". Now the connecting browser wallet pays for and owns the new token
instead (see `DBC-MIGRATION-PLAN.md` section 5.7): the server builds the transaction and only
partially signs it (it still has to co-sign the new token's own mint creation), then your wallet
completes the signature before anything gets sent. Migrating and claiming fees are unchanged -
those stay creator-only actions on the platform side (see section 5.7 for why that's fine, not a
leftover gap). Works with any **Wallet Standard** wallet (Phantom, Solflare, Backpack, ...) - picks
automatically if only one is installed, shows a picker if there's more than one. **Confirmed live
with Phantom** (section 5.8): real approval popup, real confirmed transaction. That round also
fixed a real bug the live test surfaced (the pool lookup right after confirming needed its own
retry loop, not just the mint's) and dropped the unused platform-wallet balance display per
feedback.

## Curves quoted directly in a real tokenized stock (2026-09-22)

Four more presets (`stock-quoted-aaplx/tslax/nvdax/spyx`) trade the new token directly against a
**real xStock** (AAPLx, TSLAx, NVDAx, SPYx - Backed Finance, Token-2022) instead of SOL - the
curve's quote *is* a real, tradeable share of Apple/Tesla/NVIDIA/the S&P 500, migrating once 0.1
real units of that stock accumulate. This goes further than the Pyth-anchored mode below, which
only uses a stock's price to size a SOL threshold - here there's no conversion at all, since 1 unit
of quote already equals 1 real share by the mint's own design.

Real constraint worth disclosing: creating a DBC "token badge" (required for a Token-2022 mint like
these) is Meteora-controlled, not something a partner can do - confirmed by reading the SDK's real
exported methods (no create-badge call exposed, only read-only ones). This only works because
Meteora has already badged these four specific mints - confirmed with a live on-chain read
(`getTokenBadge`), not from any announcement (an unsourced claim about this exists in the wild and
couldn't be traced to a primary source - the on-chain read is what actually settled it). See
section 5.17 of `DBC-MIGRATION-PLAN.md` for the full writeup, including two real bugs this surfaced
(a hardcoded-decimals assumption and a hardcoded-SOL-quote assumption, both from before any quote
other than SOL existed) and an honest incident report (a real transaction fired during local testing
that shouldn't have).

**Second stock issuer added (2026-09-26): Backpack Securities.** 59 presets now quote directly
against real Backpack Securities-issued stock tokens (SpaceX, Micron, Moderna, Nike, Boeing, Costco,
Intel, Shopify, and many more - see `STOCK_QUOTE_MINTS` in `src/dbcConfig.js`) - a SEPARATE, competing
tokenized-stock issuer from Backed Finance's xStocks above (different mints, different legal
structure: direct 1:1 redeemable security entitlement instead of a cash-settled tracker). Backpack's
own CEO has publicly stated a plan to expand from its current ~41-200 tokenized stocks to ~10,000.
Every one of the 59 mints was individually verified on-chain (not assumed from a list) - all came back
badged, all Token-2022 with the identical extension set (permanentDelegate, inactive transferHook,
pausableConfig, scaledUiAmountConfig) - so the same DAMM v2 migration compatibility reasoning already
proven for xStocks applies. Real mint addresses sourced from the community-maintained
[usestrak/strak](https://github.com/usestrak/strak) registry, cross-checked against addresses already
independently verified via web search before trusting the rest. Still not exhaustive - see section
5.21/5.22 of `DBC-MIGRATION-PLAN.md`.

**Preset picker UI (2026-09-26)**: with the catalog now this large, the "Curve preset" field renders
one dropdown PER category (fee-shape curves, xStocks, Backpack Securities, live-priced) instead of one
long list - picking an option in any dropdown resets the others, and each dropdown's options are
sorted alphabetically.

## Six curve presets, plus one live-priced mode (2026-09-17)

- `baixa-taxa-2h-linear` (default) and `default-2h-linear` - the two original presets (see the real
  finding below).
- `flat-1pct`, `exponencial-2h`, `long-24h-linear` - three more fee shapes added straight from the
  hackathon briefs' own "novel curve or fee configurations" ask ("Flat Curve, Exponential Curve, or
  Long Curve" is close to verbatim from the Crypto World's Fair brief) - see section 5.9 of
  `DBC-MIGRATION-PLAN.md`.
- `compounding-damm-v2` - the OTHER example from that same brief line, "Compounding Liquidity DAMM
  v2 Pools": the migrated pool compounds 50% of its trading fees back into its own liquidity
  instead of paying it all out. It's the only preset using a `migrationFeeOption` other than
  `FixedBps100`, so migrating a pool launched with it exercises its own dedicated code path -
  **confirmed live on 2026-09-20** (this exact fee shape's full lifecycle - launch, migrate,
  claim - was the one used for the real end-to-end migration test, see section 5.14).
- **Pyth-anchored mode** - pick a real stock (**TSLA** or **QQQ** - see why only these two in
  section 5.6) and the curve's market-cap targets get computed from that stock's **live Pyth
  price**, not a guessed SOL number. Needs a free `PYTH_API_KEY` (see `.env.example`) - without it,
  the app still works fine with just the six fixed presets. Confirmed live on mainnet: section 5.6.

## Public developer API (2026-09-17)

`GET /api/dbc-pool/:address` - read-only, CORS-open, works for **any** Meteora DBC pool on-chain
(pool address or base mint, tries both), not just ones this app launched. Returns mint, migration
status, live curve progress, migration threshold, and fee metrics - the "Data Streams or Developer
Tooling for trading terminals and builders" idea from the Crypto World's Fair brief. See section
5.11 of `DBC-MIGRATION-PLAN.md`, including a real bug found and fixed while building it (verified
against NARWAVE, a real production pool).

## Real finding (2026-09-16)

The first test launch (mint `5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei`, done on the original
Lançar Token Bot before this cut existed) used a 10% starting fee - and ~2 minutes later GMGN (a
trading terminal) flagged the token with "Security check — High tax rate now (9.83%)": a fee high
enough to trigger the anti-honeypot heuristic that terminal scanners use, scaring off real buyers
even though the token is legitimate. Hence the two presets in `src/dbcConfig.js`:

| Preset | Fee (starting → ending, 2h) | Note |
|---|---|---|
| `baixa-taxa-2h-linear` (default) | 3% → 0.5% | below the threshold that usually triggers the alert |
| `default-2h-linear` | 10% → 1% | triggered "high tax" on GMGN - kept for comparison |

## Running locally

```bash
npm install
cp .env.example .env   # fill in RPC_URL, WALLET_PRIVATE_KEY and DATABASE_URL
npm start
```

Needs a Postgres database (see `DATABASE_URL` below) - a throwaway local one works fine, e.g.
`docker run -d -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=dbc_launchpad -p 5433:5432
postgres:16-alpine`. The schema is created automatically on startup (`ensureSchema()` in
`src/db.js`) - no manual migration step needed for a fresh database.

Opens at `http://localhost:3000`.

## Environment variables

Three are required - see `.env.example`. No real value should ever go into Git. In production
(Railway), paste the values directly into the service's variables panel; `DATABASE_URL` is injected
automatically once the Postgres plugin is added there.

## Database (2026-09-21)

Launched-token and DBC-config records live in Postgres now, not in flat JSON files - see
`src/db.js` and section 5.16 of `DBC-MIGRATION-PLAN.md` for why (a real race condition in the old
read-whole/write-whole file pattern, and a hard ceiling on running more than one app instance).
`scripts/migrate-json-to-db.js` is a one-time, safely re-runnable script for carrying over data
from the old `data/*.json` files into a fresh database.

## What has already been tested for real on mainnet (2026-09-20)

With an isolated test wallet (not the production one), the **entire lifecycle end-to-end**:
`createConfig`, `createPoolWithFirstBuy`, curve progress, `migrateToDammV2`, and
`claimCreatorTradingFee`/`claimPartnerTradingFee` - all confirmed on-chain, using the same
`Customizable`/compounding fee shape as the riskiest preset (`compounding-damm-v2`). See section
5.14 of `DBC-MIGRATION-PLAN.md` for the full report, including a real bug this test found and
fixed: after migration, claiming fees read the wrong pool address (the new DAMM v2 pool instead of
the original DBC curve) and failed for every migrated pool, not just this test one - now fixed by
tracking the original curve address in a separate field that migration never overwrites. Also
independently confirmed by a third-party DAMM v2 pool monitor picking up the migrated pool with the
correct 1% fee rate and 50% compounding percentage. Earlier real findings (section 5.5) still
apply: the initial buy can't exceed the preset's migration threshold, and curve progress isn't
linear with the SOL deposited.

## Pre-launch security review (2026-09-20)

Audited every tracked file plus the full git history for exposed secrets before pointing anyone at
the live URL - clean (`.env` was never committed, no private-key-shaped strings, no API keys, no
credentials in RPC URLs anywhere in history). Three real, non-secret findings, all fixed - see
section 5.15 of `DBC-MIGRATION-PLAN.md` for the full report:

1. **Stored XSS** - the launched-tokens table rendered `name`/`symbol` (public form input, no
   character restrictions) as raw HTML; fixed with escaping + a server-side length cap.
2. **Creator fee claim was broken for every real user** - the DBC program requires the actual
   on-chain creator to sign their own claim; the old server-signed claim only ever worked for
   pools the platform wallet itself launched. Fixed by making creator fee claiming
   wallet-connected (same two-phase pattern as launching), while partner fee claiming stays
   server-signed (that one really does always belong to the platform).
3. **No rate limiting** - a few routes cost the platform wallet real SOL even with no wallet
   connected at all (`launch/prepare`'s Arweave upload, `migrate`, `claim-partner-fee`); added a
   small in-memory per-IP limiter.

## Life after the hackathon: a real business plan, not just a demo (2026-09-22)

Meteora's own Crypto World's Fair brief suggests, as one of its "ideas we'd love to see," a **"DBC
Config Preset Marketplace - popular launchpad configs that builders can easily pay-to-use."** This
project already has nine real, tested presets across three families - fee-shape (`baixa-taxa-2h-linear`,
`default-2h-linear`, `flat-1pct`, `exponencial-2h`, `long-24h-linear`), migration-behavior
(`compounding-damm-v2`), and quote-asset (`stock-quoted-aaplx/tslax/nvdax/spyx`) - a working seed for
exactly that marketplace, not a hypothetical: a competing attempt at this same idea
(`aequus`) admits its own "pay-to-use" mechanism is an untested hackathon stub, never even run. The
path from here to a real marketplace is short: charge per-launch for premium presets, keep the basics
free. Separately, Meteora has stated that "select qualified teams... building innovative AI or RWA
use cases with Meteora DBC" during this period may be eligible for discretionary infrastructure
grants - a named funding path beyond the prize itself.

## What's still left to validate

- **Multi-wallet picker** - **confirmed live (2026-09-22)** with three real Wallet Standard wallets
  installed at once (Phantom, Solflare, and Jupiter's own wallet) - the "Choose a wallet" modal
  rendered all three correctly, each with its real icon, and selecting Solflare triggered its real
  connection approval popup. One thing to watch, not confirmed as a real bug: clicking "Connect
  Wallet" immediately after the page loads (before `walletConnect.js`'s module script finishes
  registering the click handler) appeared to do nothing, silently - no error, no toast. Worth a
  second look if time allows, but not reproduced carefully enough yet to call it confirmed.
- **Quote locked to SOL** - the presets define the threshold in units of the quote token itself,
  with no price conversion; supporting another quote (USDC, an xStock) would require calibrating
  the presets to each one's market value first. Meteora's own 2026-09-20 announcement ("DBC
  supports any token pair on Solana") confirms the protocol already allows this - our own config
  layer (`dbcConfig.js`) already threads `quoteMint` through generically too, so the real gap is
  just the UI/hardcoded-SOL spots in `tokenLauncher.js`, not the SDK.
- **DLMM "Conviction Pools"** - researched, not built (section 6, item 6) - the one remaining brief
  idea from Crypto World's Fair, left for a deliberate product decision rather than a guess.

See `DBC-MIGRATION-PLAN.md` for the full history of decisions and findings (inherited from the
original project, with what's specific to this cut added at the top).
