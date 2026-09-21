# WCXC Poll Tracker

Power-rankings voting site for WCXC Dynasty, a 12-team superflex, TE-premium dynasty league on Sleeper. Live at wcxcdynasty.site (once deployed).

## Stack
- `index.html`: the whole site in one file (HTML, CSS, JS). No build step.
- Supabase backend. `supabase-setup.sql` creates:
  - `ballots` (season, week, voter = Sleeper roster_id, ranking int[] best-first), publicly readable
  - `team_passwords` (one row per team, bcrypt-hashed, not readable)
  - `submit_ballot()` RPC, the only write path. It checks or sets the team's password and validates the ballot.
- Auth model: per-team password, like the old PIN but a normal password field (no numeric-only restriction). A team's first ballot sets its password; every ballot after needs the same one. Reading is open to everyone; only casting a ballot is gated, and only for that one team.
  - Realtime on `ballots`
- Sleeper API (no auth) for teams, records, avatars, divisions, rosters and the schedule. League ID: 1312128506452283392
- `ktc.json` — dynasty superflex values keyed by Sleeper player id, built by `node tools/refresh-ktc.js`. KTC has no API and no CORS, so the name→id mapping is resolved at build time. Rostered players only; picks excluded. Re-run periodically; team totals always recompute from live rosters.
- Playoff odds are simulated in-browser from the real remaining schedule. Format is read from Sleeper (`divisions`, `playoff_teams`, `playoff_week_start`), not hardcoded: division winners + next best by record/PF, top 2 winners get byes, remaining 4 seeded 3–6 on record/PF, reseeding each round.
- Hosting: Cloudflare Pages, deployed from GitHub on push. Custom domain wcxcdynasty.site, DNS on Cloudflare. `netlify.toml` is kept only as a fallback and is inert on Cloudflare.
- `_headers` sets the security headers and is read by both Cloudflare Pages and Netlify — it's the one place headers are defined. It includes a CSP that allowlists every host the page talks to. Adding a CDN, analytics script, font host, or second Supabase project means updating it or the browser blocks the request silently.
- Keep Cloudflare **Rocket Loader off** for this site — it rewrites script tags and can break the inline bootstrap.

## Conventions
- Keep it a single static `index.html` unless there's a real reason to split it.
- Voting window: **Tue 12:00 AM ET → Thu 8:00 PM ET**, and only for the current week. `votingOpen() = windowOpen() && S.week === CURRENT_WEEK`. Other weeks/times render `renderClosed()` and stay fully readable. A 30s `tick()` opens and closes the form live, no reload. The RPC still accepts any week on purpose, as a commissioner backfill path.
- `CURRENT_WEEK` comes from `pollWeekFor()`, counting Tuesday-to-Tuesday from `season_start_date` — **not** Sleeper's `state.week`, which doesn't advance at a reliable time and would risk opening ballots for an already-played week. All time math is `America/New_York` and DST-safe (whole-day counters, not ms arithmetic).
- Past weeks keep everything: ballots are `(season, week, voter)` and `loadBallots()` pulls the whole season, so Poll/Grid/Spread/Season/Voters all work retroactively.
- Responsive in one stylesheet, no separate mobile page. Breakpoints: **760px** (main mobile pass) and **380px** (small phones). Wide stat tables get `class="cards"` plus `data-l` on each `td.stat` so they restack as cards; wide matrix tables get `class="matrix"` to pin the first column. Header and tabs share one sticky `.chrome` wrapper.
- Local preview: VS Code Live Server (auto-reload), or `npx serve .`. Never push just to look at a change.
- Design is modeled on collegepolltracker.com: blue header (#014587), tabs for Cast ballot / Poll / Ballot grid / Distribution / Season / Voters.
- The Season chart uses the emphasis form (all 12 teams gray, hovered/clicked one in blue) — 12 categorical hues can't stay distinguishable. Colors are `--em` / `--ctx`; see README before changing them.
- Poll scoring: 12 points for 1st down to 1 point for 12th. Ties broken by first-place votes, then points for.
- Supabase URL and anon key live at the top of `index.html`. The anon key is public by design and is safe to commit.
- Test locally with `npx serve .` or `python3 -m http.server`.
