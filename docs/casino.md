# Casino

A play-money sportsbook on its own tab. Teams earn money by taking part in the
league and bet it on real NFL lines and on WCXC matchups. Nothing is bought and
nothing is cashed out.

## Earning

| What | Pays | Rule |
|---|---|---|
| Complete ballot (all 12 ranked) | $50 | Once per team per week, cast inside that week's voting window |
| Complete pick 'em slate (all 6 matchups) | $50 | Same |

The voting window is Tue 12:00 AM to Thu 8:00 PM ET. The payment is a database
trigger on `ballots` and `picks`, so it doesn't depend on the page.

- **Resubmitting never pays twice.** Rewards are keyed `(kind, season:week:voter)` in a
  unique ledger.
- **Backfills pay nothing.** The ballot and picks RPCs accept any week on purpose, so
  the commissioner can backfill. The trigger pays only when the week matches the
  window's own week, computed exactly as `pollWeekFor()` computes it.

Bankrolls never reset.

**The launch week.** The casino opened part-way through week 5's window, after three
teams had already voted. The setup script includes a catch-up that pays anything cast
before the trigger existed, under the trigger's exact rules: complete, inside its own
week's window, and no earlier than `casino_rules.rewards_since` (Tue Oct 6, 12:00 AM ET).
It doesn't back-pay weeks 1–4. To back-pay the whole season instead, set
`rewards_since` to `'2026-09-08'` and re-run the setup.

## Where the odds come from

DraftKings' own API (`sportsbook-nash.draftkings.com`) sits behind Akamai and refuses
scripted requests, even from a home connection. ESPN's public API carries DraftKings'
lines (provider id `100`) and answers anyone:

| Feed | URL | Gives |
|---|---|---|
| Scoreboard | `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=N&seasontype=2&dates=YYYY` | Moneyline, spread and total with prices; live status; scores; possession |
| Props | `sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}/competitions/{id}/odds/100/propBets?limit=1000` | ~800 DraftKings props per game: **the line but no price** |
| Rosters | `site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}/roster` | ESPN athlete ids, used to match props to Sleeper players |

**Pricing:**
- **Game lines** use DraftKings' own prices.
- **Player props** are plain over/unders only (passing, rushing and receiving yards,
  receptions, completions, attempts, passing TDs, interceptions, combined yards). Each
  side is offered at a flat house price of **−115**, because the feed has no price for
  them. The page says so.
- **Milestones, anytime TD and first scorer** are not offered: they have no price, and
  can't be priced fairly from a line alone.

**Matching props to players.** Props settle from Sleeper's weekly stats, so each needs
a Sleeper id. `scripts/picks/build.mjs` writes `espn.json` daily (ESPN athlete id →
Sleeper id, name, team):
- Sleeper's own `espn_id` is used where it exists, but it is blank for most players
  who arrived after about 2021.
- Everyone else is matched from ESPN's team rosters on normalised name **within the
  same NFL team**. Two fantasy-relevant players sharing a name on one roster is
  vanishingly rare, and when it happens the player is skipped, never guessed.
- Measured on week 5: **256 of 257** prop athletes matched. The one miss was a fullback.

**WCXC matchups** offer a moneyline and a total. Both come from the Pick 'em model,
ported into `supabase/functions/_shared/casino.mjs` as `fantasyPairs()`; a test holds
it to the page's `loadLines()` to 1e-12.
- **Moneylines** are the model's win probability plus a 4.5% hold, so a coin flip is
  about −110 a side.
- **Totals are calibrated.** Sleeper's projections run about 25% high in this league:
  it projects roughly one first down per ten receiving yards, about double reality, and
  first downs score here. Over weeks 1–4 teams were projected 198.0 and scored 158.6, and
  every one of 24 uncalibrated totals went under. The sync measures actual ÷ projected
  over the last 8 finished weeks (0.80, steady week to week), stores it as
  `casino_rules.fantasy_scale`, refreshes it daily, and scales the projections before
  pricing. Testing each week against the other three gave 10 overs and 14 unders. The
  scale moves only the level, so moneylines are unaffected. Half points mean a total
  never pushes.
- **No spreads.** Projected margins overstate the real gap between teams. Even after
  fitting that, underdogs covered 16 of 24 when each week was tested against the others,
  so there's too little history to price a spread fairly. Revisit once more weeks are in.
- Everything WCXC locks at the week's first NFL kickoff.

## How it fits together

```
pg_cron (every minute) ─▶ casino-sync edge function (service role)
                              │  ESPN scoreboard (this week + next)
                              │  ESPN props (≤4 games a run, each every 10 min)
                              │  Sleeper matchups/projections (every 10 min, pregame)
                              ▼
                         casino_lines ──▶ page reads ──▶ bet slip ──▶ place_bet() RPC
                              │                                         │ re-reads every price
                              ▼                                         ▼
               outcomes → leg results → settlement            bets, bet_legs, casino_ledger
```

**The browser writes nothing directly.** `place_bet()` is the only write it can make:
- It checks the team password.
- It takes an advisory lock per team, so two tabs can't spend the same dollar.
- It re-reads every price from `casino_lines`. A price sent by the page is only
  compared, so a doctored request can at worst be refused.
- It applies every rule below and debits the stake in the same transaction.

**Everything else is the edge function**, with the service role: lines, outcomes,
grading, the live-bet delay and settlement. Its logic lives in
`supabase/functions/_shared/` (`casino.mjs`, `sync.mjs`) as pure functions with I/O
passed in, so Node tests drive the exact code that runs. The Deno file `index.ts` only
connects fetch and supabase-js to it.

**Every movement of money is a ledger row**, unique on `(kind, ref)`: reward, stake,
payout, refund or commissioner adjustment. A balance is a sum, so the audit trail is
complete, and nothing can be applied twice even if two syncs overlap.

## The rules (all in `casino_rules`, tunable without a deploy)

| Risk | Rule |
|---|---|
| Overdraft | Stake ≤ balance, under a per-team lock |
| Runaway bankrolls (never reset) | $100 max straight, $25 max parlay, **$1,000 max payout per ticket**, 10 open tickets |
| Fake or stale prices | Price and point re-read server-side. A mismatch is refused as "odds changed". Pregame lines must be < 30 min old. Nothing after kickoff. |
| Betting a touchdown before the line moves | Live bets wait out a 45s delay (below) |
| Correlated parlays | 2–6 legs, **one leg per game** (no same-game parlays), combined odds capped at +2000 |
| Grinding heavy favourites | No price shorter than −500 or longer than +1000 |
| Tanking | **No betting against your own fantasy team**: no opponent moneyline or spread, no under on your own game. Backing yourself is fine. |

Settlement:
- A push refunds the stake.
- A prop voids if the player didn't play (Sleeper `gp`).
- In a parlay, a losing leg loses the ticket as soon as it's known. Pushed and voided
  legs drop out and the rest is repriced, with the cap applied again.
- `casino_settle()` caps every payout at stake × price and `max_payout`, whatever the
  caller asks for.

## Live betting — off until verified

`live_enabled` defaults to **false**, so every market closes at kickoff. The scoreboard
feed is known to carry pregame DraftKings lines. **Whether ESPN keeps updating them
during a game has not been observed yet.** Watch the first Thursday night game:

```sql
select id, price, point, score, status, updated_at from casino_lines
where sport = 'nfl' and state = 'in' order by updated_at desc limit 20;
```

If prices change during the game, switch it on:

```sql
update public.casino_rules set live_enabled = true where id = 1;
```

How the protection works once it's on:
- A line is **suspended** whenever the score or possession changes and the price
  hasn't. That's the moment someone watching could pick it off.
- A live bet goes in as **pending**. The next sync at least 45s later accepts it only
  if the line refreshed after the bet, is still open, shows the same score and
  possession, and its price moved ≤ 5%. Anything else is refused and refunded in full.
- If ESPN turns out to freeze odds in-game, lines simply stay suspended after the
  first score. Nothing becomes exploitable.

## Setting it up (one time)

1. **Database.** Supabase → SQL Editor → run all of
   [`supabase-setup.sql`](../supabase-setup.sql). It is safe to re-run (tested), and it
   adds the casino tables, triggers and RPCs alongside the existing ones.
2. **Edge function.** Nothing to install: `npx` fetches the Supabase CLI on demand. Run
   these from this folder (the one containing `supabase/functions/casino-sync`), one
   line at a time:
   ```
   npx supabase@latest login
   npx supabase@latest functions deploy casino-sync --use-api --no-verify-jwt --project-ref qwgwaedeuihvneirbplb
   npx supabase@latest secrets set CRON_SECRET=<long random string> --project-ref qwgwaedeuihvneirbplb
   ```
   - `--use-api` builds the function on Supabase's servers. Without it, the CLI tries
     Docker first, warns that Docker is not running, then does the same thing anyway.
   - `--no-verify-jwt` matters: pg_cron sends only the `x-cron-secret` header, so a
     function that demanded a JWT would reject every scheduled run.
   - No `supabase/config.toml` is needed. The CLI reads one only if it exists, and an
     invalid one would fail the deploy.
   - For a random secret: `powershell -c "[guid]::NewGuid().ToString('N')"`.
   - Don't install the CLI with `npm install` inside another project. And never run
     `npm audit fix --force` on an Expo app: it swaps the framework for incompatible
     major versions.
3. **Schedule.** Put the same secret into [`supabase/casino-cron.sql`](../supabase/casino-cron.sql)
   in place of the placeholder, and run it in the SQL Editor. Within a minute,
   `casino_rules.synced_at` starts moving and lines appear on the tab.
4. **Site.** Push `index.html` and `espn.json`. The edge function reads
   `https://wcxcdynasty.site/espn.json` and `positions.json`, and the odds workflow
   keeps `espn.json` fresh every morning.

Until step 1 is done, the tab shows "The casino isn't switched on yet" and nothing
else breaks.

**Troubleshooting:**

```sql
select * from cron.job_run_details where jobname = 'casino-sync' order by start_time desc limit 10;
select status_code, content from net._http_response order by created desc limit 5;
```

The function returns a JSON report: lines written, props games refreshed, fantasy
lines, outcomes, legs graded, bets resolved and settled.

## Commissioner tools

```sql
-- give or take money (always through the ledger)
insert into public.casino_ledger (voter, amount, kind, ref) values (8, 25, 'adjust', 'makegood-2026-10-12');
-- void a bet that can't be graded (postponed game etc.) — refunds the stake
select public.casino_settle(123, 'void', (select stake from public.bets where id = 123));
-- tighten a limit
update public.casino_rules set max_payout = 500 where id = 1;
```

## Tests

```
node --test tests/casino.test.mjs tests/casino-sync.test.mjs tests/casino-ui.test.mjs tests/casino-sql.test.mjs
```

`casino-sql.test.mjs` runs the real `supabase-setup.sql` in PGlite (Postgres in
WebAssembly) and exercises the money rules for real: rewards, every refusal path,
settlement, refunds, the self-bet rule and re-running the setup. PGlite isn't a site
dependency, so point `PGLITE` at an install to run those tests; without it they
skip and only the static contract checks run:

```
npm i --prefix /tmp/pg @electric-sql/pglite
PGLITE=/tmp/pg/node_modules/@electric-sql/pglite node --test tests/casino-sql.test.mjs
```
