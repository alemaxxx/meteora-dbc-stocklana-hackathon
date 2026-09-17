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
2. **Fixed `migrationFeeOption`** (`FixedBps100` = 1%) in two files
   (`dbcConfig.js` and `dbcMigration.js`) - if this ever becomes
   configurable per preset, both need to read from the same place (today
   it's a standalone constant in each file, deliberately simple for the
   first cut).
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

## 6. Suggested next steps

1. ~~Validate the curve presets against Meteora's official calculator~~
   **DONE on 2026-09-17** (see section 5.4) - `docs.meteora.ag`/
   `github.com/MeteoraAg` now reachable, `DBC_CURVE_PRESETS` adjusted.
2. ~~Test the whole flow (launch, buy/sell, migrate, withdraw fees) with
   small values~~ **PARTIALLY DONE on 2026-09-17** (see section 5.5) -
   launch + buy + read progress confirmed on real mainnet; migrate +
   withdraw fees still not executed for real (only code/IDL review).
3. Add validation that the initial buy (`firstBuySolUi`) doesn't exceed
   the chosen preset's `migrationQuoteThreshold`, with a clear error
   message - today it only fails with the raw simulation error (found in
   section 5.5, item 4).
4. Once a real production pool approaches its migration threshold (real
   buyers, not the team): closely watch the first real
   `migrateToDammV2`/`claimCreatorTradingFee` - still the part of the
   cycle never executed on-chain.
