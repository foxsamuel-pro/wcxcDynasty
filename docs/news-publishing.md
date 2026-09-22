# News publishing

News runs as a scheduled **Claude Code GitHub Action using the Claude subscription**.
The workflow prepares an edition-specific prompt and league facts, prompts Claude,
validates its structured article output, and commits `news.json` to `main`.
Cloudflare then deploys that commit. There is no direct AI API integration.

## Schedule

All editorial times are **America/New_York**, including daylight saving changes.

| Edition | Due | Content |
|---|---|---|
| Tuesday | 5 PM | Full weekly recap, once the previous week's games are final. No Tuesday poll release. |
| Wednesday | 5 PM | Poll article with at least **8 valid, distinct ballots**; otherwise satire. |
| Thursday | 5 PM | Poll article regardless of count if it did not run Wednesday; otherwise satire, optionally about tonight's game. |
| TNF / SNF / MNF preview | One hour before the first primetime kickoff | Fantasy matchups, relevant players, projected outcomes, stakes. |
| TNF / MNF postgame | Once every game in the primetime slate is final | Results and what changed for the fantasy league. A doubleheader gets one preview and one recap. |
| Sunday early slate | Noon | Early-slate preview. |
| Sunday late slate | 4 PM | Late-slate preview, using the early games' current results. |
| Sunday post-SNF | Once Sunday's games are all final | One full-day recap covering early, late and SNF. This **is** the SNF postgame article. |
| Other days without games | 5 PM | One substantive trade/injury story, or satire when there is no worthwhile news. |

On days without games, there is at most **one daily edition**. On game days there is
no one-article cap: Thursday can have the 5 PM edition plus both TNF pieces; Sunday
normally has four editions. A game finishing after midnight keeps the prior game's
editorial date, so its recap does not consume the following day's 5 PM slot.
Poll coverage at 5 PM is a snapshot; the site's ballot submission window still closes
Thursday at 8 PM. At zero ballots Thursday's article reports that fact, without
inventing rankings.

The workflow checks every 15 minutes. GitHub can queue scheduled jobs, and writing
and Cloudflare deployment take additional time, so these are target times rather
than exact-minute delivery guarantees. Previews expire at kickoff instead of being
published hours late. Recaps wait for actual final status, not an assumed end time.
Nothing runs outside the configured league's regular NFL season.

## One-time subscription sign-in

1. In a terminal where Claude is signed into the desired subscription, run
   `claude setup-token` and complete its sign-in flow.
2. Add the resulting token as the repository Actions secret
   **`CLAUDE_CODE_OAUTH_TOKEN`** in
   [GitHub settings](https://github.com/foxsamuel-pro/wcxcDynasty/settings/secrets/actions/new).
   Do not put the token in this repository, a prompt, or chat.
3. Run **Publish league news** from the Actions tab with **dry_run** and
   **check_sign_in** checked to verify data access and a short Claude subscription
   prompt without publishing. Uncheck both to publish a currently due edition.

Without the subscription secret, the workflow checks data and reports that sign-in
is missing; it skips writing. Claude usage is subject to the subscription's limits.
If sign-in expires or usage is exhausted, generation fails without changing the archive.

Authentication and structured output follow the official
[Claude Code action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)
and [usage](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md).
GitHub documents scheduling delays in its
[schedule event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Editorial rules

- About 75% straight reporting, 25% dry humor; typically 350–450 words, no editorial word cap.
- Evaluate all six fantasy matchups. Lead with teams, using their poll rank in parentheses.
  Use managers' real first names when the person's decision is the story.
- Use Sleeper league scoring for player projections and weekly positional ranks.
  The publishing code supplies scoreboard numbers, probabilities and player ranks.
- Never invent real results, quotes, trades, injuries or updated standings. Official
  roster totals are labeled as potentially lagging; Sunday results are not all final
  when players still have Monday games. Article prose is AI-written, not a proof of facts.
- Satire is explicitly labeled and limited to fictional fantasy-team business.
  It never invents real-world misconduct, injuries or health claims.
- Old trades and already-covered injury statuses are excluded from daily candidates.
  Injury status alone does not establish when an injury happened.
- Keep the full archive and stable article IDs so comments and retries work.

## Checks and troubleshooting

```text
node --test tests/news-schedule.test.mjs tests/news-publisher.test.mjs
node scripts/news/publish.mjs --dry-run
```

A dry run writes the ignored `.news-run/assignment.json`, reads live league data,
and neither invokes Claude nor changes `news.json`. The generated assignment is
also the concrete prompt context used by the GitHub workflow.

The publisher validates the whole batch before replacing the archive. A changed
archive or stale assignment stops publication; a later run retries from fresh data.
Workflow concurrency prevents overlapping publishers. Failed commits or pushes do
not force-overwrite repository history.
