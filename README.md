# WCXC Poll Tracker

Power-rankings voting for **WCXC Dynasty** — a 12-team superflex, TE-premium dynasty
league on Sleeper. Each manager ranks all 12 teams every week; the site tallies the
ballots into a poll and shows how everyone voted.

Live at **[wcxcdynasty.site](https://wcxcdynasty.site)**.

## The tabs

| Tab | What it shows |
|---|---|
| **Cast ballot** | Pick your team, rank all 12, submit with your team PIN. Drag rows to reorder, or start from last week's ballot. |
| **Poll** | The week's tally — points, first-place votes, average/high/low rank, and movement from last week. |
| **Ballot grid** | Every ballot pick-by-pick. Hover a logo to trace one team across all 12 ballots. |
| **Distribution** | How many voters put each team at each spot. |
| **Season** | Poll rank week by week, as a chart and a full table. |
| **Voters** | How far each ballot sits from the consensus, and whether a manager ranks their own team higher than the league does. |

Scoring: **12 points** for a first-place vote down to **1 point** for twelfth. Ties break
on first-place votes, then points for.

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
- `team_pins` — bcrypt-hashed PINs, readable by nobody
- `submit_ballot()` — the only write path; it checks the PIN and validates the ballot
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
> succeed, `team_pins` returns nothing, and direct `INSERT` / `UPDATE` / `DELETE` on
> `ballots` all affect zero rows. The only write path is `submit_ballot()`, which
> requires the team's PIN.
>
> The **secret** key (`sb_secret_…`) and the **database password** bypass all of that.
> Neither belongs in this repo, in the browser, or in any deployed file, and neither is
> needed for day-to-day operation.

### 2. Netlify

Connect the repo and deploy. No build step — [`netlify.toml`](netlify.toml) publishes the
folder as-is and sets the security headers.

**If you add a CDN, font host, or a second Supabase project, add it to the
`Content-Security-Policy` in `netlify.toml`** or the browser will block it silently.

Point the `wcxcdynasty.site` domain at the site under *Domain management*.

### 3. Local

```bash
npx serve .          # or: python3 -m http.server
```

Sleeper data loads without a key. If Sleeper can't be reached the site falls back to a
snapshot of the standings and says so in the footer.

## PINs

The first ballot a team submits **sets** that team's PIN — there's no separate signup.
Every ballot after that needs the same PIN, so nobody can vote as someone else. The PIN
is stored as a bcrypt hash and is saved in the voter's browser so they don't retype it.

Commissioner jobs, run by hand in the SQL editor:

```sql
-- Someone forgot their PIN (they set a new one on their next ballot)
delete from public.team_pins where voter = 8;

-- Throw out one ballot
delete from public.ballots where season = 2026 and week = 3 and voter = 8;
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
