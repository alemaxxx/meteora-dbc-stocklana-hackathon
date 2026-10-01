# DBC Config Preset Marketplace — architecture proposal

Not built. This is a research/architecture document for the "Business Plan" judging
criterion (Colosseum's weakest-covered factor for this project per competitive research),
written after finding that Meteora's own DBC protocol already does most of the hard work.

## The idea, as Meteora's own hackathon brief suggests it

> "DBC Config Preset Marketplace - Popular launchpad configs that builders can easily pay-to-use"

A competitor (`zkasuran/barkbork`) already shipped a version of this. A different one
(`alamuoyeemmanuel7-create/aequus`) attempted it with a hacky "scan recent transactions for a
memo" payment mechanism that was never even run. Neither is a reason to skip this - it's a
reason to build it *correctly*, using the mechanism Meteora already built for exactly this.

## The key finding: no custom payment system is needed at all

DBC's on-chain config account already has a **creator vs. partner fee split** baked into the
protocol itself (confirmed in `docs.meteora.ag/protocol/protocol-revenues` and in this
project's own code). Every config has a `creatorTradingFeePercentage` field - whatever isn't
the creator's share goes to the config's **partner** address automatically, enforced by the
DBC program on every single trade, with no off-chain bookkeeping.

CurveForge already sets this to 100% (`src/dbcConfig.js:453`, `creatorTradingFeePercentage: 100`)
because today it has no third-party partner - every preset's "partner" is the platform itself.
**A preset marketplace is, architecturally, just: let someone else's wallet be the partner.**

## What already exists that this would reuse, unmodified

1. **`getOrCreateDbcConfig(presetId, quoteMint)`** (`src/dbcConfig.js`) already creates one
   on-chain DBC config per (preset, quote) pair, cached in Postgres
   (`dbc_configs` table). A "community preset" is the same shape of record, just with a
   `creatorTradingFeePercentage` below 100 and a `partner` field pointing at the publisher's
   wallet instead of the platform's.
2. **The client-signs claim pattern already exists and is already proven**, including a real
   bug Meteora's signer constraint once caused and that this project already found and fixed
   (`src/dbcMigration.js:126-163`, `prepareClaimCreatorFeeTransaction` /
   `submitClaimCreatorFeeTransaction`): build an unsigned transaction server-side, the actual
   fee recipient's own wallet signs it client-side, the server just relays the signed
   transaction. `claimPartnerTradingFee` (used today only for the platform's own 100% share,
   `src/dbcMigration.js:110-124`) is the exact same call shape as `claimCreatorTradingFee` -
   the same signer-constraint pattern this project already debugged once almost certainly
   applies here too, so this isn't unknown territory.
3. **The preset-browsing UI is already fully generic over `DBC_CURVE_PRESETS`** (confirmed
   again tonight, adding the USDC preset required zero new rendering logic) - a "Community"
   tab is just another `group` value.

## What's actually new (the real scope)

1. **A `preset_publishers` or similar table**: publisher wallet, display name (optional),
   the preset's parameters (fee schedule, migration threshold, quote asset), and the resulting
   on-chain config address once created.
2. **A publish flow**: a form where a connected wallet defines a preset's parameters and signs
   a (new) transaction that creates the on-chain config with THEM as partner - same
   "build unsigned, wallet signs, submit" pattern as every other wallet-facing action in this
   app, applied to `dbcClient.partner.createConfig` (or whatever the exact method name is -
   not yet looked up) instead of the existing server-signed config creation.
3. **A `prepareClaimPartnerFeeTransaction`/`submitClaimPartnerFeeTransaction` pair**, mirroring
   the creator-fee one almost line for line, but calling `dbcClient.partner.claimPartnerTradingFee`
   with the publisher's own wallet as `feeClaimer`/`payer` instead of the platform wallet.
4. **Attribution + a leaderboard**: show "by @handle" on community presets, maybe a simple
   "top earning presets" list - good for the pitch, not technically required for the mechanism
   to work.
5. **Moderation/abuse surface to think through before shipping**: a malicious publisher could
   set an absurd fee schedule (e.g. 50% starting fee) to extract value from unsuspecting
   launchers - needs either a sane max-fee clamp (DBC's own program likely already bounds this,
   worth checking the `MAX_FEE_BPS` constants already seen in the CP-AMM SDK's exports during
   tonight's research) or a review/flagging step before a published preset appears publicly.

## Why this wasn't built tonight

Creating a third-party-owned on-chain config and paying out real trading fees to a stranger's
wallet is genuinely new financial-transaction surface (config creation with a non-platform
partner has never been exercised in this codebase) - exactly the kind of money-handling code
this session's own discipline says shouldn't be shipped without devnet testing, even though
the *pattern* it would reuse is already proven. The honest scope estimate: a few hours of real
work (mostly plumbing, since steps 2-3 above closely mirror already-written code), plus real
testing before trusting it with a stranger's funds - a good candidate for the next working
session, not a 3am addition.

## How this helps the pitch regardless of whether it ships

Even as an architecture doc, this directly answers Colosseum's "Business Plan" criterion
("Is there a viable business that can be built in the future around this Submission?") with a
concrete, protocol-native mechanism instead of a vague idea - and it's honest: CurveForge's
existing stock-quoted presets (AAPLx/TSLAx/NVDAx/SPYx/etc., already built and tested) are a
natural seed catalog of "premium" configs once this exists.
