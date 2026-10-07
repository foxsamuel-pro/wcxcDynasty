# Casino

A play-money sportsbook on its own tab. Teams earn money by taking part in the
league and bet it on real NFL and college football lines and props, on season-long
futures (the WCXC title and playoffs, the Super Bowl and NFL playoffs), and on WCXC
matchups. Nothing is bought and nothing is cashed out.

## Earning

| What | Pays | Rule |
|---|---|---|
| Complete ballot (all 12 ranked) | $100 | Once per team per week, cast inside that week's voting window |

The voting window is Tue 12:00 AM to Thu 8:00 PM ET. The payment is a database
trigger on `ballots`, so it doesn't depend on the page. (Pick 'em, which paid the other $50, was removed; its old
$50 payouts for week 5 were folded into the $100 ballot reward.)

- **Resubmitting never pays twice.** Rewards are keyed `(kind, season:week:voter)` in a
  unique ledger.
- **Backfills pay nothing.** The ballot RPC accepts any week on purpose, so
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
| FanDuel games | `sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=…` | FanDuel's NFL games, matched to ESPN's by team names and kickoff (within 6h) |
| FanDuel props | `sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=…&eventId={id}&tab={tab}` | Tabs `td-scorer-props`, `passing-props`, `receiving-props`, `rushing-props`: every prop **with real prices** |
| Scoring plays | `site.api.espn.com/…/summary?event={id}`, then `sports.core.api.espn.com/…/plays/{playId}` | The order of touchdowns, and each scorer's ESPN athlete id, for first and last TD |

FanDuel's API is the one its own website reads. The app key `_ak` is in every page FanDuel
serves, and the API is cached on CloudFront and answers plain requests with no browser
fingerprinting, unlike DraftKings'.

**Pricing:**
- **Game lines** use DraftKings' own prices.
- **Player props come from FanDuel at FanDuel's prices** whenever FanDuel has posted the
  game. That covers over/unders, milestone ladders ("50+ yards", "5+ receptions") and
  touchdown scorers: anytime, 2+, 3+, 4+, first and last. First TD appears when FanDuel
  posts it, usually closer to kickoff.
- **Fallback:** a game FanDuel hasn't posted yet, or any game if FanDuel can't be reached,
  gets DraftKings' over/under lines through ESPN at a flat house **−115** each way. The
  drawer says which source a game is using, and the next refresh switches to FanDuel as
  soon as it posts.
- FanDuel players are matched to Sleeper by normalised name **within the two teams
  playing**, through `espn.json` (`playerIndex`/`findPlayer`). The same name twice on
  one team means the player is skipped. Ids carry the Sleeper id:
  `prop:<event>:s<sleeper>:<market>:<over|under|ms50|yes>`.
- A milestone is stored as an over at k − 0.5 with its own price. An over/under is only
  offered when both sides are present.

**Matching props to players.** Props settle from Sleeper's weekly stats, so each needs
a Sleeper id. `scripts/players/build.mjs` writes `espn.json` daily (ESPN athlete id →
Sleeper id, name, team):
- Sleeper's own `espn_id` is used where it exists, but it is blank for most players
  who arrived after about 2021.
- Everyone else is matched from ESPN's team rosters on normalised name **within the
  same NFL team**. Two fantasy-relevant players sharing a name on one roster is
  vanishingly rare, and when it happens the player is skipped, never guessed.
- Measured on week 5: **256 of 257** prop athletes matched. The one miss was a fullback.

**WCXC matchups** offer a moneyline and a total. Both come from the newspaper's projection
model, in `supabase/functions/_shared/casino.mjs` as `fantasyPairs()`; a test holds it to
the newspaper's scoring and position spreads.
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

## College football

**Lines.** ESPN's FBS scoreboard (`…/college-football/scoreboard?groups=80&limit=300`)
carries DraftKings' lines exactly as the NFL one does, so every FBS game gets a
moneyline, spread and total at DraftKings' prices: 57 of 58 games in Week 6 of 2026.
`gameLines(e, { sport: 'cfb' })` builds them; ids are `cfb:<espn event>:<market>:<side>`.
- A side is named by **school** ("Alabama") and carries **ESPN's team id** in
  `nfl_team` instead of an abbreviation: college abbreviations collide (there are two
  OSUs), and the page finds a team's logo, colours and ranking by that id.
- The scoreboard is a megabyte on a Saturday, so it is read **every two minutes**, or
  every minute while a college game somebody holds a bet on is being played.
- A college game is pregame only, like everything but a live NFL line, and **closes at
  its kickoff even if ESPN still says "pre"** (a late start): the sync never reopens a
  line past its kickoff.
- **No same-game parlays on a college game**: none is simulated, so two legs from one
  college game are refused ("Same-game parlays are NFL only"). A college game is a leg
  like any other in an ordinary parlay.

**Props.** FanDuel posts props for the bigger college games, a day or two out (18 of
108 games in Week 6), under its own market names: `PLAYER_{HIGH|MEDIUM|LOW}_[ALT_]<stat>_CFB`
and `ANY_TIME_TOUCHDOWN_SCORER_CFB`. `fdCfbPropLines` reads passing and rushing yards,
passing TDs, receiving yards, receptions, their milestone ladders, and anytime TD.
- FanDuel's college games are matched to ESPN's by school and kickoff (`fdMatchCfb`).
  Both schools agreeing is a match; some never agree ("App State"/"Appalachian State",
  "UConn"/"Connecticut", "Sam Houston"/"Sam Houston State"), so one school on its own side
  at the same kickoff is enough when no other game at that time qualifies. All 58
  matched.
- Sleeper knows no college players, so a college prop is keyed by **ESPN's athlete id**
  and settled from ESPN's box score. `scripts/cfb/build.mjs` writes `cfb-players.json`
  daily: every roster on this week's and next week's slate, skill positions only,
  normalised name → `[athlete id, jersey]` (a name two players share is `0` and skipped).
  The sync finds a FanDuel name there **within the player's own team**, which FanDuel's
  runner says through its jersey image (`…/ncaaf/georgia_jersey.png`, `fdRunnerTeam`).
- ESPN's college rosters miss players FanDuel prices: in Week 6 Georgia's roster had no
  Gunner Stockton, its starting quarterback. A player not on the roster is keyed **by
  name within his team** instead (`player: 'n-gunner-stockton'`, no jersey number) and
  found by name in the box score after the game (`cfbStatsFor`). Not found there, or two
  players of that name: the bet voids. It can refund; it can't pay the wrong player.
- Ids: `cprop:<espn event>:a<athlete id>:<market>:<side>`, or `…:n-<name>:…`.
- Refreshed every 15 minutes per game, four games a run (each is four tab reads), so a
  Saturday's forty-odd prop games stay inside `place_bet`'s 30-minute staleness limit.
  `casino_rules.cprops_synced` (event → `{at, n}`) also tells the page which games have
  props: most college games never get any, and those show no props button.

**Settlement** reads ESPN's summary (`…/college-football/summary?event=<id>`) once a
run per game: the final score for the lines, and the box score for props, in the same
stat keys a Sleeper stat line uses (`cfbBox`), so one grading rule serves both. ESPN
lists only players who recorded something, so **a player it doesn't list is treated as
not having played** and his bet voids. Anytime TD counts rushing, receiving and return
touchdowns plus a defensive score once (ESPN can list it in two columns); a quarterback's
passing touchdowns are his receivers'. Props wait four hours after kickoff, as the NFL's
do. While a game is on, the same box score feeds a college prop's bar on a ticket.

**`cfb.json`**, also built daily, is for the page: every team on an FBS scoreboard this
season (abbreviation, school, full name, colours, conference), this week's AP Top 25 and
the conferences' names. About 17 KB, loaded when College is first opened. A college
jersey is drawn in **ESPN's own team colours** (primary body, alternate trim): there are
too many schools to hand-pick home jerseys for, as `CS_JERSEY` does for the NFL.

## Futures

Season-long markets, **single bets only** (a future settles months after anything it
could be parlayed with). Two kinds of line: a race with one winner, whose `side` is the
team, and a yes/no on one team (one event per team). They settle as `{winner}` or
`{made}`.

**WCXC: the champion, each division, and every team to make or miss the playoffs**,
priced from the league's own forecast, `odds.json` (10,000 simulated seasons; see
[`playoff-odds.md`](playoff-odds.md)):
- A side's price is its chance plus half `casino_rules.future_hold` (5%), the same
  arithmetic as a WCXC matchup's moneyline. That half-hold also keeps a long shot
  honest, since 10,000 seasons can't tell 1 in 5,000 from 1 in 50,000: nothing pays better
  than about +3900. A side under 5 seasons in 10,000 isn't listed, and nor is a
  near-certainty (past 98% with the hold on there's no price that isn't a gift).
- **Only from model 3 or later.** Model 2 read Sleeper's *projected* mid-season bracket
  as the real one, which inflated some teams' title and final chances (Ripple Effect
  showed 49% to win it all in Week 5); `wcxcFutureLines` refuses an older file.
- **Open from the forecast's morning rebuild until the week's first kickoff**: Tuesday
  morning (the rebuild that follows a week's last game, which knows every result) to
  Thursday night. Every line's `commence_at` is that kickoff, so it closes then like a
  game line. A forecast that is stale (older than 8 days, another season or league) or
  past the regular season prices nothing; **no WCXC future is sold during the playoffs**.
  `casino_rules.fut_status.wcxc` tells the page which (`games`, `stale`, `season`).
- Divisions are named as the league names them (Sleeper's `division_1`…`division_3`).
- **Your own team** (`block_self_bets`): you can't take it to miss the playoffs, and while
  it is still listed in a race with one winner (the title, its division) it is the only
  team you can back in that race, since backing anyone else is betting your team won't
  win it. Once your team drops off that board (out of the running), the rest open up.
  `place_bet` enforces it; the page greys those prices out and says why.
- **Settlement** (`wcxcSettlement`) waits until Sleeper has scored the last regular-season
  week (`last_scored_leg`) and every roster's record holds every result. Then the six
  teams in Sleeper's winners bracket must be the six the standings make (three division
  winners, the top two on byes, three wildcards; win %, then points for, then the higher
  points against: `wcxcField`, held by a test to the forecast's own `seedField`), and the
  two byes the two best division winners. **If anything disagrees, nothing settles**, and
  the sync's report says why (`futures.settle`). The champion is the winner of the
  bracket's place-1 game once the final week is scored. Checked against the real 2025
  season: the field, the byes, the division winners and the champion all match Sleeper's
  record. Sleeper serves a *projected* bracket all season, which is why the scoring check
  comes first.

**NFL: the Super Bowl winner, and every team to make or miss the playoffs**, at
FanDuel's prices, read from the FanDuel NFL page the sync already reads for its list of
games (`SUPER_BOWL_WINNER_SGP`, `MAKE_PLAYOFFS_{AFC|NFC}_SGP`, `MISS_PLAYOFFS_{AFC|NFC}_SGP`).
- **Closed while any NFL game is being played.** Each line's `commence_at` is the next
  kickoff, so it shuts then; once every game under way is over, the next run re-reads
  FanDuel's new prices and reopens them. Refreshed every ten minutes while open.
- **Regular season only**: the sync doesn't follow playoff kickoffs, so it couldn't close
  the market for them.
- A team's playoff bet settles the moment **ESPN's standings** mark it clinched (x, y, z,
  \*) or eliminated (e), as at a book. The Super Bowl settles once ESPN's postseason
  week 5 is final.

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

                         casino_games ──▶ the scoreboard on a ticket (display only)
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

## What a ticket shows

A ticket is drawn the way a sportsbook draws one: what the bet is and what it pays, each
leg with its own result, and underneath the legs the game that leg is riding on — the
clock, the down and distance, who has the ball, and the score quarter by quarter. A
player prop also draws a bar towards the line it was taken at, so a leg needing twenty
more yards says so instead of just sitting there as "open". A single bet's second line
names the game or matchup it is on rather than repeating its own title.

Every leg, on a ticket and on the slip, carries its own art: **a player prop is drawn on
that player's jersey**, a game price is the team's logo, and a WCXC matchup is the
team's avatar. The props drawer heads each player with his jersey and `TEAM · POS`.

### Jerseys

A jersey has to be the real thing, so neither half of it is guessed.

- **The number** is the player's own, read from `positions.json` (`numbers`, keyed by
  Sleeper id), which `scripts/players/build.mjs` writes daily **from ESPN's team
  rosters**. Sleeper's player file is deliberately *not* the source. Measured on
  2026-10-06: 38 of 720 players it could be compared on disagreed with ESPN's roster
  (nearly all recent signings still wearing their old team's number), and it reports
  `0` as a placeholder for players it has no number for, while a real `0` is worn by a
  dozen starters (Gibbs, Ridley, Keon Coleman…). ESPN says `0` only when it is 0.
  A number is kept only when ESPN states one **and** lists the player on the same team
  Sleeper does; otherwise there is no entry, and the page draws the jersey with no digits
  rather than somebody else's. Every one of the 69 players with a prop on the Week 5
  board had a verified number. If ESPN cannot be read, `positions.json` still publishes
  (it prices the board) and keeps the numbers it had.
- **The colours** are in `CS_JERSEY` in `index.html`: `[body, trim]` per team, what each
  team actually wears at home rather than its logo's palette (the Steelers' and Saints'
  marks are gold; their jerseys are black). Numerals are white unless the jersey is too
  light for white to read (3:1), and the Steelers and Saints wear gold ones. A test holds
  every team to the right colour family and every numeral to 3:1. To change one team,
  change its row; `WSH`, `JAC` and `LA` are aliased to the abbreviations Sleeper uses.
- Logos are ESPN's **`500-dark`** set, drawn for dark backgrounds. The light set loses the
  Rams, Giants and Jets on this page (navy and dark green on near-black). Same host, so
  the CSP already allows it.

Two pieces of state feed it, and **neither of them decides anything**:

- **`casino_games`** — one row per bettable event (`nfl:<id>` and `fan:<season>:<week>:<matchup>`)
  holding `state`, `detail` (the clock wording: `Q3 3:22`, `Halftime`, `End of Q2`,
  `Final/OT`), `situation`, `possession`, both scores and the per-quarter linescores.
  ESPN was already sending all of it on the scoreboard the sync reads for prices;
  `parseEvent()` simply stopped throwing it away.
- **`casino_lines.live`** — a prop's running number, from Sleeper's weekly stats.

Settlement is untouched: it still reads `casino_lines.outcome`, written once from the
final stats. `liveValue()` and `propOutcome()` sum the **same** stat keys deliberately,
so the bar beside a leg and the result on it can never tell different stories.

Three things keep this cheap enough to run every minute:

- The scoreboard is its own table. Were it columns on `casino_lines`, a score ticking
  over would rewrite six rows per game every minute.
- `gameSig()` normalises a row (Postgres hands numerics back as text) and compares it to
  what is stored, so a quiet minute writes nothing at all.
- Sleeper's weekly stats are about half a megabyte, so they are fetched only when
  somebody is actually holding a prop whose game has started.

A WCXC matchup reads **Final** only once every NFL game of its week is — the same test
settlement waits on — so a ticket can never say Final before it can be paid.

### How a score reaches the page

```
sync (every minute)
  1. a prop's running number   casino_lines.live        written FIRST
  2. the scoreboard row        casino_games             written last, and only if it moved
        │
        ├─ realtime ─ casino_games INSERT/UPDATE ─▶ page reads again within ~1 s
        └─ polling  ─ every 20 s while an NFL game is on, every 30 s otherwise
```

- **Realtime.** The page subscribes to `casino_games` on a channel of its own
  (`casino-games-live`), apart from the ballots channel: a table a project has not
  published to realtime fails the whole join, and the scoreboard must never be able to
  take ballots down with it. Events are gathered for 800 ms, so the fifteen games that
  move in one Sunday minute are one read, not fifteen.
- **Why the order of the two writes matters.** A scoreboard row moving is what realtime
  announces. If the prop's number were written after it, the page would read at the
  moment the clock changed and find last minute's yardage. The number has its own guard,
  so a failure writing it (`report.live`) can never stop the scoreboard.
- **Polling is the safety net, and a real one.** Realtime is not trusted to be there: a
  dropped socket, a sleeping phone and an unpublished table all leave it silent. The
  Casino re-reads every 30 s (the page's tick) and every 20 s while an NFL game is in
  progress, and again at once when the tab becomes visible or the network comes back.
- **A read asked for while another is running is not dropped.** A score landing mid-read
  would otherwise be missed until the next poll; the running read notes it
  (`CS.again`) and reads once more when it finishes.
- **The scoreboard is read newest first** with a 200-row window. Ascending, the cap kept
  the *oldest* rows: at about twenty rows a week the current week's boxes would have
  fallen off the end around Week 14, and every ticket's live box with them.
- **"Biggest win"** reads every won bet (`voter, stake, payout`), not the latest 150
  that fill the feed.
- **Is the sync still running?** `casino_rules.synced_at` is stamped at the end of every
  run, and the page shows its age beside the view switcher: *Updated just now* /
  *Live · Updated just now* while an NFL game is on, *Updated N min ago*, and after five
  minutes an amber *Scores may be behind · last update N min ago*. A cron that died would
  otherwise leave stale numbers looking live.

**"Display only" covers its failures too.** The whole scoreboard section is wrapped: if
reading or writing it throws, the run records `scoreboard` in its report and carries on to
grading and settlement. That is not hypothetical — the first time the table went onto a
live project, PostgREST was still serving a stale schema cache, the read threw
`PGRST205 Could not find the table 'public.casino_games'`, and because settlement runs
after this section, bets stopped being paid over a cosmetic box. (If you ever see that
error: `notify pgrst, 'reload schema';` in the SQL Editor.) Tests hold the rule.

## Finding a bet

The Board shows **one section at a time**: WCXC, NFL, College, Futures, each with a
count. The section tabs stick to the top of the screen (under the top bar on a phone,
whose height is measured into `--tbh`), so changing section never needs a scroll back
up, and the choice is remembered (`wcxc.cssport`).
- **NFL and College** have a search box that matches a team by any name: abbreviation,
  place or nickname ("dal", "dallas", "cowboys"; for college the school and its full name
  from `cfb.json`). Three letters or more also asks the database which open props carry
  that name, and lists those players: tapping one opens his game's props on him alone.
  The box is 16px so iOS doesn't zoom the page when it is tapped.
- Under the search, **every game on the list in one strip** (a horizontal scroller on a
  phone, an index on a desktop): tap one to jump straight to it. Games are grouped by
  week and then by day.
- **College opens on the Top 25** (games with a ranked team), with any conference or
  all of FBS in a picker; a narrow card shows each school's abbreviation and ranking
  rather than break "Georgia" over two lines.
- **A game's props drawer shows one kind of prop at a time**: TD scorers, Passing,
  Rushing, Receiving. Every market for every player in one game ran to about 7,000px on
  a phone.

**The board is patched, not rebuilt.** Every tap redraws the tab. It used to replace
`main`'s whole subtree, which destroyed the button under the finger, and WebKit (every
browser on an iPhone) loses the page's place when the element being tapped vanishes
mid-gesture: tapping "Player props", or any price, threw the page to the top, or with
scroll anchoring to the bottom. Chrome never showed it, which is why it went unseen;
Playwright's WebKit reproduced it exactly (scrollY 2142 → 7667 → 583). `csPaint` now
patches the new markup into what is already there (`csMorph`): an unchanged node is left
alone, the tapped button included; a focused input keeps its cursor; a typed value
survives unless the markup itself changed it; keyed children (`data-k`: games, players)
are matched by key. It patches only over a casino it drew itself (`.csroot`), and writes
fresh when arriving from another tab, whose listeners must not survive onto reused nodes.

## The rules (all in `casino_rules`, tunable without a deploy)

| Risk | Rule |
|---|---|
| Overdraft | Stake ≤ balance, under a per-team lock |
| Ceilings | **None by default.** Stakes, payout, parlay odds, longest price and open tickets are all optional (null = no ceiling); the bankroll is the only limit. The commissioner can set any of them in `casino_rules` |
| Fake or stale prices | Price and point re-read server-side. A mismatch is refused as "odds changed". Pregame lines must be < 30 min old. Nothing after kickoff. |
| Betting a touchdown before the line moves | Live bets wait out a 45s delay (below) |
| Correlated parlays | **No cap on legs** (`parlay_max_legs` null; set a number to cap) and no cap on combined odds (`parlay_max_price` null). Legs from one NFL game form a **same-game parlay** (`sgp_max_legs` null = no cap), priced from a simulation (below) and never above the legs multiplied. One leg per WCXC matchup |
| Price limits | **None by default**: no shortest price (`leg_min_price` null) and no longest (`leg_max_price` null). FanDuel's prices carry its margin, so repeatedly betting heavy favourites loses on average. The commissioner can set either |
| Tanking | **No betting against your own WCXC team** (`block_self_bets`, on by default): no opponent moneyline and no under on your own game. Backing yourself is fine. The page says so on your own matchup. The same rule covers WCXC futures: never your team to miss the playoffs, and in a race your team is still listed in (the title, its division), only your team |
| Futures | **Single bets only.** WCXC futures are open only between the morning forecast and the week's first kickoff, regular season only, from a model-3 forecast; NFL futures close while any NFL game is on |
| College | One leg per college game in a parlay (no college game is simulated). College lines and props close at kickoff |

Settlement:
- A push refunds the stake.
- A prop voids if the player didn't play (Sleeper `gp`).
- In a parlay, a losing leg loses the ticket as soon as it's known. Pushed and voided
  legs drop out and the rest is repriced, with the cap applied again.
- `casino_settle()` caps every payout at stake × price and `max_payout`, whatever the
  caller asks for.

## Same-game parlays

Legs from one game move together, so multiplying their prices overpays. DAL moneyline
with DAL −8.5 is really just the spread bet, because a cover is a win, yet multiplied it
would pay +131 against the spread's own −112.

**How they're priced:**
- Every NFL game is simulated 4,096 times (`simulateGame()` in
  `supabase/functions/_shared/casino.mjs`).
- Each line stores one bit per simulated game in `casino_lines.sim`, set where that side
  won.
- A same-game group's chance is the share of simulated games where **every** leg won.
  `place_bet` counts it in SQL (`bit_count` of the AND of the legs' bits), so the price
  is computed server-side and any combination works.
- The group pays that chance less `sgp_hold` (15%), **never more than its legs
  multiplied**. It must win in at least `sgp_min_hits` simulated games to be priced, and
  can't pay ≤ 1.01.
- Other games in the parlay multiply in as usual.

**The model** is a set of shared factors:
- Margin and total are fitted to DraftKings' own moneyline, spread and total, with the
  vig removed. The simulated single-leg chances match them within simulation noise.
- Each team's passing is driven by its scoring plus a passing environment shared with
  the opponent, so shootouts lift both quarterbacks.
- Each team's rushing is driven by its scoring plus its own margin, because leading
  teams run.
- Each player loads on his team's passing or rushing by role, and each stat loads on its
  player.
- The resulting correlations, measured on a live game: QB yards vs his top receiver
  ~0.55, a receiver's catches vs his yards ~0.81, QB yards vs the game total ~0.52, a
  running back vs his team winning ~0.40.

**Why the cap makes the guesses fail safe.** These correlations are estimates, because
DraftKings publishes none. "Never more than multiplied" removes any boost a
*too-high* correlation could give someone mixing overs and unders. So an overestimate can
only make a price worse for the bettor. The only exploitable error is a correlation set
too *low* for legs that move together, which is why every factor is set at the high end
of what football suggests. The 15% hold and the $25 parlay and $1,000 payout caps absorb
the rest.

**Limits:** no cap on legs per game unless `sgp_max_legs` is set; pregame only; NFL only
(a WCXC matchup stays one leg). **First and last TD scorer** can't join a same-game
group, because only one player can score first, which independent factors can't
express.

**Milestones and touchdown counts** are thresholds on the same player latent as that
stat's over/under, so 100+ yards only wins where 50+ does, and 2+ TDs only where anytime
does. One-way prices carry FanDuel's margin, which makes a leg look likelier than it is.
That's the safe direction for a group's price.

**Settlement:** the legs of one game settle as a unit at the same-game price stored on
each leg (`bet_legs.group_price`). A push or void anywhere takes that game's legs out
together, and the rest reprices.

The seeds are deterministic per game and quantity, so a prop simulated when props
refreshed and a spread simulated this minute share the same simulated games.

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

**Adding college and futures to a running casino** (October 2026), in this order:
1. Re-run `supabase-setup.sql`. It replaces the two inline sport checks by name (so a
   table created before college accepts `cfb`, `cprop` and `future`), adds
   `casino_lines.jersey` and the new `casino_rules` columns, and redefines `place_bet`.
   Until it runs, the page simply has nothing in College and Futures, and a page that
   asks for `jersey` too early falls back to reading without it.
2. Push the site: `index.html`, `cfb.json`, `cfb-players.json`, `scripts/cfb/build.mjs`
   and the workflow. The sync reads `cfb-players.json` from the site.
3. Deploy `casino-sync` (command above).
4. Run the odds workflow by hand (Actions → Update playoff odds → Run workflow) so
   `odds.json` is rebuilt by model 3. WCXC futures stay closed (`stale`) until it is.

**Troubleshooting:**

```sql
select * from cron.job_run_details where jobname = 'casino-sync' order by start_time desc limit 10;
select status_code, content from net._http_response order by created desc limit 5;
```

The function returns a JSON report: lines written, props games refreshed, fantasy
lines, outcomes, legs graded, bets resolved and settled.

**Every row says `403 forbidden`, and the page shows "Scores may be behind".** The cron
is being rejected: the function's `CRON_SECRET` and the vault's `casino_cron_secret`
are two separate copies of one value, and rotating either without the other stops the
sync dead. Nothing else shows it, because the cron job itself still reports `succeeded`
(it only queues the request) — `net._http_response` is where the 403s are. This happened
on 2026-10-06: the function's secret was changed at 23:26 UTC and the vault's never was,
so the cron was rejected for hours. To see whether they agree without exposing either,
compare hashes (the CLI shows the function secret's SHA-256 in `value`):

```sql
select left(encode(extensions.digest(convert_to(decrypted_secret, 'utf8'), 'sha256'), 'hex'), 12)
from vault.decrypted_secrets where name = 'casino_cron_secret';
```
```
npx supabase@latest secrets list --project-ref qwgwaedeuihvneirbplb     # CRON_SECRET "value" starts the same?
```

To rotate (both, always, and in this order), pick a new random value and:

```
npx supabase@latest secrets set CRON_SECRET=<new> --project-ref qwgwaedeuihvneirbplb
```
```sql
select vault.update_secret((select id from vault.secrets where name = 'casino_cron_secret'), '<new>');
```

Within a minute the newest `net._http_response` row should read `200` with the JSON
report. `npx supabase@latest db query --linked --project-ref qwgwaedeuihvneirbplb "<sql>"`
runs any of the queries above without opening the dashboard.

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
node --test tests/casino.test.mjs tests/casino-sync.test.mjs tests/casino-ui.test.mjs tests/casino-live.test.mjs tests/casino-sql.test.mjs tests/casino-futures.test.mjs tests/casino-cfb.test.mjs tests/players.test.mjs
```

`casino-futures.test.mjs` prices WCXC futures from a forecast, holds the settlement's
seeding to the forecast's own over 400 random leagues, and settles from Sleeper's real
2025 season and refuses this season's projected bracket. `casino-cfb.test.mjs` prices,
matches and settles college games and props from real ESPN and FanDuel responses
(Week 6 of 2026, and a finished North Texas–Tulsa box score).

`casino-live.test.mjs` runs the page against an in-memory stand-in for Supabase (its own
queries answered with filters, ordering and row limits; realtime channels the test can
fire; timers it controls) to prove a score the sync writes reaches the ticket — over
realtime, over the poll alone, on waking, and with two reads overlapping.

`casino-sql.test.mjs` runs the real `supabase-setup.sql` in PGlite (Postgres in
WebAssembly) and exercises the money rules for real: rewards, every refusal path,
settlement, refunds, the self-bet rule and re-running the setup. PGlite isn't a site
dependency, so point `PGLITE` at an install to run those tests; without it they
skip and only the static contract checks run:

```
npm i --prefix /tmp/pg @electric-sql/pglite
PGLITE=/tmp/pg/node_modules/@electric-sql/pglite node --test tests/casino-sql.test.mjs
```
