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
  simulateGame, simHex, TD_ORDER,
  fdGames, fdMatch, fdPageUrl, fdTabUrl, FD_TABS, fdPropLines, playerIndex, tdPlays, scorerOf,
  gradeLeg, propOutcome, settleBet, resolvePending,
  nflGameRow, fanGameRows, fanLive, gameSig, liveValue,
  cfbGameRow, fdCfbPageUrl, fdMatchCfb, fdCfbPropLines, cfbBox, cfbStatsFor, cfbPropOutcome, cfbLiveValue,
  wcxcFutureLines, wcxcSettlement, nflFutureLines, nflPlayoffFates, superBowlWinner,
} from './casino.mjs';

export const ESPN_SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const propsUrl = id =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds/100/propBets?lang=en&region=us&limit=1000`;
const SLEEPER = 'https://api.sleeper.app';
const LEAGUE_ID = '1312128506452283392';

const PROPS_EVERY_MS = 10 * 60000;      // per game
const FD_EVENTS_EVERY_MS = 60 * 60000;  // FanDuel's list of games: hourly, or sooner for a game it has not matched yet
const ESPN_SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const espnPlayUrl = (ev, play) => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${ev}/competitions/${ev}/plays/${play}`;
const PROPS_PER_RUN = 4;                // keeps one run well inside the edge CPU budget
const PROPS_AHEAD_MS = 8 * 86400000;
const FANTASY_EVERY_MS = 10 * 60000;
const SCALE_EVERY_MS = 20 * 3600000;    // the projection calibration moves once a week; daily is plenty
const SCALE_WEEKS = 8;                  // recent finished weeks it is measured over
const PROP_GRADE_AFTER_MS = 4 * 3600000; // kickoff + 4h: the game is over and Sleeper's stats have landed

/* College: ESPN's FBS scoreboard carries DraftKings' lines like the NFL one. It
   is a megabyte on a Saturday, so it is read every two minutes, or every minute
   while a college game somebody has bet on is being played. */
export const CFB_SB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300';
export const CFB_SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary';
const CFB_EVERY_MS = 2 * 60000;
const CPROPS_EVERY_MS = 15 * 60000;     // per game: well inside the half hour after which place_bet calls a price stale
const CPROPS_PER_RUN = 4;               // games FanDuel has, each four tab reads; a Saturday can have forty
const CPROPS_AHEAD_MS = 2 * 86400000;   // FanDuel posts college props a day or two out
/* Futures. WCXC's are re-read from odds.json and the NFL's from FanDuel every
   ten minutes while they are open; both close the moment their window does. */
const FUT_EVERY_MS = 10 * 60000;
const ODDS_MAX_AGE_MS = 8 * 86400000;   // a forecast older than this is stale, whatever its week says
export const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings';

export async function runSync({ db, get, now = Date.now(), site = 'https://wcxcdynasty.site' }) {
  const iso = new Date(now).toISOString();
  const report = { lines: 0, props: [], fantasy: 0, outcomes: 0, graded: 0, resolved: 0, settled: 0, games: 0, live: 0,
    cfb: null, cprops: [], futures: {} };
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
  const gameRows = {};
  let posCache, espnCache, fdCache;
  const posFile = () => (posCache ??= get(`${site}/positions.json`));
  const espnFile = () => (espnCache ??= get(`${site}/espn.json`));
  // FanDuel's NFL page (1.4 MB): its list of games for props and its futures, read at most once a run
  const fdPage = () => (fdCache ??= get(fdPageUrl()));

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
    gameRows[e.id] = lines;
    // each line carries its simulated wins, so same-game parlays can be priced from them
    const sims = lines.length ? simulateGame({ event, lines }).bits : {};
    await db.suspendMissing(event, 'nfl', lines.map(l => l.id));          // a pulled market stops at once
    for (const l of lines) rows.push({ ...l, status: lineStatus(prev[l.id], l, rules), updated_at: iso, sim: simHex(sims[l.id]) });
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
    const espn = (await espnFile())?.players;
    const positions = (await posFile())?.positions || {};
    const idx = espn ? playerIndex(espn) : null;
    // which FanDuel game each ESPN game is; the list is refetched hourly, or after ten
    // minutes when a game on the slate has no FanDuel match yet (next week's, say)
    let fdMap = rules.fd_events || {};
    const fdAge = rules.fd_events_at ? now - Date.parse(rules.fd_events_at) : Infinity;
    if (fdAge >= FD_EVENTS_EVERY_MS || (fdAge >= PROPS_EVERY_MS && due.some(e => !fdMap[e.id]))) {
      const games = fdGames(await fdPage());
      if (games.length) fdMap = Object.fromEntries(events.map(e => [e.id, fdMatch(games, e)?.id ?? null]));
      report.fanduel = games.length ? 'ok' : 'unreachable';
      await db.updateRules({ fd_events: fdMap, fd_events_at: iso });
    }
    if (espn) for (const e of due) {
      let pl = [], source = null;
      if (fdMap[e.id]) {                         // real prices, every market FanDuel has
        const markets = {};
        for (const tab of FD_TABS) Object.assign(markets, (await get(fdTabUrl(fdMap[e.id], tab)))?.attachments?.markets || {});
        pl = fdPropLines(markets, e, { season, week: e.week, idx });
        if (pl.length) source = 'fanduel';
      }
      if (!source) {                             // DraftKings' lines through ESPN, at the house price
        const feed = await get(propsUrl(e.id));
        if (feed?.items) { pl = propLines(feed.items, e, { season, week: e.week, espn, american: rules.prop_american }); source = 'espn'; }
      }
      if (!source) continue;
      /* Closed, not suspended: a line that left the feed (a player ruled out, or
         the -115 lines FanDuel just replaced) must not linger in the drawer. If it
         comes back, the upsert below opens it again. */
      await db.closeMissing(`nfl:${e.id}`, 'prop', pl.map(l => l.id));
      // simulated with this game's current lines, on the same seeds, so props and game lines share games
      const sims = simulateGame({ event: `nfl:${e.id}`, lines: gameRows[e.id] || [], props: pl, positions }).bits;
      for (const l of pl) rows.push({ ...l, status: 'open', updated_at: iso, sim: simHex(sims[l.id]) });
      synced[e.id] = iso;
      report.props.push(`${e.id}:${source}`);
    }
    // forget games that are no longer on the slate
    for (const k of Object.keys(synced)) if (!evById[k]) delete synced[k];
    await db.updateRules({ props_synced: synced });
  }

  /* ---- WCXC matchups: priced for the next week that hasn't kicked off ---- */
  const kick = w => Math.min(...events.filter(e => e.week === w).map(e => Date.parse(e.commence)));
  const fw = boards.map(b => b.week).find(w => Number.isFinite(kick(w)) && kick(w) > now);
  let fanRows = [];
  if (fw && (!rules.fantasy_synced_at || now - Date.parse(rules.fantasy_synced_at) >= FANTASY_EVERY_MS)) {
    const [league, matchups, proj, pos] = await Promise.all([
      get(`${SLEEPER}/v1/league/${LEAGUE_ID}`),
      get(`${SLEEPER}/v1/league/${LEAGUE_ID}/matchups/${fw}`),
      get(`${SLEEPER}/v1/projections/nfl/regular/${season}/${fw}`),
      posFile(),
    ]);
    if (league?.scoring_settings && matchups?.length && proj && pos?.positions) {
      const scale = await fantasyScale({ db, get, rules, season, fw, scoring: league.scoring_settings, pos, now, iso });
      const pairs = fantasyPairs({ matchups, proj, positions: pos.positions, teams: pos.teams,
        done: {}, scoring: league.scoring_settings, scale });
      const commence = new Date(kick(fw)).toISOString();
      const fl = fantasyLines(pairs, { season, week: fw, commence, hold: Number(rules.fantasy_hold) });
      fanRows = fanGameRows(pairs, { season, week: fw, commence });
      // a market no longer offered (spreads, a changed matchup) stops taking bets at once
      for (const ev of new Set(fl.map(l => l.event)))
        await db.suspendMissing(ev, 'fantasy', fl.filter(l => l.event === ev).map(l => l.id));
      for (const l of fl) rows.push({ ...l, status: 'open', updated_at: iso });
      report.fantasy = fl.length;
      await db.updateRules({ fantasy_synced_at: iso });
    }
  }

  /* Open bets, read here rather than after the upsert: whether a college game
     somebody holds is being played sets how often college is read, and futures
     are settled only for bets that exist. */
  const legs = await db.openLegs();

  /* College and futures need what supabase-setup.sql added with them: their
     sports in the line table's check, and their columns on casino_rules. Until
     the script has been re-run, a college or futures row is refused, and in the
     same write as the NFL's lines that refusal would stop the whole board and
     the settlement after it. So both wait until the schema is there (the new
     rules columns are the sign), and their rows go up in a write of their own
     besides (`extra`, below). */
  const ready = !!rules && 'fut_status' in rules;
  const extra = [];

  /* ---- college: DraftKings' lines through ESPN, and FanDuel's props ----
     Like every section that writes lines, wrapped: a failure here is reported
     and the run carries on, so it can never stop a bet already placed from
     being graded and paid below. */
  let cfbEvents = null;
  const isCfb = l => l.sport === 'cfb' || l.sport === 'cprop';
  const cfbBets = new Set(legs.filter(g => isCfb(g.line)).map(g => g.line.event));
  if (!ready) report.cfb = 'waiting for supabase-setup.sql';
  else try {
    const playing = legs.some(g => isCfb(g.line) && !g.line.outcome && Date.parse(g.line.commence_at) <= now);
    const age = rules.cfb_synced_at ? now - Date.parse(rules.cfb_synced_at) : Infinity;
    if (age >= (playing ? 60000 : CFB_EVERY_MS)) {
      const board = await get(CFB_SB);
      const cw = Number(board?.week?.number);
      if (Array.isArray(board?.events) && cw > 0) {
        cfbEvents = board.events.map(ev => parseEvent(ev)).filter(Boolean).map(e => ({ ...e, week: cw }));
        const byEvent = {};
        for (const l of await db.linesForEvents(cfbEvents.map(e => `cfb:${e.id}`), 'cfb')) (byEvent[l.event] ||= []).push(l);
        let n = 0;
        for (const e of cfbEvents) {
          const event = `cfb:${e.id}`, had = byEvent[event] || [];
          /* Under way, over, or past its kickoff while ESPN still says "pre" (a
             late start): closeStarted shut its lines at kickoff, and nothing here
             may open them again. The state is recorded once, not every run. */
          if (e.state !== 'pre' || Date.parse(e.commence) <= now) {
            if (had.some(l => l.status !== 'closed' || l.state !== e.state)) await db.closeEvent(event, e.state, ['cfb', 'cprop']);
            continue;
          }
          const lines = gameLines(e, { season, week: cw, sport: 'cfb' });
          const ids = new Set(lines.map(l => l.id));
          if (had.some(l => l.status === 'open' && !ids.has(l.id))) await db.suspendMissing(event, 'cfb', [...ids]);
          const prev = Object.fromEntries(had.map(l => [l.id, l]));
          for (const l of lines) extra.push({ ...l, status: lineStatus(prev[l.id], l, rules), updated_at: iso });
          n += lines.length;
        }
        report.cfb = n;
        await db.updateRules({ cfb_synced_at: iso });
      } else report.cfb = 'unreachable';
    }

    /* College props, only where FanDuel has them (the bigger games, a couple
       of days out) and refreshed every quarter hour each. A game it hasn't
       posted costs nothing to check: no request is made for it. */
    if (cfbEvents) {
      const done = { ...(rules.cprops_synced || {}) };
      const due = cfbEvents
        .filter(e => e.state === 'pre' && Date.parse(e.commence) > now && Date.parse(e.commence) - now < CPROPS_AHEAD_MS)
        .filter(e => !done[e.id] || now - Date.parse(done[e.id].at) >= CPROPS_EVERY_MS)
        .sort((a, b) => Date.parse(done[a.id]?.at || 0) - Date.parse(done[b.id]?.at || 0));
      if (due.length) {
        let fdC = rules.cfb_fd_events || {};
        const fdAge = rules.cfb_fd_events_at ? now - Date.parse(rules.cfb_fd_events_at) : Infinity;
        if (fdAge >= FD_EVENTS_EVERY_MS || (fdAge >= CPROPS_EVERY_MS && due.some(e => !(e.id in fdC)))) {
          const games = fdGames(await get(fdCfbPageUrl()));
          if (games.length) fdC = Object.fromEntries(cfbEvents.map(e => [e.id, fdMatchCfb(games, e)?.id ?? null]));
          report.fanduelCfb = games.length ? 'ok' : 'unreachable';
          await db.updateRules({ cfb_fd_events: fdC, cfb_fd_events_at: iso });
        }
        let rosters, fetched = 0;
        for (const e of due) {
          const fd = fdC[e.id];
          if (fd && fetched >= CPROPS_PER_RUN) continue;        // its turn comes next run
          let pl = [];
          if (fd) {
            rosters ??= (await get(`${site}/cfb-players.json`))?.teams || null;
            if (!rosters) { report.cprops.push('no cfb-players.json'); break; }   // nobody can be named: try next run
            const markets = {};
            for (const tab of FD_TABS) Object.assign(markets, (await get(fdTabUrl(fd, tab)))?.attachments?.markets || {});
            pl = fdCfbPropLines(markets, e, { season, week: e.week, rosters });
            fetched++;
            report.cprops.push(`${e.id}:${pl.length}`);
          }
          // closed, not suspended, as for the NFL: a prop that left the feed must not linger in the drawer
          if (pl.length || done[e.id]?.n) await db.closeMissing(`cfb:${e.id}`, 'cprop', pl.map(l => l.id));
          for (const l of pl) extra.push({ ...l, status: 'open', updated_at: iso });
          done[e.id] = { at: iso, n: pl.length };
        }
      }
      for (const k of Object.keys(done)) if (!cfbEvents.some(e => e.id === k)) delete done[k];
      if (JSON.stringify(done) !== JSON.stringify(rules.cprops_synced || {})) await db.updateRules({ cprops_synced: done });
    }
  } catch (e) {
    report.cfb = `failed: ${e?.message || e}`;
  }

  /* ---- futures ---- */
  const fut = { ...(rules.fut_status || {}) };
  /* WCXC: priced from the league's own forecast. odds.json is rebuilt every
     morning from every result so far, so its prices are fair only while no game
     it doesn't know about has kicked off: open from the rebuild after a week's
     last game until the next week's first kickoff (Tuesday morning to Thursday
     night), closing at that kickoff like a game line does (commence_at).
     Regular season only: no WCXC future is sold once the playoffs begin. */
  if (!ready) report.futures.wcxc = report.futures.nfl = 'waiting for supabase-setup.sql';
  else try {
    if (!rules.wfut_synced_at || now - Date.parse(rules.wfut_synced_at) >= FUT_EVERY_MS) {
      const odds = await get(`${site}/odds.json`);
      const fresh = odds && Number(odds.modelVersion) >= 3 && String(odds.leagueId) === LEAGUE_ID && Number(odds.season) === season
        && Array.isArray(odds.rows) && odds.rows.length === 12 && now - Date.parse(odds.generated) < ODDS_MAX_AGE_MS;
      const wk = Number(odds?.firstOpen), until = kick(wk);
      let lines = [];
      if (!fresh) fut.wcxc = { open: false, why: 'stale' };
      else if (!(wk <= Number(odds.lastRegular))) fut.wcxc = { open: false, why: 'season' };
      else if (!(Number.isFinite(until) && until > now)) fut.wcxc = { open: false, why: 'games' };
      else {
        const [league, rosters] = await Promise.all([get(`${SLEEPER}/v1/league/${LEAGUE_ID}`), get(`${SLEEPER}/v1/league/${LEAGUE_ID}/rosters`)]);
        if (Array.isArray(rosters) && rosters.length === 12) {
          const divisions = Object.fromEntries(rosters.map(r => [r.roster_id, r.settings?.division]));
          const divNames = Object.fromEntries([1, 2, 3, 4].map(d => [d, league?.metadata?.[`division_${d}`]]).filter(([, n]) => n));
          lines = wcxcFutureLines(odds, { season, week: wk, commence: new Date(until).toISOString(),
            hold: Number(rules.future_hold ?? 0.05), divisions, divNames });
          fut.wcxc = lines.length ? { open: true, until: new Date(until).toISOString(), built: odds.generated } : { open: false, why: 'stale' };
        } else fut.wcxc = { open: false, why: 'stale' };
      }
      await db.closeMissingLike('fut:wcxc:', 'future', lines.map(l => l.id));
      for (const l of lines) extra.push({ ...l, status: 'open', updated_at: iso });
      report.futures.wcxc = lines.length || fut.wcxc.why;
      await db.updateRules({ wfut_synced_at: iso });
    } else if (fut.wcxc?.open && Date.parse(fut.wcxc.until) <= now) fut.wcxc = { open: false, why: 'games' };
  } catch (e) {
    report.futures.wcxc = `failed: ${e?.message || e}`;
  }
  /* NFL: FanDuel's prices, never while a game is on. Each line closes at the
     next kickoff (its commence_at) and is re-read once every game under way is
     over. Regular season only: the sync doesn't follow playoff kickoffs, so it
     couldn't close the market for them. */
  if (ready) try {
    const nflLive = events.some(e => e.state === 'in');
    const nextKick = Math.min(...events.filter(e => e.state === 'pre' && Date.parse(e.commence) > now).map(e => Date.parse(e.commence)));
    if (!regular || !events.length) {
      if (fut.nfl?.why !== 'season') await db.closeMissingLike('fut:nfl:', 'future', []);
      fut.nfl = { open: false, why: 'season' };
    } else if (nflLive || !Number.isFinite(nextKick)) {
      if (fut.nfl?.open) await db.closeMissingLike('fut:nfl:', 'future', []);
      fut.nfl = { open: false, why: 'games' };
    } else if (fut.nfl?.why === 'games' || !rules.nfut_synced_at || now - Date.parse(rules.nfut_synced_at) >= FUT_EVERY_MS) {
      // straight back after the last game ends; otherwise every ten minutes, open or not
      const lines = nflFutureLines((await fdPage())?.attachments?.markets, { season, week: W, commence: new Date(nextKick).toISOString() });
      await db.closeMissingLike('fut:nfl:', 'future', lines.map(l => l.id));
      for (const l of lines) extra.push({ ...l, status: 'open', updated_at: iso });
      fut.nfl = lines.length ? { open: true, until: new Date(nextKick).toISOString() } : { open: false, why: 'unavailable' };
      report.futures.nfl = lines.length || 'unavailable';
      await db.updateRules({ nfut_synced_at: iso });
    }
  } catch (e) {
    report.futures.nfl = `failed: ${e?.message || e}`;
  }

  await db.upsertLines(rows);
  // college and futures in a write of their own: whatever goes wrong with them, the NFL board is already up
  if (extra.length) {
    try { await db.upsertLines(extra); }
    catch (e) { report.extra = `failed: ${e?.message || e}`; }
  }

  /* ---- outcomes, only for lines somebody actually bet ---- */

  /* Every remote read below happens at most once per run, however many lines
     ask for it: the scoreboard and the settlement want the same weeks. */
  const cache = {};
  const once = (k, f) => (cache[k] ??= f());
  const boardFor = w => once(`sb${w}`, async () => {
    const b = boards.find(x => x.week === w);
    const data = b ? b.data : await get(`${ESPN_SB}?week=${w}&seasontype=2&dates=${season}`);
    return Object.fromEntries((data?.events || []).map(ev => parseEvent(ev)).filter(Boolean).map(e => [e.id, e]));
  });
  const statsFor = w => once(`st${w}`, () => get(`${SLEEPER}/v1/stats/nfl/regular/${season}/${w}`));
  const matchupsFor = w => once(`mu${w}`, () => get(`${SLEEPER}/v1/league/${LEAGUE_ID}/matchups/${w}`));
  // every NFL game of that fantasy week is final — the test a WCXC result waits on
  const weekDone = w => once(`wd${w}`, async () => {
    const scores = await get(`${SLEEPER}/scores/nfl/regular/${season}/${w}`);
    const arr = Array.isArray(scores) ? scores : scores ? Object.values(scores) : [];
    return arr.length > 0 && arr.every(x => x && (x.status === 'complete' || x.metadata?.is_over === true));
  });
  /* First and last touchdown scorer of a game, as Sleeper ids: 'other' when the
     scorer is nobody we offered (a defensive touchdown), null when nobody scored
     one, undefined when ESPN could not be read (try again next run). */
  const scorersFor = ev => once(`sc${ev}`, async () => {
    const plays = tdPlays(await get(`${ESPN_SUMMARY}?event=${ev}`));
    if (!plays.any) return { first: null, last: null };
    const espn = (await espnFile())?.players || {};
    const who = async id => { const a = scorerOf(await get(espnPlayUrl(ev, id))); return a ? (espn[a]?.id ?? 'other') : undefined; };
    const first = await who(plays.first), last = plays.last === plays.first ? first : await who(plays.last);
    return first === undefined || last === undefined ? undefined : { first, last };
  });
  const fantasyFor = async w => {
    if (!await weekDone(w)) return null;
    const mus = await matchupsFor(w);
    if (!mus?.length) return null;
    return { pts: Object.fromEntries(mus.filter(m => typeof m.points === 'number').map(m => [m.roster_id, m.points])) };
  };
  // a college game's box score, once a run: it settles the game's lines and props, and draws their bars
  const cfbBoxFor = id => once(`cb${id}`, async () => { const s = await get(`${CFB_SUMMARY}?event=${id}`); return s ? cfbBox(s) : null; });

  /* ---- the scoreboards behind the tickets ----
     Display only: no price, no outcome, no balance depends on any of this. A
     row is sent only when something about it actually moved, so a quiet minute
     writes nothing at all.

     Wrapped, because "display only" has to be true of its FAILURES as well.
     Grading and settlement run below this, and the first time the table was
     added to a live project PostgREST had not reloaded its schema cache yet —
     the read threw, and a stale cache for a scoreboard stopped bets being
     paid. Nothing in here is allowed to do that: it records the problem in
     the report and the run carries on to the money. */
  try {
  const stored = await db.games();
  const sigs = Object.fromEntries(stored.map(g => [g.event, gameSig(g)]));
  const scoreboard = events.map(e => nflGameRow(e, { season, week: e.week })).concat(fanRows);
  /* College games, only those somebody holds a ticket on (sixty live scores a
     minute would be sixty realtime pings to every open page for nothing), and
     only on a run that read the college scoreboard. */
  if (cfbEvents) for (const e of cfbEvents) if (cfbBets.has(`cfb:${e.id}`)) scoreboard.push(cfbGameRow(e, { season, week: e.week }));
  /* WCXC matchups already under way: Sleeper's running points. A week is Final
     only once every NFL game in it is, which is the same test settlement uses,
     so a ticket never reads Final before it can be paid. */
  const liveFan = stored.filter(g => g.sport === 'fantasy' && g.state !== 'post'
    && Date.parse(g.commence_at) <= now && !scoreboard.some(r => r.event === g.event));
  for (const w of new Set(liveFan.map(g => g.week)))
    scoreboard.push(...fanLive(liveFan.filter(g => g.week === w), await matchupsFor(w), await weekDone(w)));
  const moved = scoreboard.filter(g => sigs[g.event] !== gameSig(g));

  /* ---- a prop's running number, while its game is on ----
     Only for props somebody is actually holding, and only once one of their
     games has started: Sleeper's weekly stats are about half a megabyte, far
     too much to pull on a quiet Tuesday.

     Written BEFORE the scoreboard rows, because a row moving is what tells open
     pages to look again (realtime on casino_games). Were the number written
     after, the page would read at the moment the clock changed and find last
     minute's yardage, then wait out its fallback poll for the right one. It has
     its own guard so a failure here can never stop the scoreboard below it. */
  try {
    const livePropWeeks = new Set(legs
      .filter(g => g.line.sport === 'prop' && !g.line.outcome && Date.parse(g.line.commence_at) <= now)
      .map(g => g.line.week));
    const liveCfb = legs.filter(g => g.line.sport === 'cprop' && !g.line.outcome && Date.parse(g.line.commence_at) <= now);
    if (livePropWeeks.size || liveCfb.length) {
      const vals = [];
      for (const w of livePropWeeks) {
        const st = await statsFor(w);
        if (!st) continue;
        for (const g of legs) {
          const l = g.line;
          if (l.sport !== 'prop' || l.week !== w || l.outcome || Date.parse(l.commence_at) > now) continue;
          const v = liveValue(st[l.player], l.market);
          if (v != null && !vals.some(x => x.id === l.id)) vals.push({ id: l.id, live: v });
        }
      }
      // a college prop's number comes off ESPN's box score, in the keys its outcome uses
      for (const { line: l } of liveCfb) {
        if (vals.some(x => x.id === l.id)) continue;
        const box = await cfbBoxFor(l.event.slice(4));
        const v = box ? cfbLiveValue(cfbStatsFor(box, l), l.market) : null;
        if (v != null) vals.push({ id: l.id, live: v });
      }
      if (vals.length) await db.setLive(vals);
      report.live = vals.length;
    }
  } catch (e) {
    report.live = `failed: ${e?.message || e}`;
  }

  if (moved.length) await db.setGames(moved);
  report.games = moved.length;
  } catch (e) {
    report.scoreboard = `failed: ${e?.message || e}`;
  }
  const need = new Map();
  for (const g of legs) if (!g.line.outcome && Date.parse(g.line.commence_at) <= now) need.set(g.line.id, g.line);
  const outcomes = {};
  for (const l of need.values()) {
    let out = null;
    if (l.sport === 'fantasy') out = await fantasyFor(l.week);
    else if (l.sport === 'future') continue;              // settled below, when its question is answered
    else if (isCfb(l)) {
      const box = await cfbBoxFor(l.event.slice(4));
      if (!box?.completed) continue;
      if (l.sport === 'cfb') out = { home: box.home.score, away: box.away.score };
      else if (now >= Date.parse(l.commence_at) + PROP_GRADE_AFTER_MS) out = cfbPropOutcome(cfbStatsFor(box, l), l.market);
    }
    else {
      const e = (await boardFor(l.week))[l.event.slice(4)];
      if (!e?.completed) continue;
      if (l.sport === 'nfl') out = { home: e.homeScore, away: e.awayScore };
      else if (now >= Date.parse(l.commence_at) + PROP_GRADE_AFTER_MS) {
        const st = await statsFor(l.week);
        if (st && TD_ORDER[l.market]) {
          const sc = await scorersFor(l.event.slice(4));
          if (sc) out = st[l.player]?.gp > 0 ? { played: true, scorer: sc[TD_ORDER[l.market]] } : { played: false };
        } else if (st) out = propOutcome(st[l.player], l.market);
      }
    }
    if (out) outcomes[l.id] = out;
  }

  /* ---- futures: settled when their question is answered, not at a kickoff ----
     WCXC from Sleeper (see wcxcSettlement: the bracket must agree with the
     standings, or nothing moves); an NFL team's playoff bet the moment ESPN
     marks it clinched or eliminated; the Super Bowl once it is final. */
  try {
    const futs = [...new Map(legs.filter(g => g.line.sport === 'future' && !g.line.outcome).map(g => [g.line.id, g.line])).values()];
    const wx = futs.filter(l => l.event.startsWith('fut:wcxc:')), nf = futs.filter(l => l.event.startsWith('fut:nfl:'));
    if (wx.length && (state?.season_type !== 'regular' || Number(state?.week) >= 14)) {
      const base = `${SLEEPER}/v1/league/${LEAGUE_ID}`;
      const [league, rosters, bracket] = await Promise.all([get(base), get(`${base}/rosters`), get(`${base}/winners_bracket`)]);
      const st = wcxcSettlement({ league, rosters, bracket });
      report.futures.settle = st.why || 'ok';
      for (const l of wx) {
        let out = null;
        if (l.market === 'po' && st.po) out = { made: st.po[l.team] === true };
        else if (l.market === 'div' && st.div) { const d = l.event.split(':').pop(); if (st.div[d] != null) out = { winner: st.div[d] }; }
        else if (l.market === 'title' && st.title != null) out = { winner: st.title };
        if (out) outcomes[l.id] = out;
      }
    }
    if (nf.some(l => l.market === 'nflpo') && (W >= 10 || !regular)) {
      const fates = nflPlayoffFates(await get(ESPN_STANDINGS));
      for (const l of nf) if (l.market === 'nflpo' && typeof fates[l.label] === 'boolean') outcomes[l.id] = { made: fates[l.label] };
    }
    if (nf.some(l => l.market === 'sb') && !regular) {
      const winner = superBowlWinner(await get(`${ESPN_SB}?seasontype=3&week=5&dates=${season}`));
      if (winner) for (const l of nf) if (l.market === 'sb') outcomes[l.id] = { winner };
    }
  } catch (e) {
    report.futures.settle = `failed: ${e?.message || e}`;
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
    // raw values: a null ceiling means none, and settleBet reads it that way (Number(null) would be $0)
    const s = settleBet(b, b.legs, { parlay_max_price: rules.parlay_max_price, max_payout: rules.max_payout });
    if (s) { await db.settle(b.id, s.status, s.payout); report.settled++; }
  }

  // the heartbeat, and (once the column exists) what the page should say about each futures market
  await db.updateRules(ready ? { synced_at: iso, fut_status: fut } : { synced_at: iso });
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
