> **Note on this cut (2026-09-16)**: this document was written in the context of the original
> [Lançar Token Bot](https://github.com/alemaxxx/lauch-token) (a larger bot, with StonkFun/pump.fun
> wave detection). This repository (`Meteora DBC Launchpad`) extracts only the DBC part described
> here, into a smaller, more focused app - this repo's README.md documents what changed in the
> extraction (no wave detection, manual form, no AI suggestion). The history of decisions and
> findings below (including the real "high tax" finding on GMGN) is the same, only the "how it's
> used" changes.

# Evaluation: Meteora DBC (Dynamic Bonding Curve) for the Lançar Token Bot

Written on 2026-09-15, on top of Meteora's announcement about the
**Stocklana** hackathon (tokenized stocks on Solana, $5,000 USDC for the best
use of DBC - see `hackathons.solana.com/hackathons/stocklana`). This bot
already targets exactly that audience (thematic quote SPYx/GPRO, see
`quoteThemes.js`), so this document evaluates swapping the third-party
bonding curve (StonkFun/pump.fun) for a NATIVE Meteora bonding curve.

## 1. Where we are today

"Lançar Token" has three paths (`launchMethod` in `tokenLauncher.js`):

| Method | Bonding curve | Final pool |
|---|---|---|
| `direct` | none - mints 100% of the supply to us | DAMM v2 "Infinite" (`poolCreator.js`) |
| `stonkfun` | Raydium LaunchLab, via StonkFun (SOL only) | DAMM v2 "Infinite" |
| `pumpfun` | pump.fun's program (`@pump-fun/pump-sdk`) | DAMM v2 "Infinite" |

The last two depend on third-party infrastructure for the bonding curve -
already the source of several "found live" bugs documented in
`PLANO-NOVO-BOT-LANCAR-TOKEN.md` (StonkFun's curve rule, `Transaction too
large` on pump.fun, RPC propagation between mint and buyback). The final
pool, in all three cases, is always DAMM v2 via `@meteora-ag/cp-amm-sdk`
(`createInfinitePool`).

## 2. What DBC changes

DBC is a bonding curve **from Meteora itself**, with automatic migration to
DAMM v2 built into the protocol. It replaces, in a single package, the
third-party bonding curve (StonkFun/pump.fun) AND the manual creation of
the DAMM v2 pool (`createInfinitePool`):

- **Launch** = mint the token + initialize the curve, in one transaction
  (SDK: `createPoolWithFirstBuy`, with an optional initial buy).
- **Trade** = anyone buys/sells directly on the curve - it IS the
  liquidity, we don't need to buy a quote token and pair it manually like
  today.
- **Migrate** = once the curve reaches the configured threshold, a real
  DAMM v2 pool is created automatically - anyone can trigger this
  (`migrateToDammV2`), it doesn't have to be us.
- **Withdraw fees** = since we're both "creator" AND "partner" (curve
  owner), we withdraw from both sides
  (`claimCreatorTradingFee`/`claimPartnerTradingFee`).

In other words: it eliminates the StonkFun/pump.fun dependency for whoever
launches via the curve, and the final pool is still Meteora (DAMM v2),
just created by the protocol itself instead of by us manually.

## 3. SDK - what was actually confirmed

`docs.meteora.ag` was **blocked by this environment's network proxy** -
everything below was confirmed by installing the real package
(`@meteora-ag/dynamic-bonding-curve-sdk@1.5.12`) in a separate directory
and reading the published `.d.ts`/IDL, not an AI-summarized page. Where it
mattered (e.g. `DAMM_V2_MIGRATION_FEE_ADDRESS`), I ran the real code to
confirm the value, not just the type.

```
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const client = DynamicBondingCurveClient.create(connection, "confirmed");
```

Four "services" on the client (equivalent to the `CpAmm` that
`poolCreator.js` already uses, just split by role):

- `client.partner` - owns the **config** (the curve's "recipe"): `createConfig`,
  `createConfigAndPool`, `claimPartnerTradingFee`, `partnerWithdrawSurplus`.
- `client.creator` - owns the **pool**: `createPool`, `createPoolWithFirstBuy`,
  `claimCreatorTradingFee`, `creatorWithdrawSurplus`.
- `client.pool` - trading: `swap`, `swap2`, `swapQuote`.
- `client.migration` - `migrateToDammV2`, `createLocker`, `withdrawLeftover`.
- `client.state` - read-only: `getPool`, `getPoolByBaseMint`,
  `getPoolQuoteTokenCurveProgress`, `getPoolFeeBreakdown`.

`buildCurve`/`buildCurveWithMarketCap` (a standalone function, not a client
method) does the curve's sqrtPrice/liquidity math - equivalent to the
`preparePoolCreationParams` that `poolCreator.js` already uses for DAMM v2,
just on the DBC side. Validated by running `buildCurve` for real (outside
this repo, no RPC) with the numbers from the preset below - the function
accepts and returns a 2-point curve with no validation error.

**Finding that avoids a real risk**: `migrateToDammV2` requires a
`dammConfig` (a DAMM v2 config account - a DIFFERENT program from the
"customizable" one `poolCreator.js` uses today, which needs no config at
all). I was afraid this would require finding that address by hand. It
doesn't: the SDK itself exports `DAMM_V2_MIGRATION_FEE_ADDRESS` (an array
of 7 public addresses, one per value of the `MigrationFeeOption` enum) - I
confirmed by running the code that the indices match the enum exactly.
`dbcMigration.js` uses
`DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100]` directly.

## 4. Current state (2026-09-15, second round) - WIRED UP, but BETA

The first round only had the standalone modules (`dbcConfig.js`/
`dbcLaunchpad.js`/`dbcMigration.js`), wired into nothing. This second round
wires everything end to end - you can launch via DBC right from the
screen - but it's still **never tested with real money** (see section 5).
None of the `direct`/`stonkfun`/`pumpfun` methods had their behavior
changed - only new branches added, always gated by
`launchMethod === "dbc"`/`isDbcLaunch`.

- **`src/connection.js`**: `export const dbcClient`.
- **`src/dbcConfig.js`**: curve presets (`DBC_CURVE_PRESETS`) +
  `getOrCreateDbcConfig(presetId, quoteMint)` (creates and caches in
  `data/dbc-configs.json`).
- **`src/dbcLaunchpad.js`**: `launchOnDbc(...)` - mints + starts the curve.
- **`src/dbcMigration.js`**: `getDbcCurveProgress`, `migrateDbcPoolIfReady`
  (now also computes and returns `newPoolAddress` - derives the new DAMM
  v2 pool's address via `deriveDammV2PoolAddress`, exported by the SDK
  itself; if the derivation fails for any reason, it does NOT report an
  error to the user - the migration itself already confirmed in the
  previous transaction, only the pretty address is missing) and
  `claimDbcFees`.
- **`src/tokenLauncher.js`**: `launchTokenFromCandidate` gained
  `launchMethod: "dbc"` - its own branch that skips buying a quote/
  manually creating a DAMM v2 pool (the curve is already liquidity) and
  calls `launchOnDbc` directly. Quote locked to SOL (same reason as
  StonkFun, except here it's because the curve presets don't convert
  price between quotes - see the comment in the code). New `export
  function markDbcPoolMigrated(id, newPoolAddress)` - updates the record
  after migrating.
- **`src/server.js`**: the launch route accepts `presetId`/`firstBuySolUi`
  and skips DAMM v2's fee/curve validation when `launchMethod === "dbc"`
  (tested - regression of the other three methods confirmed with no
  behavior change). New routes: `GET /api/hype/dbc-presets`, `GET
  .../:id/dbc-progress`, `POST .../:id/dbc-migrate`, `POST
  .../:id/dbc-claim-fees` - all MANUAL (click-triggered), never automatic.
- **`public/index.html`/`public/hype.js`**: "Meteora DBC (beta)" chip on
  the launch screen (curve preset + optional initial buy, instead of the
  DAMM v2 fee/curve fields that don't apply); visual BETA warnings +
  extra `window.confirm` before launching; in the Launched Tokens tab,
  `dbc` rows get "View progress"/"Migrate to DAMM v2"/"Withdraw DBC fees"
  buttons instead of the direct "open on Meteora" link (the pool, before
  migrating, isn't a DAMM v2 pool - separate Solscan link until it
  migrates).

### What was validated this round (no RPC/wallet - this environment doesn't have any)

- All modules (`dbcConfig.js`, `dbcLaunchpad.js`, `dbcMigration.js`,
  `tokenLauncher.js`, `server.js`) import without error with the real
  dependencies installed (`npm install` run, real
  `@meteora-ag/dynamic-bonding-curve-sdk@1.5.12`, not mocked).
- Clean `node --check` on every changed file (`.js`) and the server boots
  for real on a local port.
- All new HTTP routes tested via `curl` against the actually running
  server (correct 404 for a nonexistent token, presets return valid JSON,
  `launch` requires `presetId` for `dbc`).
- **Regression confirmed**: the three old methods (`direct`/`stonkfun`/
  `pumpfun`) still validate exactly the same as before (tested the same
  validation errors via `curl`, result identical to pre-DBC).
- Fixed during this check (found BEFORE any live test, by reading the
  SDK's real IDL): the `virtualPool` account returned by `getPool` comes
  wrapped in a `poolState` field (`pool.poolState.isMigrated`, not
  `pool.isMigrated` as the original draft had) - confirmed by comparing
  against the SDK's own internal usage (`getPoolMigrationQuoteThreshold`
  uses `pool.poolState.config`).
- IDs of every new element referenced in `hype.js` checked against the
  HTML (automated script, no orphans).

**What this does NOT prove**: no transaction was actually signed/sent.
`buildCurve`/`createConfig`/`createPoolWithFirstBuy`/`migrateToDammV2`
remain unconfirmed on devnet/mainnet.

## 5. Risks / what's needed before using real money

1. ~~**Curve numbers not validated**~~ **RESOLVED on 2026-09-17 (see section 5.4)** -
   `migrationQuoteThreshold` (formerly `migrationMarketCap`) was at 85 SOL
   (a pump.fun placeholder); confirmed against Meteora's official config
   (`meteora-invent/dbc_config.jsonc`) and corrected to 10 SOL in both
   presets. `totalTokenSupply`/`percentageSupplyOnMigration` already
   matched. The UI still shows the BETA warning + extra confirmation, out
   of general caution (not just for this specific item).
2. ~~Fixed `migrationFeeOption`~~ **RESOLVED on 2026-09-17 (see section 5.10)** - now configurable
   per preset via `dbcConfig.js`'s `getMigrationFeeOptionForPreset(presetId)`, read from the same
   place by both `dbcConfig.js` (at config-creation time) and `dbcMigration.js` (at migrate time) -
   forced by adding the "compounding-damm-v2" preset, the first to need anything other than
   `FixedBps100`.
3. **Nothing tested with a real transaction.** The rest of the bot has
   real bugs documented and fixed on top of tests with real money
   (`PLANO-NOVO-BOT-LANCAR-TOKEN.md`). This code matches the installed
   SDK's real signature and passed the smoke tests in section 4, but no
   transaction has been signed/sent (this environment has no RPC/wallet).
   **Test on devnet, with small values, before mainnet.**
4. **Migration/claim are manual, on purpose** - `dbc-migrate`/
   `dbc-claim-fees` only run on explicit click in the Launched Tokens tab,
   never in the background. This is a deliberate choice (caution over
   automatic coverage on untested code), not a limitation to fix - if
   automation is ever wanted, adding a job just means reusing
   `migrateDbcPoolIfReady` as-is.
5. **Quote locked to SOL** - see the comment in `tokenLauncher.js`.
   Supporting SPYx/others would require adjusting the presets to each
   quote's market value first.

## 5.1. Third round (2026-09-15, overnight) - visual polish + Playwright validation

The user went to sleep asking to "work toward perfection" and a
"beautiful frontend," with one clear rule: no real transaction until they
woke up (not even on devnet - tested it, this environment has no network
path to `api.devnet.solana.com` either, only `docs.meteora.ag` was
blocked before). Unable to test against a real chain, used the time to:

1. **`public/uiKit.js` (new)** - reusable toast + confirmation modal, same
   look as the rest of the app. Replaced ALL native `window.alert`/
   `window.confirm` calls that existed on the screen (the 4 I had just
   added for DBC, PLUS the 2 that already existed before - "large value,
   are you sure?" in `solAmountForSpyx`/`buybackSolUi`, found live on
   2026-09-12 - same text/behavior, only the look changed to match the
   rest of the app).
2. **Wallet balance at the top** (`GET /api/wallet/balance`, new) - uses
   `getWalletTokenBalance`, which already existed but had no route.
   Refreshes itself every 30s + right away after any action that spends/
   receives SOL (launch, any fee withdrawal).
3. **Actually tested in a browser** (Playwright + Chromium, installed just
   for this validation, at no cost) - not just `node --check`. This found
   a REAL bug that reading the code alone had missed: an unmigrated DBC
   row's "Pool" cell had 3 buttons running together on one line and
   getting cut off (inherited `white-space: nowrap` from the `<td>`) -
   fixed with a `.dbc-actions` class (flex column). Also swapped the ⚠
   emoji on the "Meteora DBC" pill for plain text ("· BETA") - an emoji
   can render as an empty box on a browser without a colored emoji font.
4. **Validated the whole flow on screen** (mocked candidate + mocked
   `fetch`, at no cost): open modal → switch to the DBC chip → the right
   fields appear/disappear → the BETA confirm shows up → the backend
   error (nonexistent candidate, expected in the mock) shows up correctly
   formatted. Made a real call to the backend (which tried and failed for
   lack of network - correct behavior, only the network doesn't exist
   here).
5. Also simulated launch records (`data/launched-tokens.json`, temporary,
   **deleted after the test** - never made it into Git, the `data/`
   folder is ignored) to see the Launched Tokens tab with a migrated DBC
   token, a non-migrated one, and one with an error - that's how the bug
   in item 3 showed up.

**Screenshots from this validation weren't committed** (they stayed only
in the session's scratchpad) - anyone can reproduce it from scratch by
following step 4/5 above.

## 5.2. Fourth round (2026-09-16) - first real launch + extended hackathon deadline

**Stocklana's deadline extended to 09-25, 4pm ET** (total pool went up to
$120k+, Meteora's track stays at $5,000 USDC) - gives more time to
validate calmly. Submission is through `hackathons.solana.com` itself
(self-service - registration, track and submission all there).

**First real DBC launch, in production**: NARWAVE, mint
`5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei`, on top of a real detected
candidate ("narrative" theme, 16 similar tokens). Confirmed that
`createPoolWithFirstBuy`, the supply (1B, matched the preset exactly) and
the rest of the config work end to end on mainnet.

**Real finding that turned into a fix**: ~2min after launch, GMGN showed
"⚠ Security check High tax rate now (9.83%)" - the "default-2h-linear"
preset's fee (10% starting, decaying) is high enough to trigger the
automatic "high tax" alert that trading terminals use as an anti-honeypot
heuristic. A terminal flagging it like that scares off real buyers, even
though the token is legitimate. Added a second preset,
**"baixa-taxa-2h-linear"** (3%→0.5%), validated with real `buildCurve`
(no error) - becomes the default selected on screen; the original preset
stays available (labeled with the warning), for anyone who wants to
compare the two launches side by side.

This also becomes pitch material for the hackathon - Meteora's own post
invites people to "reimagine tokenized stock launches with new curves,
fee models, quote assets, graduation mechanics, price discovery": this
cycle (launch → observe real behavior → adjust the fee model) is exactly
that, just based on real data, not theory.

## 5.3. Fifth round (2026-09-17) - second competition confirmed: Crypto World's Fair

A Meteora post on Discord (2026-09-17, 09:56) announced a second "Best Use
of Meteora DBC" track, this time inside Colosseum's **Crypto World's
Fair**, with a sidetrack via Superteam Earn
(`superteam.fun/earn/listing/meteora-dbc`). Confirmed in the browser
(X/Twitter + the Superteam Earn page + the Stocklana page) that these are
**two different events**, not a replacement:

| | Stocklana | Crypto World's Fair |
|---|---|---|
| Organizer | Solana Foundation | Colosseum (via Superteam Earn) |
| Meteora DBC track prize | $5,000 USDC (single prize) | $20,000 USDC (5 winners: $10k/$5k/$3k/$1.5k/$500) |
| Submission deadline | 2026-09-25, 4pm ET | ~2026-10-12 (25 days from 09-17) |
| Winners announced | by 2026-10-02 | by 2026-10-31 |

Stocklana's own page states: **"Taking it further after Stocklana?
Colosseum's World's Fair is the next stop"** (`colosseum.com/worldsfair`)
- confirms it's not competition, it's continuation. Strategy: submit to
Stocklana on time (09-25) and keep evolving the same code for Crypto
World's Fair before 10-12.

Crypto World's Fair's judging criteria (more detailed than Stocklana's):
depth of integration with the Meteora stack, technical execution,
originality (whether the use case survives the current "meme-stock
meta"), impact potential, and real mainnet traction/volume - reinforces
the principle already followed here of "working code on mainnet beats
slides." Ideas suggested by the brief itself worth considering:
non-linear curves (flat/exponential/long curve), flows combining DBC +
DAMM v2 + DLMM, and a "marketplace" of DBC config presets.

## 5.4. Sixth round (2026-09-17) - migration threshold fixed (85 SOL → 10 SOL)

With `docs.meteora.ag`/`github.com/MeteoraAg` reachable (blocked in
earlier rounds), actually validated the `migrationMarketCap` that section
5, item 1, already flagged as a risk. Compared `dbcConfig.js` against
Meteora's own official reference config
(`github.com/MeteoraAg/meteora-invent`, `studio/config/dbc_config.jsonc`,
`buildCurveMode: 0` - the same mode this project uses) and against the
"migration keepers" table at `docs.meteora.ag/developer-guides/dbc`:

- `totalTokenSupply` (1B) and `percentageSupplyOnMigration` (20%) matched
  the official example exactly - no change needed.
- `migrationMarketCap: 85` (SOL) was **8.5x above** the official reference
  value (`migrationQuoteThreshold: 10`) - confirms the old suspicion: "85
  SOL" really was just pump.fun's classic graduation number, never
  validated for DBC. The migration keepers table also lists **10 SOL** as
  the canonical threshold for SOL-quoted pools. Corrected to 10 in both
  presets.
- Secondary finding: the `initialMarketCap` field that existed in both
  presets was never read anywhere - `buildCurve` (the mode used here)
  only accepts `percentageSupplyOnMigration` and
  `migrationQuoteThreshold`; `initialMarketCap`/`migrationMarketCap` only
  exist in the `buildCurveWithMarketCap`/`buildCurveWithTwoSegments`/etc
  modes, which this project doesn't use. Dead field, removed. The
  `migrationMarketCap` field was also renamed to `migrationQuoteThreshold`
  (the SDK parameter's real name) - the old name was misleading, it
  suggested a market-cap conversion that never existed: the value was
  always a raw total of SOL accumulated in the curve.

**Practical effect**: with the threshold at 10 SOL (was 85), the curve
completes with much less real buying volume - easier to reach a real
migration within the hackathon's window, and more aligned with the
"Traction/Volume... prefer projects who have gone live on mainnet"
judging criterion cited in section 5.3.

**What this does NOT change**: `startingFeeBps`/`endingFeeBps` for both
presets (3%→0.5% and 10%→1%) stay the same - those came from a real live
finding (GMGN/NARWAVE), not a guess, and have no equivalent in Meteora's
generic reference config to compare against.

## 5.5. Seventh round (2026-09-17) - real end-to-end test on mainnet (partial)

Devnet was genuinely blocked at the time of testing: the public RPC
(`api.devnet.solana.com`) refused the airdrop (the IP's daily limit was
exhausted), `faucet.solana.com` itself explicitly asks AI agents not to
use the web form (points to CLI/PoW-faucet/local validator as
alternatives), and this machine had neither the Solana CLI nor Rust/cargo
installed to run a local validator with the DBC program cloned in. Given
that, the user sent 0.5 real SOL to a new test wallet
(`7cGPyHxdgMZiocrMKHXkJSaPi965Cb6wgnGmUJh4Cn1s`, generated just for this,
key only in this local environment's `.env`, never in Git) and the test
was done on **real mainnet, with a small amount**, following the same
cautious logic already used for NARWAVE. Run locally (`npm start` against
`http://localhost:3000`, never against the production Railway instance),
watched live by the user in the browser.

Before that, fixed a setup gap: the repo had neither `.gitignore` nor
`.env.example` (the README already referenced both) - both added.

**What was confirmed on-chain for real:**

1. **`createConfig`** - a new config created for the `baixa-taxa-2h-linear`
   preset (the production one, already with the corrected
   `migrationQuoteThreshold: 10`): `BoFmVZ24TCZQ6SZV3vYNDD6yzssUwT7GbUzJsXrKTPXw`.
2. **`createPoolWithFirstBuy`** - real launch "DBCTEST", 0.05 SOL initial
   buy: mint `4JJvXvCRuAuEhjg2okBqkTkBvQHGvx9Dw2RGCgSEwoxJ`, pool
   `Ey79FuyaJDjoAeAMM36uXKR345WPwAaJi4Hk75pfdXvg`. Confirms the corrected
   production preset works end to end on mainnet.
3. **`getPoolQuoteTokenCurveProgress`** (read) - reported 0.677% for
   DBCTEST (0.05 SOL bought against a 10 SOL threshold) - matches
   expectations.
4. **Real protocol finding**: tried a second initial buy of 0.2 SOL
   against a test preset (0.15 SOL threshold) - the transaction failed at
   SIMULATION (no SOL spent) with `AnchorError ... InsufficientLiquidity
   (0x1791)`: **the initial buy can't be larger than the preset's
   `migrationQuoteThreshold`** - the curve has no liquidity to sell beyond
   the migration point. This applies to the production presets too
   (buying >10 SOL at once at launch would fail the same way) - **the app
   doesn't validate this today**, becomes a new item in the "Risks"
   section below.
5. Fixed that value (0.1 SOL, below the test threshold) and the second
   launch ("DBCE2E") was confirmed: mint
   `3AvRwvoEtv5P4ZGD8siEC8tcmAHramJnmjC25w6ii5pY`, pool
   `yqkZqUEmsekYPuHfJWGZ6URWvpLZE5imhBoyRkHBFNU`.
6. **Real calibration finding**: curve progress is NOT linear with the SOL
   deposited, the way the documentation suggests ("Quote Reserve ≥
   Migration Quote Threshold"). With a configured threshold of 0.15 SOL:
   0.1 SOL bought → 21.2% progress (not ~67% as a simple linear ratio
   would suggest); +0.03 SOL → 29.4%; +0.1 SOL → 44.2%. In other words,
   the real EFFECTIVE threshold ended up much higher than the configured
   value - likely some curve overhead/minimum that weighs proportionally
   more on small thresholds. **Practical implication**: very low test
   thresholds (well below 1 SOL) aren't a good cheap proxy for validating
   the behavior of the production presets (10 SOL) - at that larger
   scale, the overhead should be proportionally negligible, but this
   wasn't confirmed for real (would require testing with the real 10
   SOL).
7. Validated incrementally via a TEMPORARY route/button
   (`POST /api/test/buy-more`, using `dbcClient.pool.swap` directly) -
   removed from the code after the test, not part of the final version.

**What was left unexecuted for real** (stopped by a deliberate decision,
not a bug): migration (`migrateToDammV2`) and fee withdrawal
(`claimCreatorTradingFee`/`claimPartnerTradingFee`). Completing the test
pool's migration would have required far more SOL than the configured
threshold suggested (item 6 above) - close to the test wallet's entire
balance, with no safety margin. Decision: stop before draining the
balance, since these two functions are much simpler instructions (without
the curve math that was the real point of doubt) and had already been
carefully checked against the SDK's real IDL in an earlier round (section
3 - including a data-structure bug, `pool.poolState.isMigrated`, found
and fixed purely by reading the code, before any live test). Production
migration, either way, is meant to happen when real buyers cross the 10
SOL threshold - it's not the team's job to fund that.

**Final state of the test wallet**: ~0.25 SOL remaining, plus the
DBCTEST/DBCE2E tokens bought on both curves (which can be sold back to
SOL via a reverse swap at any time, since the curve works as a normal AMM
in both directions) - nothing was "lost," it's just allocated as
liquidity/position in the two test curves.

**Secondary UI finding**: `window.prompt()` doesn't render inside the
embedded browser used for this test (Claude Browser pane) - the same
class of problem that had already motivated `uiKit.js`/`confirmDialog` to
replace `window.alert`/`window.confirm` before. It didn't end up as
permanent code (the feature that used it was removed during cleanup), but
it's recorded here in case a future feature needs text input in a modal -
use the `confirmDialog` pattern in `public/uiKit.js`, not `window.prompt`.

## 5.6. Eighth round (2026-09-17) - Pyth-anchored curve preset (new differentiator)

Motivation: competing against strong teams for the same $5k/$20k Meteora DBC tracks, both fixed
presets use an arbitrary SOL number for the migration threshold - no different, mechanically, from
any other memecoin bonding curve. Since this hackathon is specifically about **tokenized stocks**
(not memecoins), and the brief explicitly asks for "launch mechanics tuned for equity-like assets -
price discovery for thinly traded or newly tokenized stock pairs," added a third curve mode: anchor
the DBC curve's market-cap targets to a real stock's live price from **Pyth**, instead of a guessed
SOL number. New module: `src/pythPricing.js`.

**Real constraints found before building anything** (same "verify, don't assume" discipline as the
rest of this document):

1. Pyth's Hermes price-update API (`/v2/updates/price/latest`) now requires a Pyth Pro API key even
   for the most basic feeds (SOL/USD included) - this used to be a fully open, keyless endpoint.
   Confirmed empirically: the metadata endpoint (`/v2/price_feeds`, symbol search) works with no
   auth, but every price READ returned `unauthorized` without a `Bearer` token. Requires a free
   Pyth Terminal account (`pythdata.app`) + API key - user signed up and provided the key locally
   (`.env`, never committed).
2. The free trial plan only entitles a small allowlist of equity symbols. Tested ~25 large-cap
   tickers (AAPL, NVDA, MSFT, GOOGL, AMZN, SPY, META, GME, COIN, QQQ, IBM, DIS, NFLX, AMD, INTC, BA,
   JPM, V, WMT, KO, PLTR, HOOD, MSTR, CRCL, TSLA) against the real API with the key - only **TSLA**
   and **QQQ** returned real data; everything else came back `403 Not entitled` (real-world
   exchange data is licensed per symbol - not a bug). The xStock feed (`Crypto.AAPLX/USD`), despite
   being classified as "Crypto" not "Equity," is ALSO gated the same way under this trial.
3. The trial itself expires ~2026-10-01 - uncomfortably close to Stocklana's judging window (through
   2026-10-02) and well before Crypto World's Fair's deadline (~2026-10-12). Because of this, every
   Pyth-touching code path is designed to fail gracefully: `/api/pyth-presets` (the symbol list) is
   fully static, no Pyth call at all, so the UI always renders the option; only picking a symbol
   (preview) or launching with one actually calls Pyth, and both surface a clear error instead of
   crashing if the key/trial/symbol stops working.

**Design** (scoped to TSLA + QQQ given the above):

- `buildCurveWithMarketCap` (a DIFFERENT SDK curve-builder than the `buildCurve` the two fixed
  presets use) takes `initialMarketCap`/`migrationMarketCap` directly, in quote-token (SOL) terms -
  no `percentageSupplyOnMigration`/`migrationQuoteThreshold` needed for this mode.
- Formula: `pricePerShareSol = stockPriceUsd / solPriceUsd` (both fetched live from Pyth at launch
  time); `initialMarketCap = pricePerShareSol * 0.01` (the launched supply symbolically represents
  1% of one real share - a demo-scale calibration, disclosed as such); `migrationMarketCap =
  initialMarketCap * 50`. With live prices checked 2026-09-17 (TSLA ~$367, QQQ ~$717, SOL ~$101),
  this put migration thresholds at ~1.82 SOL (TSLA) and ~3.55 SOL (QQQ) - small and testable, while
  still genuinely derived from real market data rather than picked out of thin air.
- Same validated fee schedule as the "low-fee" preset (3%→0.5% over 2h) - reused, not reinvented.
- Config is **never cached/reused** for Pyth-anchored launches (unlike the two fixed presets) - a
  fresh config is created every time, on purpose, so the market caps always reflect the price at
  that exact moment rather than freezing whatever price happened to be live the first time a symbol
  was used.
- `src/tokenLauncher.js`'s initial-buy-vs-threshold validation (section 5.5, item 4) was generalized
  to cover both curve modes, not just the fixed presets - fetches the live threshold for validation
  even in Pyth mode.

**Confirmed live on mainnet (2026-09-17)**, same isolated test wallet as the rest of section 5.5:
launched "Tesla Anchored Test" (TSLAX) with the TSLA-anchored preset, 0.05 SOL initial buy - config
`CwhfetFiWLVYzY5bzsvXPUmFRCRETkkTxfoiWvSEBX35` (fresh, Pyth-anchored), mint
`DkbqjHBX2JjVm6qCCUXzYYHq4e4i2nZZvLfFZuwhfdBj`, pool `3z4M15EP1XPS4KybgmnGA5Pg5hGGMYb2x9PaRoePSx6L`.
Server logs confirm the config was built from the live-fetched TSLA/SOL prices, not a fixed number.

**Secondary UI finding**: `window.prompt()` (see section 5.5's UI finding) was never needed here -
the whole flow reuses the existing preset-chip UI, just with a second, dynamically-loaded chip
group and a live-fetched hint line instead of a static label.

## 5.7. Ninth round (2026-09-17) - wallet-connect for launching (security fix + real product gap)

The user asked a sharp question testing the demo: "this is a launchpad, shouldn't there be a wallet
connect option, since someone else will test it?" That surfaced two separate problems at once:

1. **A real security hole, not just a UX gap.** The app has zero authentication. Every action
   (launch/migrate/claim) was signed and PAID FOR by the server's own `WALLET_PRIVATE_KEY`. Since
   the Railway URL is public, **anyone who found it could click "Launch Token" and spend the
   platform wallet's real SOL** - no login, no confirmation tied to their own funds, nothing. Of
   the three actions, only launch was actually exploitable for real loss: migrate/claim already
   send their proceeds to addresses fixed inside the on-chain config (the platform wallet either
   way), so a stranger triggering them only wastes a trivial amount of their OWN gas to benefit the
   platform - not something worth re-architecting for right now.
2. **A real launchpad should let the person testing it pay from and own their own launch**, not
   just watch the operator's wallet do it. Judges reading the code should be able to picture (or
   try) launching with their own wallet, matching how pump.fun/any real launchpad works.

**Fix, scoped to launch only** (chosen over doing this for migrate/claim too, given the time left
before the hackathon deadline and that those two are legitimately creator-only actions - see point
1): split the single server-signed `/api/launch` into two phases, so the CONNECTING browser wallet
pays for and owns the new token instead of the platform wallet.

- `POST /api/launch/prepare` - uploads the image/metadata to Arweave (still platform-funded, a
  small shared infra cost, not part of this fix) and resolves/creates the DBC config (still
  platform/"partner"-owned and cached exactly as before - only pool ownership moves, not the
  curve's config), then builds the `createPoolWithFirstBuy` transaction with `payer`/`poolCreator`/
  `firstBuyParam.buyer` all set to the connecting wallet's pubkey. The server partially signs ONLY
  with the new mint's own required keypair (Solana requires a new account to co-sign its own
  creation) and returns the transaction, unsigned by the creator, as base64.
- The browser (`public/app.js`) loads `@solana/web3.js` from a CDN (`unpkg.com`, confirmed reachable
  before adding it - no bundler in this project, so a UMD build is the only option), deserializes
  the transaction, and asks the connected wallet (`window.solana.signTransaction`, Phantom-compatible
  provider - scoped to Phantom for v1, extensible later) to complete the missing signature.
- `POST /api/launch/submit` - takes the now fully-signed transaction back, sends and confirms it,
  resolves the pool address exactly like the old single-phase flow did, and updates the "pending"
  record `prepare` already saved into "success"/"error".
- This maps cleanly onto DBC's own partner/creator role split (see dbcConfig.js) - the config
  ("partner") stays with the platform, only the pool ("creator") and its payment move to whoever
  connects. `tokenLauncher.js`'s initial-buy-vs-threshold validation was preserved unchanged, just
  moved into the new `prepareTokenLaunch` phase.

**Verified without a live signature** (this environment's browser has no wallet extension - Phantom
etc. need a real browser to test the actual signing step): called `/api/launch/prepare` for real
against the running server and decoded the returned transaction with `@solana/web3.js` - confirmed
`feePayer` is the connecting wallet (not the platform one), and of the two required signatures, the
mint's is already present while the creator's is correctly still empty, waiting on the browser
wallet. **Still needs a real end-to-end test with an actual wallet extension** (Phantom, in a real
browser) - flagged as the next thing to verify live, not yet done as of this round.

## 5.8. Tenth round (2026-09-17) - real Phantom test + 3 fixes from live feedback

The user tested section 5.7's wallet-connect flow for real, in their own Chrome with Phantom
installed (this environment's browser still has no extension support). Results and fixes:

1. **It worked.** Phantom prompted for the account password, the connect button showed the
   connected address, and clicking Launch opened a real Phantom approval popup showing the SOL
   about to be spent - confirming feePayer really is the user's wallet, not the platform's. A real
   transaction was signed and confirmed (mint `4fZWmmPPsyhTyqFYFeCS36wEe5AzdMgu21cUsmrBZ9eX`
   confirmed on-chain for real).
2. **Real bug found**: after that confirmed transaction, the app still reported "couldn't find the
   pool yet" instead of success. Root cause: `waitForAccountVisible` only re-checked the MINT
   account's visibility before looking up the pool - the pool is a SEPARATE account, and its own
   RPC-replica propagation lag wasn't retried at all, just checked once. Fixed with a dedicated
   `waitForPoolByBaseMint` retry loop (10 attempts, 2s apart) around the pool lookup itself, not
   just the mint. Also swapped `connection.confirmTransaction(signature, "confirmed")` (the
   deprecated bare-signature overload, no defined expiry) for the `{signature, blockhash,
   lastValidBlockHeight}` strategy object - `prepareLaunchTransaction` now returns
   `blockhash`/`lastValidBlockHeight` alongside the transaction, `tokenLauncher.js` persists them on
   the pending record, and `confirmTokenLaunch` reads them back for `submitLaunchTransaction`.
3. **UI feedback acted on**:
   - Removed the "platform wallet" balance display entirely (`GET /api/wallet/balance` stays as a
     harmless, unused diagnostic route) - the user didn't see a reason for it to be on screen
     anymore now that launches don't touch that wallet.
   - Replaced the Phantom-only `window.solana` check with a proper **Wallet Standard** integration
     (new `public/walletConnect.js`, loaded as an ES module importing `@wallet-standard/app` from
     `esm.sh` - no bundler in this project, so a CDN ESM import is the only way in) - detects
     Phantom, Solflare, Backpack, and any other wallet implementing the standard, with a picker
     modal (`walletPickerDialog` in `uiKit.js`) when more than one is installed. Verified the
     "no wallet" fallback path renders correctly in this environment's extension-less browser;
     multi-wallet picking itself still needs a real test with 2+ extensions installed (not done -
     only one real wallet, Phantom, has been tested against so far).

## 5.9. Eleventh round (2026-09-17) - three new curve presets, scoped research continues

The user asked to keep digging for ideas, explicitly scoped to what the two hackathons actually
ask for - not generic launchpad features. Both briefs name **"novel curve or fee configurations"**
as an idea, and the Crypto World's Fair one spells out examples almost verbatim: *"Flat Curve,
Exponential Curve, or Long Curve."* Added all three as new presets, reusing the already-validated
10 SOL threshold and 1B supply/20% split - only the fee shape changes:

- `flat-1pct` - 1% fee, never decays.
- `exponencial-2h` - 5%→0.5% over 2h using `BaseFeeMode.FeeSchedulerExponential` (confirmed against
  the installed SDK's `.d.ts`: it takes the exact same `FeeSchedulerParams` shape as linear - only
  the enum value differs, no new fields needed).
- `long-24h-linear` - same 3%→0.5% range as the low-fee preset, stretched over 24h instead of 2h.

**Real finding while validating** (same "run it for real before trusting it" discipline as
elsewhere in this doc): tried the flat preset first with `startingFeeBps === endingFeeBps` over the
same nonzero 7200s duration used by the other presets - `buildCurve` rejected it with `"numberOfPeriod
and totalDuration must both be zero"`. A truly flat fee needs the scheduler duration set to exactly
zero, not just matching start/end values over some duration. Fixed and re-validated with real
`buildCurve` calls (no RPC needed) - all three new presets now build clean 2-segment curves, and a
regression check confirmed the original two still do too.

Not yet tested with a real transaction (only `buildCurve`'s own validation, offline) - same caution
tier as the two original presets before their first live launch.

## 5.10. Twelfth round (2026-09-17) - Compounding DAMM v2 preset, the last brief-literal idea

Same scoped-research pass as 5.9, going after the other explicit example from Crypto World's Fair's
"novel curve or fee configurations" idea: **"Compounding Liquidity DAMM v2 Pools."** DBC already
supports this - not at the curve level, but in what happens to the pool AFTER migration:
`migration.migratedPoolFee` with `collectFeeMode: MigratedCollectFeeMode.Compounding` makes the
migrated DAMM v2 pool automatically compound a share of its trading fees back into its own
liquidity instead of paying all of it straight out. Confirmed the exact shape against the
installed SDK's `.d.ts` (`MigratedPoolFeeConfig`) and validated a real `buildCurve` call offline
with it (no RPC, no cost) before adding anything - same discipline as every other preset here.

**New preset**: `compounding-damm-v2` - same 3%→0.5%/2h curve and 10 SOL threshold as the low-fee
preset, but `migrationFeeOption: MigrationFeeOption.Customizable` (6, not the usual FixedBps100)
plus `migratedPoolFee: { collectFeeMode: Compounding, dynamicFee: Enabled, poolFeeBps: 100,
compoundingFeeBps: 5000 }` - the migrated pool compounds 50% of its trading fees back into its own
liquidity.

**Real technical debt this forced fixing**: `Customizable` needs a DIFFERENT DAMM v2 config key at
migrate time than `FixedBps100` does (`DAMM_V2_MIGRATION_FEE_ADDRESS` is indexed by
`MigrationFeeOption`, and the value used at `migrateToDammV2` MUST match whatever `createConfig`
used originally, or migration would target the wrong DAMM v2 config). `dbcMigration.js` used to
hardcode a single `MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps100` module constant - exactly
the limitation flagged (but not yet acted on) back in section 5, item 2. Fixed properly:
`dbcConfig.js` now exports `getMigrationFeeOptionForPreset(presetId)` (looks up the preset's own
`migrationFeeOption`, defaulting to `FixedBps100` for the five presets and Pyth-anchored launches
that never set one - zero behavior change for anything that existed before this round);
`migrateDbcPoolIfReady(poolAddress, presetId)` now takes the preset id and uses that lookup instead
of the constant; `server.js`'s migrate route passes `record.presetId` through.

**Risk called out explicitly, including in the preset's own on-screen label**: this is the FIRST
preset to use anything other than `FixedBps100`, so migrating a pool launched with it exercises a
branch of `dbcMigration.js` that's never run even once - on top of `migrateDbcPoolIfReady`/
`claimDbcFees` already being untested live for every other preset too (section 5.5/5.8). Not
recommended as the first thing to test for real; the five other presets remain the better choice
until this one gets its own live migration test.

## 5.11. Thirteenth round (2026-09-17) - public developer API for any DBC pool

Last of this scoped-research pass's brief-literal ideas: **"Data Streams or Developer Tooling for
trading terminals and builders to easily plug-and-play when building a launchpad."** Added
`GET /api/dbc-pool/:address` (new `src/dbcPoolInfo.js`) - a read-only, CORS-open endpoint that
works for **any** Meteora DBC pool on-chain, not just ones this app launched. Accepts either a pool
address or a base mint (tries both), returns base/quote mint, migration status, live curve
progress, migration threshold, and unclaimed/lifetime fee metrics. No wallet, no auth needed - pure
public read, the same spirit as a block explorer's API. CORS is opened only for this one route
(`Access-Control-Allow-Origin: *`) - every other route in this app stays same-origin, meant only
for this app's own UI.

**Real finding while building it**: `dbcClient.state.getPool(address)` does NOT return `null` for
an address that exists but isn't a virtual pool account - it THROWS ("Invalid account
discriminator"), since Anchor's typed account fetcher rejects a discriminator mismatch as an error,
not a miss. The "try as a pool address, fall back to base mint" logic needed a `try/catch`, not an
`if (!pool)` check, around the first attempt. Confirmed the fix against a REAL production pool -
NARWAVE (`5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei`, launched 2026-09-16, see section 5.2) -
using its base mint, and separately using its pool address, both resolving correctly.

**Bonus confirmation from real on-chain data**: NARWAVE's on-chain `migrationQuoteThreshold` came
back as `"85000000000"` (85,000,000,000 lamports = exactly 85 SOL) - independent, on-chain
confirmation that NARWAVE really was launched with the old, unconfirmed 85 SOL threshold (section
5.4's finding) before the fix to 10 SOL landed the next day. The historical record and the live
chain data agree.

## 5.12. Submitted to Stocklana (2026-09-17)

Registered and submitted on `hackathons.solana.com/hackathons/stocklana`, competing in both
eligible tracks: **Best Use of Meteora DBC** ($5,000) and **Best use of Pyth market data** (3
months of Pyth Pro access) - the other three sponsor tracks (PreStocks, Tessera, Clawpump) each
require integrating that sponsor's own product specifically, which this project doesn't do, so
they were deliberately left unchecked rather than checking boxes it doesn't honestly qualify for.
Submission text mirrors the README/this document's own findings - see `Full Description` on the
submitted project page for the exact wording. Edits are allowed until submissions close
(2026-09-25, 4pm ET), so this isn't final - the plan is to keep improving the same submission
rather than treating it as done.

Next: register and submit the same project to Crypto World's Fair (Superteam Earn, deadline
~2026-10-12, see section 5.3) - not done yet, separate account/login needed there too.

## 5.13. Crypto World's Fair submission - started, paused on a real prerequisite (2026-09-17)

Created a Superteam Earn profile (`superteam.fun` → "Continue as Talent", skills: Blockchain,
Frontend, Backend; socials: GitHub/X/Discord linked) and opened the submission form for the
"Best use of Meteora's Dynamic Bonding Curve (DBC)" listing. **Found a real prerequisite before
finishing**: several required fields on that form - `Link to Colosseum project`, `Link to your
project's Colosseum profile`, and a yes/no question about a "Frontier Hackathon on Colosseum" -
strongly imply the project needs to be registered and submitted on **Colosseum's own platform**
(`colosseum.com`, the "Crypto World's Fair" hackathon itself, submissions due 2026-10-12, $840,000
total prize pool across the whole hackathon) BEFORE this Superteam Earn side-track form can be
completed honestly. The form also requires a pitch/Loom video link, which doesn't exist yet.
("Frontier Hackathon" itself doesn't appear anywhere on `colosseum.com`'s Crypto World's Fair page
- likely either a stock question Superteam Earn asks for every Colosseum-linked side track, or the
name of an earlier Colosseum season; answer "No" when resuming unless it turns out to mean this
same event.)

**Decision**: closed the submission modal without submitting rather than filling required fields
with placeholders (the form itself warns that non-compliant submissions can restrict future ones).
Nothing was lost - the Superteam Earn profile is created and ready; the form itself wasn't
submitted.

**To resume this later**:
1. Register on `colosseum.com` for Crypto World's Fair (separate account/login, not yet done).
2. Submit this same project there - get the "Colosseum project" link and "Colosseum profile" link
   the Superteam Earn form asks for.
3. Record a short pitch/demo video (Loom or similar) - also a required field.
4. Come back to `superteam.fun/earn/listing/meteora-dbc`, click Submit Now, and fill the form with
   all of the above plus the same project name/description/GitHub/website used for Stocklana.

## 5.14. Fourteenth round (2026-09-20) - real end-to-end migration test, live bug found and fixed

With a fresh top-up (0.3 SOL) to the same isolated test wallet, ran the full lifecycle for real on
mainnet, for the first time ever: launch → curve completes → migrate to DAMM v2 → claim fees. This
was the single biggest gap called out in the Stocklana submission ("migration and fee withdrawal
... not yet exercised by a completed real migration") and in section 5.10 (`compounding-damm-v2`,
"untested live, higher risk than the other presets").

**Method**: added a temporary preset (`test-migration-verify`, since removed) - same fee shape as
`compounding-damm-v2` (the riskiest untested path: the only preset using
`MigrationFeeOption.Customizable` + `migratedPoolFee`) but with `migrationQuoteThreshold: 0.05`
instead of 10, cheap enough to actually complete with the test budget.

**Real finding #1 - buying can approach but never exactly complete a curve via a single ordinary
swap.** The existing first-buy validation (`tokenLauncher.js`, see section on the 85→10 SOL fix)
already blocks a buy that reaches or exceeds the threshold - confirmed here from the other side
too: repeated manual top-up buys asymptotically approached the threshold (58% → 87% → 97% → 99.4%
→ 99.58% → 99.65%, each with a smaller SOL amount) but a plain exact-in `swap` reverted with
`InsufficientLiquidity` (0x1791) the instant the remaining "dust" was smaller than the amount sent,
with no reliable way to know that exact remaining amount in advance (same non-linear-progress
finding as section 5.5, now confirmed from the completion side, not just the early side). Fixed (for
this test only, via a temporary `dbcClient.pool.swap2` call) by using `SwapMode.PartialFill` instead
of a plain exact-in swap - it fills whatever the curve has left instead of reverting, which is
exactly the right tool for "buy enough to finish the curve" without guessing the dust amount. This
buy-side scaffolding (`src/dbcBuy.js`, a `/api/buy/prepare`+`/api/buy/submit` pair, and a "[TEST
ONLY] Buy on curve" panel) was removed after the test - it was never in either hackathon brief's
scope, and shipping it days before the deadline with only a placeholder slippage guard
(`minimumAmountOut: 1`) would have been a real risk for real users. Worth reconsidering later as a
proper feature (in-app buying without needing an external DEX) - just not under deadline pressure.

**Real finding #2, more important - a genuine production bug, now fixed.** Once migrated,
clicking "Claim fees" failed with `Invalid account discriminator`. Root cause: `markDbcPoolMigrated`
(`tokenLauncher.js`) overwrites the launched-token record's `poolAddress` field with the new DAMM v2
pool's address after migration (correct for the UI's "open on Meteora" link) - but the claim-fees
route (`server.js`) was reading that SAME field and handing it to `claimDbcFees`
(`dbcMigration.js`), which needs the **original DBC curve account**, not the DAMM v2 pool. Anchor
correctly rejected trying to deserialize a DAMM v2 pool account as a DBC virtual pool. **This would
have broken fee withdrawal for every real creator on this platform after their first migration**,
not just this test - the highest-value bug this session could have found. Fixed by adding a
`dbcPoolAddress` field (set once at launch, in `confirmTokenLaunch`, never touched again) and having
the claim-fees route read `record.dbcPoolAddress ?? record.poolAddress` instead of `poolAddress`
directly - the fallback keeps old already-launched records working (none of them had completed a
real migration yet, so `poolAddress` was still correct for them regardless).

**Confirmed live, in order, on mainnet**: `createConfig` (Customizable/compounding),
`createPoolWithFirstBuy`, `getPoolQuoteTokenCurveProgress`, `migrateToDammV2` (mint
`FqpMp7pnwn6G2A2ZamcBP7PZeXBG5BnSvFEhTWLB6YN7`, new DAMM v2 pool
`5StwyKYZNv5YZTmyn3fZY79hpy6WMSb42yzo1A6FrQvU`), `claimCreatorTradingFee` +
`claimPartnerTradingFee` (after the fix above). Also independently confirmed by a third-party DAMM
v2 pool monitor picking up the migrated pool with the correct fee rate (1%) and compounding
percentage (50%) - external validation that the `migratedPoolFee` config was built correctly, not
just internally self-consistent.

## 6. Suggested next steps

1. ~~Validate the curve presets against Meteora's official calculator~~
   **DONE on 2026-09-17** (see section 5.4) - `docs.meteora.ag`/
   `github.com/MeteoraAg` now reachable, `DBC_CURVE_PRESETS` adjusted.
2. ~~Test the whole flow (launch, buy/sell, migrate, withdraw fees) with
   small values~~ **PARTIALLY DONE on 2026-09-17** (see section 5.5) -
   launch + buy + read progress confirmed on real mainnet; migrate +
   withdraw fees still not executed for real (only code/IDL review).
3. ~~Add validation that the initial buy (`firstBuySolUi`) doesn't exceed
   the chosen preset's `migrationQuoteThreshold`~~ **DONE on 2026-09-17**
   (see `tokenLauncher.js`) - now rejects with a clear message before any
   network call when `firstBuySolUi >= migrationQuoteThreshold`. Verified
   via `curl` against the real server: 10 SOL against the 10 SOL
   production threshold is rejected instantly (no cost); 5 SOL passes the
   check and reaches the real on-chain simulation (failed only for lack of
   balance in the test wallet, as expected).
4. Once a real production pool approaches its migration threshold (real
   buyers, not the team): closely watch the first real
   `migrateToDammV2`/`claimCreatorTradingFee` - still the part of the
   cycle never executed on-chain.
5. ~~Test the new wallet-connect launch flow (section 5.7) end to end with a real wallet
   extension~~ **DONE on 2026-09-17 for Phantom** (see section 5.8) - real signature, real
   confirmed transaction. Still needs a test with a SECOND wallet installed (Solflare/Backpack) to
   confirm the picker modal actually works, not just the single-wallet path.
6. **Researched, not built: DLMM "Conviction Pools"** - the one remaining idea from the Crypto
   World's Fair brief ("creative end-to-end launch flows using DBC, DAMM v2 and DLMM... Conviction
   Pools with DLMM"). Confirmed `@meteora-ag/dlmm@1.9.14` exists on npm and is compatible with this
   project's stack (same `@solana/web3.js`/`@coral-xyz/anchor` major versions). "Conviction Pool"
   isn't a term with a findable, formal Meteora definition (checked `docs.meteora.ag`'s DLMM
   section) - it reads as illustrative brief language, not a pre-built feature, meaning it's open
   to interpretation rather than something to integrate against a spec. Deliberately NOT
   implemented blind: unlike the five ideas built this round (each had one clear, literal reading
   straight from the brief), this one has several plausible directions - e.g. seeding a DLMM pool
   with concentrated liquidity around the DBC migration price once a pool graduates, or letting
   long-term holders lock graduated tokens into a DLMM position as a public signal of conviction -
   and picking one is a product decision, not a technical one, better made with the user's input
   than guessed at alone. Biggest remaining differentiator if there's time before either deadline.
7. Test a real `migrateDbcPoolIfReady` for the `compounding-damm-v2` preset (section 5.10) once a
   pool launched with it reaches its threshold - the riskiest untested code path added this round.
8. Multi-wallet picker (section 5.8/5.9) still only tested with one real wallet (Phantom) -
   confirm the picker modal itself with a second extension (Solflare/Backpack) installed.
