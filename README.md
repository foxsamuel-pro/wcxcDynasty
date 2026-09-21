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
| **Ballot grid** | Every ballot pick-by-pick. Hover a logo to trace one team across all 12 ballots. |
| **Distribution** | How many voters put each team at each spot. |
| **Season** | Poll rank week by week, as a chart and a full table. |
| **Voters** | How far each ballot sits from the consensus, and whether a manager ranks their own team higher than the league does. |

Scoring: **12 points** for a first-place vote down to **1 point** for twelfth. Ties break
on first-place votes, then points for.

**Voting window.** Ballots can only be cast for the **current week** — past weeks are
settled and future weeks haven't happened. Every other week is still fully readable, and
the pill in the header says which mode you're in (`Voting open` / `Results only`). The
current week rolls over on Sun/Mon/Tue Eastern, so rankings go out before games are played.

> The RPC itself still accepts any week 1–18, deliberately — that's the commissioner's
> escape hatch for backfilling a missed ballot by hand in SQL. The lock is in the UI.

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
