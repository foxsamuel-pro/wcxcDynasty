# WCXC Poll Tracker

Power-rankings voting for **WCXC Dynasty** — a 12-team superflex, TE-premium dynasty
league on Sleeper. Each manager ranks all 12 teams every week; the site tallies the
ballots into a poll and shows how everyone voted.

Live at **[wcxcdynasty.site](https://wcxcdynasty.site)**.

## The tabs

| Tab | What it shows |
|---|---|
| **Cast ballot** | Pick your team, rank all 12, submit with your team's password. Drag rows to reorder, or start from last week's ballot. **Only open for the current week.** |
| **Poll** | The week's tally — points, first-place votes, average/high/low rank, and movement from last week. |
| **Ballot grid** | Every ballot pick-by-pick. Hover a logo to trace one team across all 12 ballots. Underneath, the vote distribution: how many voters put each team at each spot. |
| **Season** | Poll rank week by week, as a chart and a full table. |
| **Voters** | How far each ballot sits from the consensus. **Tap any voter** for their full report — who they're high on, who they're low on, every ballot they've cast. |
| **Trades** | Every deal in league history and what each side has scored *since* — including the players its picks actually became. Filter by team or season. |
| **Playoff odds** | 10,000 player-level simulated seasons, updated daily under the league's playoff format. Playoff chances also appear in the Poll table. |
| **Analysis** | The poll lined up against what teams are actually doing — record, points for/against, efficiency, margin. Opt-in, so the rest of the site stays uncluttered. |

Scoring: **12 points** for a first-place vote down to **1 point** for twelfth. Ties break
on first-place votes, then points for.

## Voting window

Ballots open **Tuesday 12:00 AM ET** and close **Thursday 8:00 PM ET**, every week — the
gap between one week's Monday night game and the next week's Thursday kickoff. Outside
that window nobody can vote, and it's handled automatically: no switch to flip.

The header pill counts down (`Voting closes in 2d 4h`) while open and reads `Results only`
when shut. A page left open overnight notices the change on its own — it re-checks every
30 seconds, so the ballot form appears at midnight Tuesday and disappears at 8 PM Thursday
without anyone reloading.

**A ballot belongs to the week it's ranking *into*.** Ballots cast Tue–Thu are the
rankings going into that week's games, so while the window is shut the next one to open
belongs to the *following* week — on a Monday, the ballots opening tonight are Week 3's,
not the Week 2 whose games are finishing. `pollWeekFor()` is the week being played;
`ballotWeek()` is the week being voted on.

**Which week you're voting on is derived from the season start date, not from Sleeper.**
Sleeper's `state.week` doesn't advance at a guaranteed moment — it was still reporting
week 2 late on the Monday night of week 2 — so keying the Tuesday open off it risks
opening ballots for a week that has already been played. Instead the site counts
Tuesday-to-Tuesday from `season_start_date`, which rolls over at exactly the same instant
voting opens. Verified against DST boundaries.

> The RPC itself still accepts any week 1–18, deliberately — that's the commissioner's
> escape hatch for backfilling a missed ballot by hand in SQL. The lock is in the UI.

## Historic weeks

Nothing is ever discarded. Ballots are keyed `(season, week, voter)` and the site loads
the whole season at once, so **every past week keeps its full results** — not just your
own ballot:

| Tab | For a past week |
|---|---|
| Poll | that week's complete tally, points, first-place votes, avg/high/low |
| Ballot grid | all 12 ballots pick-by-pick, with the trace-a-team highlight, plus that week's full spread |
| Season | every week side by side, chart and table |
| Voters | every voter's gap from that week's consensus |

Only *casting* is closed. The Cast ballot tab for a past week says so, reports how many
ballots were cast, shows your own, and links straight to the full results.

## Setup

### 1. Supabase — done

Project `qwgwaedeuihvneirbplb` is live, [`supabase-setup.sql`](supabase-setup.sql) has
been run against it, and the URL and publishable key are already in
[`index.html`](index.html). Nothing to do here unless you're rebuilding from scratch.

<details>
<summary>Rebuilding on a fresh project</summary>

Create a project, then open **SQL Editor → New query**, paste all of
[`supabase-setup.sql`](supabase-setup.sql), and run it. That creates:

- `ballots` — one row per team per week, publicly readable
- `team_passwords` — one row per team, bcrypt-hashed, readable by nobody
- `submit_ballot()` — the only write path; it checks or sets the team's password and validates the ballot
- realtime on `ballots`, so new ballots appear on everyone's screen without a refresh

Then copy **Project URL** and the **anon / publishable key** from
*Project Settings → API* into the top of [`index.html`](index.html):

```js
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_KEY = "YOUR-ANON-OR-PUBLISHABLE-KEY";
```

Until you do, the site runs read-only and shows a "Voting isn't connected yet" banner.

</details>

> **On keys.** The **publishable** key (`sb_publishable_…`) is the one in `index.html`.
> It is public by design and safe to commit — it's the anon role, and row-level security
> governs everything it can do. Verified against the live project: reads of `ballots`
> succeed, `team_passwords` returns nothing, and direct `INSERT` / `UPDATE` / `DELETE` on
> `ballots` all affect zero rows. The only write path is `submit_ballot()`, which
> requires the team's password.
>
> The **secret** key (`sb_secret_…`) and the **database password** bypass all of that.
> Neither belongs in this repo, in the browser, or in any deployed file, and neither is
> needed for day-to-day operation.

### 2. Cloudflare Pages

Connect the repo in **Workers & Pages → Create → Pages**. There is no build step:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `/` |

Add `wcxcdynasty.site` under the project's **Custom domains** tab. Because the domain
sits in the same Cloudflare account, the DNS record and the certificate are created for
you — nothing to copy by hand.

Two Cloudflare settings matter for this site:

- **Rocket Loader must stay off** (*Speed → Optimization*). It rewrites script tags and
  can break the inline bootstrap in `index.html`.
- **If you turn on Cloudflare Web Analytics**, its beacon comes from
  `static.cloudflareinsights.com`, which the CSP does not currently allow. Add it to
  `script-src` in [`_headers`](_headers) or the beacon will be blocked.

**Security and cache headers live in [`_headers`](_headers)**, which Cloudflare Pages and
Netlify both read — so they can't drift apart, and moving hosts doesn't mean rewriting
them. If you add a CDN, font host, analytics script, or a second Supabase project, add it
to the `Content-Security-Policy` there or the browser will block it silently.

[`netlify.toml`](netlify.toml) is kept only as a fallback and does nothing on Cloudflare.

### 3. Local preview — don't push to see a change

**Easiest, with auto-reload (recommended in VS Code):** install the **Live Server**
extension (`ritwickdey.LiveServer`), then right-click `index.html` → **Open with Live
Server**. It opens `http://127.0.0.1:5500` and refreshes the browser every time you save.

**Or from a terminal in this folder:**

```bash
npx serve .                 # http://localhost:3000
python -m http.server 8000  # http://localhost:8000
```

Both serve the folder as-is. Reload the page by hand after each save (Live Server does
that part for you). Stop the server with `Ctrl+C`.

The local copy talks to the **same live Supabase project** as production, so a ballot cast
locally is a real ballot. To poke at the UI without touching real data, use a season that
doesn't exist — or just work on a week that isn't the current one, since voting is locked
to the current week anyway.

**Checking the mobile layout without a phone:** open DevTools (`F12`) → the device-toolbar
icon (`Ctrl+Shift+M`) → pick a phone preset. The layout switches over at **760px**, with a
second pass at 380px for small phones.

Sleeper data loads without a key. If Sleeper can't be reached the site falls back to a
snapshot of the standings and says so in the footer.

## Team passwords

**Each team has its own password.** Reading the site needs nothing — the poll, ballot
grid, distribution, season trends, and voter report are open to anyone with the link. A
team's password only gates *casting a ballot as that team*.

There's no separate signup: **a team's first-ever ballot sets its password** to whatever
is typed into the password box. Every ballot after that must use the same one. It's a
normal password field — any characters, no numeric-only restriction — stored as a bcrypt
hash, and the browser remembers it in that team's chip so nobody retypes it weekly.

Commissioner jobs, run by hand in the SQL editor:

```sql
-- Someone forgot their password (they set a new one on their next ballot)
delete from public.team_passwords where voter = 8;

-- Throw out one ballot
delete from public.ballots where season = 2026 and week = 3 and voter = 8;

-- See who has voted this week
select voter, updated_at from public.ballots
where season = 2026 and week = 3 order by voter;
```

`voter` is the Sleeper **roster_id**, 1–12.

## Playoff odds

The site displays 10,000 player-level simulated seasons from a dated daily snapshot.
Historical scoring under league settings supplies position-specific PPG profiles;
a weighted player lottery carries season-long boom/bust uncertainty into every
remaining regular-season and playoff week. Legal optimal lineups, NFL byes,
randomized absences, weekly matchup projections, and player variance determine the scores.
The Poll table includes the latest playoff chances with the forecast date.

Standings include both head-to-head and league-median results, preserve ties, and
bank completed weeks exactly once. Three division winners qualify, the best two
get byes, and three wildcards complete the six-team playoff field. The actual
playoff weeks are simulated through the championship.

The independent GitHub workflow updates around 6:17 AM Eastern daily, with retries.
It does not require Claude. Failed updates retain the last successful forecast;
the page shows its date and flags stale results. Sampling intervals accompany the
probabilities, and no poll data enters the model.

See [the full methodology and validation](docs/playoff-odds.md) for data sources,
formulas, model limitations, and publishing behavior. Run locally with
`node scripts/odds/build.mjs`; test with
`node --test tests/odds*.test.mjs tests/catchup.test.js`.

## Comments

Every article takes comments, with a thumbs up/down on each. Identity is the **same
per-team password used for ballots** — no second account. A team must have cast a ballot
(and so set a password) before it can comment.

Writes go through RPCs that re-check the password: `post_comment`, `vote_comment`,
`delete_comment`. Direct table writes are refused by RLS. You can delete your own comment
and nobody else can; one vote per team per comment, and clicking the same arrow again
clears it. There is a 10-second per-team rate limit.

## Analysis

One question — *does the league's opinion match what the teams are actually doing?* —
asked several ways. The controls are **metric × scope × view** rather than a pile of
separate charts, which keeps it to one tab that nobody has to visit.

| Control | Options |
|---|---|
| Metric | win %, points for, points against, lineup efficiency, points margin |
| Scope | this week, or the season so far |
| View | gap bars, scatter, gap over time |

**Gap** is the stat's rank minus the poll's rank. Positive means the league ranks a team
*higher* than the numbers do; negative means lower. Gaps always sum to zero, since both
sides are rankings of the same twelve teams — which is a useful correctness check and is
asserted in the tests.

The headline number is a **Spearman rank correlation**: one figure for how much the poll
and that statistic agree, from −1 to +1. Against the live league it reads 0.88 for win %
and −0.07 for points against — correctly showing that points *against* is mostly opponent
luck, which the league sensibly ignores when voting.

Chart forms follow what the data is doing, not what looks busiest:

- **Gap bars** are a diverging form (above/below a baseline), so they use two hues with a
  neutral centre. The pair is validated against both light and dark surfaces —
  `#0a5bab`/`#c0392b` light and `#5596dc`/`#e66767` dark, all six checks passing.
  The first dark blue I tried failed the lightness band at L=0.674 and was re-stepped.
- **Scatter** is one hue with every point directly labelled, since twelve categorical
  colours would be indistinguishable.
- **Gap over time** reuses the emphasis form from the Season chart.

Every view ships the underlying numbers as a table as well, so nothing depends on reading
a colour.

## Managers

The site shows **real first names**, not Sleeper handles — the mapping lives in `MANAGERS`
at the top of `index.html`, keyed by Sleeper `roster_id`. Sleeper has no field for this, so
it is maintained by hand; add a line there if a team changes hands.

## Automated news

The [news publishing schedule](docs/news-publishing.md) defines Wednesday/Thursday
poll-or-satire editions, Sunday noon and 4 PM previews, and TNF/SNF/MNF pregame and
postgame coverage. Days without games get at most one 5 PM Eastern edition.

The [GitHub workflow](.github/workflows/news.yml) prompts Claude Code using a Claude
subscription sign-in. Activation requires the `CLAUDE_CODE_OAUTH_TOKEN` repository
secret from `claude setup-token`; see the linked setup instructions. No AI API key
is used. News commits deploy through the existing Cloudflare integration.

## How it's built

One static `index.html` — markup, styles, and logic in a single file, no build step and
no dependencies beyond the Supabase client from a CDN. Keep it that way unless there's a
real reason to split it.

State lives in one `S` object; every interaction mutates it and re-renders. Realtime
changes to `ballots` trigger a reload, so the poll updates live while people vote.

### About the season chart

Twelve teams means twelve series, which is past the point where categorical colors work —
no set of 12 hues stays distinguishable, especially with color vision deficiency. So the
chart uses the **emphasis** form instead: every team is drawn in a recessive gray and the
one you hover or click is drawn in blue with a direct label. Identity comes from selection
and the label, never from color alone, and the table underneath carries the exact numbers.

The two colors are validated, not eyeballed — blue against gray measures ΔE 31.8 in light
mode and 25.5 in dark (floor is 15), so the highlighted line reads clearly in both themes.
They live as `--em` and `--ctx` at the top of the stylesheet.
