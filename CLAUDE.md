# WCXC Poll Tracker

Power-rankings voting site for WCXC Dynasty, a 12-team superflex, TE-premium dynasty league on Sleeper. Live at wcxcdynasty.site (once deployed).

## Stack
- `index.html`: the whole site in one file (HTML, CSS, JS). No build step.
- Supabase backend. `supabase-setup.sql` creates:
  - `ballots` (season, week, voter = Sleeper roster_id, ranking int[] best-first), publicly readable
  - `league_auth` (one row, bcrypt hash of the single shared league password, not readable)
  - `check_password()` RPC so sign-in fails fast; `submit_ballot()` RPC, the only write path, re-checks the password server-side and validates the ballot
  - `set_league_password()` is commissioner-only and deliberately NOT granted to anon — the site must never be able to change the password
- Auth model: one shared league password, entered once and kept in localStorage. Reading is open to everyone; only casting a ballot is gated. Any signed-in person can vote as any team — accepted trade, with the public Ballot grid as the backstop.
  - Realtime on `ballots`
- Sleeper API (no auth) for teams, records, avatars, and the current week. League ID: 1312128506452283392
- Hosting: Cloudflare Pages, deployed from GitHub on push. Custom domain wcxcdynasty.site, DNS on Cloudflare. `netlify.toml` is kept only as a fallback and is inert on Cloudflare.
- `_headers` sets the security headers and is read by both Cloudflare Pages and Netlify — it's the one place headers are defined. It includes a CSP that allowlists every host the page talks to. Adding a CDN, analytics script, font host, or second Supabase project means updating it or the browser blocks the request silently.
- Keep Cloudflare **Rocket Loader off** for this site — it rewrites script tags and can break the inline bootstrap.

## Conventions
- Keep it a single static `index.html` unless there's a real reason to split it.
- Design is modeled on collegepolltracker.com: blue header (#014587), tabs for Cast ballot / Poll / Ballot grid / Distribution / Season / Voters.
- The Season chart uses the emphasis form (all 12 teams gray, hovered/clicked one in blue) — 12 categorical hues can't stay distinguishable. Colors are `--em` / `--ctx`; see README before changing them.
- Poll scoring: 12 points for 1st down to 1 point for 12th. Ties broken by first-place votes, then points for.
- Supabase URL and anon key live at the top of `index.html`. The anon key is public by design and is safe to commit.
- Test locally with `npx serve .` or `python3 -m http.server`.
