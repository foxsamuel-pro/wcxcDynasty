/* One casino sync: refresh lines, record outcomes, grade legs, run the live-bet
 * delay, settle. Runs every minute from pg_cron (supabase/casino-cron.sql).
 *
 * All I/O is passed in — `get(url)` returns parsed JSON or null, `db` is the
 * small adapter in casino-sync/index.ts — so the Node tests drive this exact
 * code with fixtures and an in-memory database.
 *
 * Order matters: lines are written before pending bets are judged, so a live
 * bet is compared against odds fetched AFTER it was placed; legs are graded
 * before bets are settled.
 */
import {
  parseEvent, gameLines, propLines, lineStatus, fantasyPairs, fantasyLines, calibrationScale,
  gradeLeg, propOutcome, settleBet, resolvePending,
} from './casino.mjs';

export const ESPN_SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const propsUrl = id =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds/100/propBets?lang=en&region=us&limit=1000`;
const SLEEPER = 'https://api.sleeper.app';
const LEAGUE_ID = '1312128506452283392';

const PROPS_EVERY_MS = 10 * 60000;      // per game
const PROPS_PER_RUN = 4;                // keeps one run well inside the edge CPU budget
const PROPS_AHEAD_MS = 8 * 86400000;
const FANTASY_EVERY_MS = 10 * 60000;
const SCALE_EVERY_MS = 20 * 3600000;    // the projection calibration moves once a week; daily is plenty
const SCALE_WEEKS = 8;                  // recent finished weeks it is measured over
const PROP_GRADE_AFTER_MS = 4 * 3600000; // kickoff + 4h: the game is over and Sleeper's stats have landed

export async function runSync({ db, get, now = Date.now(), site = 'https://wcxcdynasty.site' }) {
  const iso = new Date(now).toISOString();
  const report = { lines: 0, props: [], fantasy: 0, outcomes: 0, graded: 0, resolved: 0, settled: 0 };
  const rules = await db.rules();

  const state = await get(`${SLEEPER}/v1/state/nfl`);
  const season = Number(state?.season) || new Date(now).getUTCFullYear();
  if (state?.season_start_date && state.season_start_date !== String(rules.season_start).slice(0, 10))
    await db.updateRules({ season_start: state.season_start_date });

  /* ---- the slate: ESPN's current week and the one after ---- */
  const cur = await get(ESPN_SB);
  const boards = [];
  const W = Number(cur?.week?.number);
  const regular = Number(cur?.season?.type) === 2;
  if (cur?.events && regular) {
    boards.push({ week: W, data: cur });
    if (W < 18) {
      const next = await get(`${ESPN_SB}?week=${W + 1}&seasontype=2&dates=${season}`);
      if (next?.events) boards.push({ week: W + 1, data: next });
    }
  }
  const events = [];
  for (const b of boards) for (const ev of b.data.events) {
    const e = parseEvent(ev);
    if (e) events.push({ ...e, week: b.week });
  }
  const evById = Object.fromEntries(events.map(e => [e.id, e]));

  // Anything still marked pregame whose kickoff has passed stops taking bets now.
  await db.closeStarted(iso);

  /* ---- game lines ---- */
  const rows = [];
  const prev = Object.fromEntries((await db.linesForEvents(events.map(e => `nfl:${e.id}`))).map(l => [l.id, l]));
  for (const e of events) {
    const event = `nfl:${e.id}`;
    if (e.state !== 'pre') await db.closeEvent(event, e.state, ['prop']);   // props are pregame only
    if (e.state === 'post' || (e.state === 'in' && !rules.live_enabled)) {
      await db.closeEvent(event, e.state, ['nfl']);
      continue;
    }
    const lines = gameLines(e, { season, week: e.week });
    await db.suspendMissing(event, 'nfl', lines.map(l => l.id));          // a pulled market stops at once
    for (const l of lines) rows.push({ ...l, status: lineStatus(prev[l.id], l, rules), updated_at: iso });
  }
  report.lines = rows.length;

  /* ---- player props, a few games per run, each refreshed every ten minutes ---- */
  const synced = { ...(rules.props_synced || {}) };
  const due = events
    .filter(e => e.state === 'pre' && Date.parse(e.commence) - now < PROPS_AHEAD_MS && Date.parse(e.commence) > now)
    .filter(e => !synced[e.id] || now - Date.parse(synced[e.id]) >= PROPS_EVERY_MS)
    .sort((a, b) => Date.parse(synced[a.id] || 0) - Date.parse(synced[b.id] || 0))
    .slice(0, PROPS_PER_RUN);
  if (due.length) {
    const espn = (await get(`${site}/espn.json`))?.players;
    if (espn) for (const e of due) {
      const feed = await get(propsUrl(e.id));
      if (!feed?.items) continue;
      const pl = propLines(feed.items, e, { season, week: e.week, espn, american: rules.prop_american });
      await db.suspendMissing(`nfl:${e.id}`, 'prop', pl.map(l => l.id));  // a player ruled out disappears from the feed
      for (const l of pl) rows.push({ ...l, status: 'open', updated_at: iso });
      synced[e.id] = iso;
      report.props.push(e.id);
    }
    // forget games that are no longer on the slate
    for (const k of Object.keys(synced)) if (!evById[k]) delete synced[k];
    await db.updateRules({ props_synced: synced });
  }

  /* ---- WCXC matchups: priced for the next week that hasn't kicked off ---- */
  const kick = w => Math.min(...events.filter(e => e.week === w).map(e => Date.parse(e.commence)));
  const fw = boards.map(b => b.week).find(w => Number.isFinite(kick(w)) && kick(w) > now);
  if (fw && (!rules.fantasy_synced_at || now - Date.parse(rules.fantasy_synced_at) >= FANTASY_EVERY_MS)) {
    const [league, matchups, proj, pos] = await Promise.all([
      get(`${SLEEPER}/v1/league/${LEAGUE_ID}`),
      get(`${SLEEPER}/v1/league/${LEAGUE_ID}/matchups/${fw}`),
      get(`${SLEEPER}/v1/projections/nfl/regular/${season}/${fw}`),
      get(`${site}/positions.json`),
    ]);
    if (league?.scoring_settings && matchups?.length && proj && pos?.positions) {
      const scale = await fantasyScale({ db, get, rules, season, fw, scoring: league.scoring_settings, pos, now, iso });
      const pairs = fantasyPairs({ matchups, proj, positions: pos.positions, teams: pos.teams,
        done: {}, scoring: league.scoring_settings, scale });
      const fl = fantasyLines(pairs, { season, week: fw, commence: new Date(kick(fw)).toISOString(),
        hold: Number(rules.fantasy_hold) });
      // a market no longer offered (spreads, a changed matchup) stops taking bets at once
      for (const ev of new Set(fl.map(l => l.event)))
        await db.suspendMissing(ev, 'fantasy', fl.filter(l => l.event === ev).map(l => l.id));
      for (const l of fl) rows.push({ ...l, status: 'open', updated_at: iso });
      report.fantasy = fl.length;
      await db.updateRules({ fantasy_synced_at: iso });
    }
  }

  await db.upsertLines(rows);

  /* ---- outcomes, only for lines somebody actually bet ---- */
  const legs = await db.openLegs();
  const need = new Map();
  for (const g of legs) if (!g.line.outcome && Date.parse(g.line.commence_at) <= now) need.set(g.line.id, g.line);
  const outcomes = {};
  const cache = {};
  const once = (k, f) => (cache[k] ??= f());
  const boardFor = w => once(`sb${w}`, async () => {
    const b = boards.find(x => x.week === w);
    const data = b ? b.data : await get(`${ESPN_SB}?week=${w}&seasontype=2&dates=${season}`);
    return Object.fromEntries((data?.events || []).map(ev => parseEvent(ev)).filter(Boolean).map(e => [e.id, e]));
  });
  const statsFor = w => once(`st${w}`, () => get(`${SLEEPER}/v1/stats/nfl/regular/${season}/${w}`));
  const fantasyFor = w => once(`fa${w}`, async () => {
    const scores = await get(`${SLEEPER}/scores/nfl/regular/${season}/${w}`);
    const arr = Array.isArray(scores) ? scores : scores ? Object.values(scores) : [];
    if (!arr.length || !arr.every(x => x && (x.status === 'complete' || x.metadata?.is_over === true))) return null;
    const mus = await get(`${SLEEPER}/v1/league/${LEAGUE_ID}/matchups/${w}`);
    if (!mus?.length) return null;
    return { pts: Object.fromEntries(mus.filter(m => typeof m.points === 'number').map(m => [m.roster_id, m.points])) };
  });
  for (const l of need.values()) {
    let out = null;
    if (l.sport === 'fantasy') out = await fantasyFor(l.week);
    else {
      const e = (await boardFor(l.week))[l.event.slice(4)];
      if (!e?.completed) continue;
      if (l.sport === 'nfl') out = { home: e.homeScore, away: e.awayScore };
      else if (now >= Date.parse(l.commence_at) + PROP_GRADE_AFTER_MS) {
        const st = await statsFor(l.week);
        if (st) out = propOutcome(st[l.player], l.market);
      }
    }
    if (out) outcomes[l.id] = out;
  }
  const list = Object.entries(outcomes).map(([id, outcome]) => ({ id, outcome }));
  if (list.length) await db.setOutcomes(list);
  report.outcomes = list.length;

  /* ---- grade every open leg whose line is decided ---- */
  const grades = [];
  for (const g of legs) {
    const o = g.line.outcome || outcomes[g.line.id];
    const result = o ? gradeLeg(g.line, g.point == null ? null : Number(g.point), o) : null;
    if (result) grades.push({ bet: g.bet_id, line: g.line_id, result });
  }
  if (grades.length) await db.gradeLegs(grades);
  report.graded = grades.length;

  /* ---- the live-bet delay ---- */
  for (const p of await db.pendingBets()) {
    const r = resolvePending(p.bet, p.legs, p.lines, {
      live_delay_sec: rules.live_delay_sec, live_tolerance: Number(rules.live_tolerance),
      pending_timeout_sec: rules.pending_timeout_sec }, now);
    if (r) { await db.resolve(p.bet.id, r.accept, r.note); report.resolved++; }
  }

  /* ---- settle ---- */
  for (const b of await db.openBets()) {
    const s = settleBet(b, b.legs, { parlay_max_price: Number(rules.parlay_max_price), max_payout: Number(rules.max_payout) });
    if (s) { await db.settle(b.id, s.status, s.payout); report.settled++; }
  }

  await db.updateRules({ synced_at: iso });
  return report;
}

/* The projection calibration (see calibrationScale): what teams actually scored
   over what the same model projected for them before kickoff, across the most
   recent finished weeks. Measured at most daily and stored on casino_rules, so
   the minute-by-minute runs never refetch old weeks. A week counts only once
   every NFL game in it is final. Until there is enough to measure (the first
   weeks of a season) the last stored value stands. */
async function fantasyScale({ db, get, rules, season, fw, scoring, pos, now, iso }) {
  const stored = Number(rules.fantasy_scale) || 1;
  if (rules.fantasy_scale_at && now - Date.parse(rules.fantasy_scale_at) < SCALE_EVERY_MS) return stored;
  const samples = [];
  let weeks = 0;
  for (let w = Math.max(1, fw - SCALE_WEEKS); w < fw; w++) {
    const scores = await get(`${SLEEPER}/scores/nfl/regular/${season}/${w}`);
    const arr = Array.isArray(scores) ? scores : scores ? Object.values(scores) : [];
    if (!arr.length || !arr.every(x => x && (x.status === 'complete' || x.metadata?.is_over === true))) continue;
    const [mw, pw] = await Promise.all([
      get(`${SLEEPER}/v1/league/${LEAGUE_ID}/matchups/${w}`),
      get(`${SLEEPER}/v1/projections/nfl/regular/${season}/${w}`),
    ]);
    if (!mw?.length || !pw) continue;
    // the pregame view: nothing banked, nothing finished
    const pre = mw.map(m => ({ ...m, points: 0, players_points: {} }));
    for (const p of fantasyPairs({ matchups: pre, proj: pw, positions: pos.positions, teams: pos.teams, scoring }))
      for (const s of p.sides) {
        const m = mw.find(x => x.roster_id === s.team);
        if (typeof m?.points === 'number') samples.push({ proj: s.proj, actual: m.points });
      }
    weeks++;
  }
  const measured = calibrationScale(samples);
  await db.updateRules(measured
    ? { fantasy_scale: measured, fantasy_scale_weeks: weeks, fantasy_scale_at: iso }
    : { fantasy_scale_at: iso });
  return measured ?? stored;
}
