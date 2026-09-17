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
   connected wallet** (Phantom - click "Connect Wallet" first), not the platform's. The curve
   already IS the liquidity: anyone can buy/sell as soon as the token exists, with no need for any
   initial buy from the creator (optional).
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
instead (see `PLANO-DBC-MIGRACAO.md` section 5.7): the server builds the transaction and only
partially signs it (it still has to co-sign the new token's own mint creation), then your wallet
completes the signature before anything gets sent. Migrating and claiming fees are unchanged -
those stay creator-only actions on the platform side (see section 5.7 for why that's fine, not a
leftover gap). Needs a Phantom-compatible wallet (`window.solana`) - **not yet tested with a real
wallet extension**, only the unsigned-transaction structure was verified.

## Pyth-anchored curve preset (2026-09-17)

On top of the two fixed-SOL presets, there's a third mode: pick a real stock (**TSLA** or **QQQ** -
see why only these two in `PLANO-DBC-MIGRACAO.md` section 5.6) and the curve's market-cap targets
get computed from that stock's **live Pyth price**, not a guessed SOL number - the whole point of a
tokenized-stock launchpad is price discovery grounded in something real. Needs a free `PYTH_API_KEY`
(see `.env.example`) - without it, the app still works fine with just the two fixed presets.
Confirmed live on mainnet: see section 5.6 of `PLANO-DBC-MIGRACAO.md`.

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
cp .env.example .env   # fill in RPC_URL and WALLET_PRIVATE_KEY
npm start
```

Opens at `http://localhost:3000`.

## Environment variables

Only two are required - see `.env.example`. No real value should ever go into Git. In production
(Railway), paste the values directly into the service's variables panel.

## What has already been tested for real on mainnet (2026-09-17)

With an isolated test wallet (not the production one): `createConfig`, `createPoolWithFirstBuy`
(with the already-corrected production preset) and reading curve progress - all confirmed
on-chain. Migration and fee withdrawal haven't been executed for real yet (only code/IDL review) -
see section 5.5 of `PLANO-DBC-MIGRACAO.md` for the full report, including two real protocol
findings: (1) the initial buy can't exceed the preset's migration threshold (the curve has no
liquidity beyond that point), and (2) curve progress isn't linear with the SOL deposited - very
low test thresholds (well below 1 SOL) aren't a good cheap proxy for the production presets.

## What's still left to validate

- **Migration and fee withdrawal** (`migrateToDammV2`/`claimCreatorTradingFee`/`claimPartnerTradingFee`)
  - never executed with a real transaction yet (see above).
- **Quote locked to SOL** - the presets define the threshold in units of the quote token itself,
  with no price conversion; supporting another quote (USDC, an xStock) would require calibrating
  the presets to each one's market value first.

See `PLANO-DBC-MIGRACAO.md` for the full history of decisions and findings (inherited from the
original project, with what's specific to this cut added at the top).
