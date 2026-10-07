/* The edge function's sync, driven end to end with saved ESPN responses and an
   in-memory stand-in for the database: lines go up, kickoff closes them, a
   final score grades and settles the bets, and the live delay accepts or
   refuses. The adapter mimics what the SQL functions do; the SQL itself is
   covered by casino-sql.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSync, ESPN_SB, propsUrl } from '../supabase/functions/_shared/sync.mjs';

const board = JSON.parse(readFileSync(new URL('./fixtures/espn-scoreboard-w5.json', import.meta.url), 'utf8'));
const props = JSON.parse(readFileSync(new URL('./fixtures/espn-props.json', import.meta.url), 'utf8'));
const positions = JSON.parse(readFileSync(new URL('../positions.json', import.meta.url), 'utf8'));

const RULES = { season_start: '2026-09-09', live_enabled: false, live_delay_sec: 45, live_tolerance: 0.05,
  pending_timeout_sec: 300, prop_american: -115, fantasy_hold: 0.045, parlay_max_price: 21,
  max_payout: 1000, props_synced: {}, fantasy_synced_at: null,
  // the columns supabase-setup.sql adds for college and futures (a test below takes them away again)
  fut_status: {}, cprops_synced: {}, cfb_fd_events: {} };

function memoryDb(rules = {}) {
  const db = { rules: { ...RULES, ...rules }, lines: new Map(), bets: [], legs: [], calls: [], games: new Map() };
  const ofEvent = (ev, sports) => [...db.lines.values()].filter(l => l.event === ev && sports.includes(l.sport));
  db.adapter = {
    rules: async () => ({ ...db.rules }),
    updateRules: async p => Object.assign(db.rules, p),
    linesForEvents: async (evs, sport = 'nfl') => [...db.lines.values()].filter(l => l.sport === sport && evs.includes(l.event)),
    closeStarted: async iso => { for (const l of db.lines.values()) if (l.state === 'pre' && l.commence_at <= iso) l.status = 'closed'; },
    closeEvent: async (ev, state, sports) => { for (const l of ofEvent(ev, sports)) Object.assign(l, { status: 'closed', state }); },
    suspendMissing: async (ev, sport, keep) => { for (const l of ofEvent(ev, [sport])) if (l.status === 'open' && !keep.includes(l.id)) l.status = 'suspended'; },
    closeMissing: async (ev, sport, keep) => { for (const l of ofEvent(ev, [sport])) if (l.status !== 'closed' && !keep.includes(l.id)) l.status = 'closed'; },
    closeMissingLike: async (prefix, sport, keep) => { for (const l of db.lines.values())
      if (l.sport === sport && l.event.startsWith(prefix) && l.status !== 'closed' && !keep.includes(l.id)) l.status = 'closed'; },
    upsertLines: async rows => { for (const r of rows) db.lines.set(r.id, { ...db.lines.get(r.id), ...r }); },
    openLegs: async () => db.legs.filter(g => !g.result && db.bets.find(b => b.id === g.bet_id).status === 'open')
      .map(g => ({ ...g, line: db.lines.get(g.line_id) })),
    setOutcomes: async list => { for (const { id, outcome } of list) Object.assign(db.lines.get(id), { outcome, status: 'closed' }); },
    games: async () => [...db.games.values()],
    setGames: async rows => { for (const r of rows) db.games.set(r.event, { ...r }); db.calls.push(['setGames', rows.length]); },
    setLive: async rows => { for (const { id, live } of rows) db.lines.get(id).live = live; db.calls.push(['setLive', rows.length]); },
    gradeLegs: async list => { for (const { bet, line, result } of list) db.legs.find(g => g.bet_id === bet && g.line_id === line).result = result; },
    pendingBets: async () => db.bets.filter(b => b.status === 'pending').map(b => ({
      bet: b, legs: db.legs.filter(g => g.bet_id === b.id), lines: Object.fromEntries(db.lines) })),
    resolve: async (id, accept, note) => { const b = db.bets.find(x => x.id === id); b.status = accept ? 'open' : 'rejected'; b.note = note; db.calls.push(['resolve', id, accept, note]); },
    openBets: async () => db.bets.filter(b => b.status === 'open').map(b => ({ ...b, legs: db.legs.filter(g => g.bet_id === b.id) })),
    settle: async (id, status, payout) => { const b = db.bets.find(x => x.id === id); b.status = status; b.payout = payout; db.calls.push(['settle', id, status, payout]); },
  };
  db.place = (id, lineIds, stake, status = 'open', placed_at = '2026-10-06T16:00:00Z') => {
    const ls = lineIds.map(i => db.lines.get(i));
    db.bets.push({ id, kind: ls.length > 1 ? 'parlay' : 'straight', stake, status, placed_at });
    for (const l of ls) db.legs.push({ bet_id: id, line_id: l.id, price: l.price, point: l.point, score_at: l.score, result: null });
  };
  return db;
}

// Sleeper and ESPN, answered from fixtures. Starters are real ids with projections.
const ids = Object.keys(positions.teams).filter(id => ['QB', 'RB', 'WR', 'TE'].includes(positions.positions[id]));
const matchups = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, matchup_id: Math.ceil((i + 1) / 2), points: 0,
  starters: ids.slice(i * 9, i * 9 + 9), players_points: {} }));
const proj = Object.fromEntries(ids.slice(0, 120).map((id, i) => [id, { rec: 4, rec_yd: 40 + (i % 9) * 5 }]));
function web(sb, extra = {}) {
  const espn = {};
  for (const it of props.items) { const a = it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1]; if (a) espn[a] = { id: `S${a}`, name: `Player ${a}`, team: 'DAL' }; }
  return async url => {
    if (url in extra) return extra[url];
    if (url === ESPN_SB) return sb;
    if (url.startsWith(ESPN_SB)) return null;
    if (url.includes('/propBets')) return props;
    if (url.endsWith('/espn.json')) return { players: espn };
    if (url.endsWith('/positions.json')) return positions;
    if (url.endsWith('/state/nfl')) return { season: '2026', season_start_date: '2026-09-09' };
    if (url.endsWith('/league/1312128506452283392')) return { scoring_settings: { rec: 0.5, rec_yd: 0.1 } };
    if (url.includes('/matchups/')) return matchups;
    if (url.includes('/projections/')) return proj;
    return null;
  };
}
const TUE = Date.parse('2026-10-06T16:00:00Z');
const w5 = () => ({ ...structuredClone(board), season: { type: 2 }, week: { number: 5 } });

test('a pregame sync posts game lines, a few games of props, and WCXC matchups locked at the first kickoff', async () => {
  const db = memoryDb();
  const r = await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const lines = [...db.lines.values()];
  assert.equal(lines.filter(l => l.sport === 'nfl').length, 24, 'six sides for each of four games');
  assert.ok(lines.filter(l => l.sport === 'nfl').every(l => l.status === 'open' && l.updated_at === new Date(TUE).toISOString()));
  assert.equal(r.props.length, 4);
  assert.ok(lines.some(l => l.sport === 'prop'));
  const fan = lines.filter(l => l.sport === 'fantasy');
  assert.equal(fan.length, 24, 'six matchups: two moneyline sides and two total sides each, no spreads');
  assert.ok(!fan.some(l => l.market === 'spread'));
  const first = Math.min(...board.events.map(e => Date.parse(e.competitions[0].date)));
  assert.ok(fan.every(l => Date.parse(l.commence_at) === first), 'fantasy betting shuts at the first kickoff of the week');
  assert.ok(db.rules.fantasy_synced_at && Object.keys(db.rules.props_synced).length === 4);

  // a minute later nothing is due: props and fantasy wait out their ten minutes
  const again = await runSync({ db: db.adapter, get: web(w5()), now: TUE + 60000 });
  assert.deepEqual(again.props, []);
  assert.equal(again.fantasy, 0);
});

test('kickoff closes a game and its props; a final score grades and settles every bet on it', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const ev = board.events[0].id;
  db.place(1, [`nfl:${ev}:ml:home`], 40);                                    // DAL -470
  db.place(2, [`nfl:${ev}:spread:away`], 10);                                // TB +9.5
  const other = board.events[1].id;
  db.place(3, [`nfl:${ev}:total:over`, `nfl:${other}:ml:away`], 5);          // parlay, other leg unplayed

  const live = w5();
  const c = live.events[0].competitions[0];
  c.status.type = { state: 'in', completed: false };
  const kick = Date.parse(c.date) + 600000;
  await runSync({ db: db.adapter, get: web(live), now: kick });
  assert.ok([...db.lines.values()].filter(l => l.event === `nfl:${ev}`).every(l => l.status === 'closed'),
    'with live betting off, a game in progress takes no bets on any market');

  const fin = w5();
  const f = fin.events[0].competitions[0];
  f.status.type = { state: 'post', completed: true };
  f.competitors.find(x => x.homeAway === 'home').score = '27';
  f.competitors.find(x => x.homeAway === 'away').score = '20';
  const r = await runSync({ db: db.adapter, get: web(fin), now: kick + 4 * 3600000 });
  assert.equal(r.outcomes, 3, 'only lines somebody bet get an outcome; the unplayed game gets none');
  const settled = Object.fromEntries(db.calls.filter(x => x[0] === 'settle').map(x => [x[1], x]));
  assert.deepEqual(settled[1], ['settle', 1, 'won', 48.51]);
  assert.deepEqual(settled[2], ['settle', 2, 'won', 18.7], 'TB +9.5 at -115 covers a seven-point loss');
  assert.equal(db.legs.find(g => g.bet_id === 3 && g.line_id.endsWith('total:over')).result, 'loss', '27 + 20 is under 47.5');
  assert.deepEqual(settled[3], ['settle', 3, 'lost', 0], 'a parlay is lost the moment one leg loses');
  assert.equal(db.legs.find(g => g.bet_id === 3 && g.line_id.endsWith('ml:away')).result, null);
});

test('with live betting on, a live bet is accepted only if the next refresh shows the same game', async () => {
  const db = memoryDb({ live_enabled: true });
  const live = w5();
  const c = live.events[0].competitions[0];
  c.status.type = { state: 'in', completed: false };
  c.situation = { possession: '6' };
  const t0 = Date.parse(c.date) + 1800000;
  await runSync({ db: db.adapter, get: web(live), now: t0 });
  const ev = board.events[0].id, id = `nfl:${ev}:ml:home`;
  assert.equal(db.lines.get(id).state, 'in');
  // first in-game sync: the score snapshot changed from pregame, so it waits for the book
  db.lines.get(id).status = 'open';
  db.place(7, [id], 10, 'pending', new Date(t0 + 5000).toISOString());
  db.place(8, [id], 10, 'pending', new Date(t0 + 5000).toISOString());

  await runSync({ db: db.adapter, get: web(live), now: t0 + 20000 });
  assert.equal(db.bets.find(b => b.id === 7).status, 'pending', 'still inside the delay');

  await runSync({ db: db.adapter, get: web(live), now: t0 + 60000 });
  assert.equal(db.bets.find(b => b.id === 7).status, 'open', 'same score, same price, fresher line: accepted');

  // a touchdown lands before bet 9's delay is up and DraftKings hasn't repriced
  db.place(9, [id], 10, 'pending', new Date(t0 + 61000).toISOString());
  const td = structuredClone(live);
  td.events[0].competitions[0].competitors.find(x => x.homeAway === 'home').score = '7';
  await runSync({ db: db.adapter, get: web(td), now: t0 + 120000 });
  assert.equal(db.lines.get(id).status, 'suspended', 'score moved, price did not: the line shuts');
  assert.equal(db.bets.find(b => b.id === 9).status, 'rejected');
});

test('the WCXC total is calibrated to what teams actually scored in finished weeks, measured once a day', async () => {
  const db = memoryDb({ fantasy_scale: 1, fantasy_scale_at: null });
  // weeks 1-4 are final; each team scored 80% of what the same model projected for it
  const { fantasyPairs } = await import('../supabase/functions/_shared/casino.mjs');
  const scoring = { rec: 0.5, rec_yd: 0.1 };
  const raw = fantasyPairs({ matchups: matchups.map(m => ({ ...m, points: 0 })), proj, positions: positions.positions, teams: positions.teams, scoring });
  const projected = Object.fromEntries(raw.flatMap(p => p.sides.map(x => [x.team, x.proj])));
  const finished = matchups.map(m => ({ ...m, points: projected[m.roster_id] * 0.8 }));
  const extra = {};
  for (const w of [1, 2, 3, 4]) {
    extra['https://api.sleeper.app/scores/nfl/regular/2026/' + w] = [{ status: 'complete', metadata: {} }];
    extra['https://api.sleeper.app/v1/league/1312128506452283392/matchups/' + w] = finished;
  }
  await runSync({ db: db.adapter, get: web(w5(), extra), now: TUE });
  assert.ok(Math.abs(db.rules.fantasy_scale - 0.8) < 0.001, 'measured from results: ' + db.rules.fantasy_scale);
  assert.equal(db.rules.fantasy_scale_weeks, 4);
  const pair = raw.find(p => p.matchup === 1);
  assert.equal(db.lines.get('fan:2026:5:1:total:over').point, Math.floor(db.rules.fantasy_scale * pair.total) + 0.5,
    'the total is the calibrated projection');
  const before = db.lines.get('fan:2026:5:1:ml:' + pair.teams[0]).price;

  // eleven minutes later the lines reprice, but the old weeks are not refetched
  let pulls = 0;
  const base = web(w5(), extra);
  const spy = async u => { if (u.includes('/scores/')) pulls++; return base(u); };
  await runSync({ db: db.adapter, get: spy, now: TUE + 11 * 60000 });
  assert.equal(pulls, 0, 'calibration is daily, not every run');
  assert.equal(db.lines.get('fan:2026:5:1:ml:' + pair.teams[0]).price, before, 'and moneylines do not depend on it');
});

test('a WCXC market that is no longer offered stops taking bets at once', async () => {
  const db = memoryDb();
  db.lines.set('fan:2026:5:1:spread:1', { id: 'fan:2026:5:1:spread:1', event: 'fan:2026:5:1', sport: 'fantasy', status: 'open', state: 'pre' });
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  assert.equal(db.lines.get('fan:2026:5:1:spread:1').status, 'suspended', 'a spread left over from before is pulled');
});

test('every game line and prop the sync writes carries its simulation, the same from one run to the next', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const nfl = [...db.lines.values()].filter(l => l.sport === 'nfl'), props = [...db.lines.values()].filter(l => l.sport === 'prop');
  assert.ok(nfl.length && props.length);
  for (const l of [...nfl, ...props]) assert.match(l.sim, /^\\x[0-9a-f]{1024}$/, l.id + ' has 4096 simulated games');
  assert.ok([...db.lines.values()].filter(l => l.sport === 'fantasy').every(l => !l.sim), 'WCXC matchups are one leg each: no simulation');
  const before = Object.fromEntries([...nfl, ...props].map(l => [l.id, l.sim]));
  await runSync({ db: db.adapter, get: web(w5()), now: TUE + 60000 });
  for (const l of nfl) assert.equal(db.lines.get(l.id).sim, before[l.id], 'same lines, same seeds, same simulated games');
});

/* ---------- FanDuel as the props source ---------- */
const fdFix = JSON.parse(readFileSync(new URL('./fixtures/fanduel-tbdal.json', import.meta.url), 'utf8'));
const fdPageFix = JSON.parse(readFileSync(new URL('./fixtures/fanduel-nfl-page.json', import.meta.url), 'utf8'));
const espnPlayers = { players: {
  4241389: { id: '6786', name: 'CeeDee Lamb', team: 'DAL' }, 2577417: { id: '3294', name: 'Dak Prescott', team: 'DAL' },
  4426354: { id: '8137', name: 'George Pickens', team: 'DAL' }, 4361579: { id: '7588', name: 'Javonte Williams', team: 'DAL' },
  4596448: { id: '11584', name: 'Bucky Irving', team: 'TB' }, 3116165: { id: '4037', name: 'Chris Godwin', team: 'TB' } } };
const fdWeb = (sb, extra = {}) => {
  const base = web(sb, extra);
  return async url => {
    if (url in extra) return extra[url];
    if (url.endsWith('/espn.json')) return espnPlayers;
    if (url.includes('content-managed-page')) return fdPageFix;
    if (url.includes('event-page') && url.includes('eventId=' + fdFix.eventId)) return { attachments: { markets: fdFix.attachments.markets } };
    return base(url);
  };
};

test('props come from FanDuel at real prices when it has the game, and ESPN at -115 when it does not', async () => {
  const db = memoryDb();
  const r = await runSync({ db: db.adapter, get: fdWeb(w5()), now: TUE });
  const ev = board.events[0].id;
  assert.equal(r.fanduel, 'ok');
  assert.ok(r.props.includes(ev + ':fanduel'), 'TB @ DAL is priced by FanDuel: ' + r.props.join(' '));
  assert.ok(r.props.some(p => p.endsWith(':espn')), 'games FanDuel has not got fall back to ESPN');
  const fd = [...db.lines.values()].filter(l => l.event === 'nfl:' + ev && l.sport === 'prop');
  assert.ok(fd.length && fd.every(l => /:s\d+:/.test(l.id)), 'FanDuel lines are keyed by Sleeper id');
  assert.ok(fd.some(l => l.market === 'atd') && fd.some(l => /:ms\d+$/.test(l.id)), 'touchdown scorers and milestones');
  assert.ok(fd.some(l => l.american !== -115), 'real prices');
  assert.equal(db.rules.fd_events[ev], String(fdFix.eventId), 'the match is remembered for the hour');

  // FanDuel unreachable: everything falls back, nothing breaks
  const db2 = memoryDb();
  const r2 = await runSync({ db: db2.adapter, get: web(w5()), now: TUE });
  assert.equal(r2.fanduel, 'unreachable');
  assert.ok(r2.props.every(p => p.endsWith(':espn')));
});

test('lines FanDuel replaces are closed, not left suspended in the drawer', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });            // FanDuel unreachable: ESPN lines at -115
  const ev = 'nfl:' + board.events[0].id;
  const old = [...db.lines.values()].filter(l => l.event === ev && l.sport === 'prop');
  assert.ok(old.length && old.every(l => !/:s\d+:/.test(l.id)));
  db.rules.props_synced = {}; db.rules.fd_events_at = null;
  await runSync({ db: db.adapter, get: fdWeb(w5()), now: TUE + 60000 });   // FanDuel answers
  for (const l of old) assert.equal(db.lines.get(l.id).status, 'closed', l.id);
  assert.ok([...db.lines.values()].some(l => l.event === ev && l.sport === 'prop' && l.status === 'open' && /:s\d+:/.test(l.id)));
});

test('first and last touchdown scorer settle from ESPN\'s scoring plays, by athlete id', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: fdWeb(w5()), now: TUE });
  const ev = board.events[0].id;
  const ltd = [...db.lines.values()].find(l => l.event === 'nfl:' + ev && l.market === 'ltd' && l.player === '6786');
  assert.ok(ltd, 'CeeDee Lamb last TD is offered');
  db.place(1, [ltd.id], 10);
  const fin = w5();
  const c = fin.events[0].competitions[0];
  c.status.type = { state: 'post', completed: true };
  const extra = {
    ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + ev]:
      { scoringPlays: [{ id: 'a', scoringType: { name: 'touchdown' } }, { id: 'b', scoringType: { name: 'touchdown' } }] },
    [`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${ev}/competitions/${ev}/plays/a`]:
      { participants: [{ type: 'scorer', athlete: { $ref: 'x/athletes/3116165' } }] },
    [`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${ev}/competitions/${ev}/plays/b`]:
      { participants: [{ type: 'passer', athlete: { $ref: 'x/athletes/2577417' } }, { type: 'scorer', athlete: { $ref: 'x/athletes/4241389' } }] },
    'https://api.sleeper.app/v1/stats/nfl/regular/2026/5': { 6786: { gp: 1, rec_td: 1 } },
  };
  await runSync({ db: db.adapter, get: fdWeb(fin, extra), now: Date.parse(c.date) + 5 * 3600000 });
  assert.deepEqual(db.lines.get(ltd.id).outcome, { played: true, scorer: '6786' });
  assert.deepEqual(db.calls.find(x => x[0] === 'settle' && x[1] === 1), ['settle', 1, 'won', Math.round(10 * ltd.price * 100) / 100]);
});

/* ---- the scoreboards behind the tickets ---- */

test('every game on the slate gets a scoreboard row, and a quiet minute rewrites none of them', async () => {
  const db = memoryDb();
  const r = await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  assert.equal(db.games.size, 4 + 6, 'four NFL games and six WCXC matchups');
  assert.equal(r.games, 10);
  const g = db.games.get(`nfl:${board.events[0].id}`);
  assert.equal(g.state, 'pre');
  assert.equal(g.away, 'TB');
  assert.equal(g.home, 'DAL');
  assert.equal(g.away_score, null, 'nothing has been scored before kickoff');
  assert.equal(g.away_periods, null);
  assert.equal(g.detail, '');
  const fan = [...db.games.values()].filter(x => x.sport === 'fantasy');
  assert.equal(fan.length, 6);
  assert.ok(fan.every(x => x.state === 'pre' && x.away_periods === null));
  assert.ok(fan.every(x => /^\d+$/.test(x.away) && /^\d+$/.test(x.home)), 'WCXC sides are roster ids');

  // nothing has moved, so nothing is written
  const again = await runSync({ db: db.adapter, get: web(w5()), now: TUE + 60000 });
  assert.equal(again.games, 0);
  assert.equal(db.calls.filter(c => c[0] === 'setGames').length, 1);
});

test('a live game carries its clock, down and distance, possession and quarter scores', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const ev = board.events[0].id;
  const live = w5(), c = live.events[0].competitions[0];
  c.status = { period: 3, displayClock: '3:22', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } };
  c.situation = { possession: c.competitors.find(x => x.homeAway === 'away').team.id, downDistanceText: '1st & 10 at DAL 27' };
  c.competitors.find(x => x.homeAway === 'home').score = '27';
  c.competitors.find(x => x.homeAway === 'away').score = '16';
  c.competitors.find(x => x.homeAway === 'home').linescores = [{ value: 3 }, { value: 13 }, { value: 11 }];
  c.competitors.find(x => x.homeAway === 'away').linescores = [{ value: 7 }, { value: 9 }, { value: 0 }];
  const r = await runSync({ db: db.adapter, get: web(live), now: Date.parse(c.date) + 600000 });
  const g = db.games.get(`nfl:${ev}`);
  assert.equal(g.state, 'in');
  assert.equal(g.detail, 'Q3 3:22');
  assert.equal(g.situation, '1st & 10 at DAL 27');
  assert.equal(g.possession, 'away');
  assert.equal(g.home_score, 27);
  assert.equal(g.away_score, 16);
  assert.deepEqual(g.home_periods, [3, 13, 11]);
  assert.deepEqual(g.away_periods, [7, 9, 0]);
  assert.ok(r.games >= 1);

  // and the same game final says so in ESPN's own words
  const fin = w5(), f = fin.events[0].competitions[0];
  f.status = { period: 4, displayClock: '0:00', type: { state: 'post', completed: true, name: 'STATUS_FINAL', shortDetail: 'Final/OT' } };
  f.competitors.find(x => x.homeAway === 'home').score = '30';
  f.competitors.find(x => x.homeAway === 'away').score = '27';
  await runSync({ db: db.adapter, get: web(fin), now: Date.parse(c.date) + 4 * 3600000 });
  const done = db.games.get(`nfl:${ev}`);
  assert.equal(done.state, 'post');
  assert.equal(done.detail, 'Final/OT');
  assert.equal(done.possession, null, 'nobody has the ball once it is over');
});

test("a prop's running number is filled only for props somebody holds, once the game is under way", async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const prop = [...db.lines.values()].find(l => l.sport === 'prop' && l.market === 'rec_yd');
  assert.ok(prop, 'the fixture offers a receiving-yards prop');
  const stats = { [prop.player]: { gp: 1, rec_yd: 18, rec: 2, rec_td: 1 } };
  const statsUrl = 'https://api.sleeper.app/v1/stats/nfl/regular/2026/5';

  // nobody holds it: the half-megabyte stats file is never pulled
  let asked = false;
  const spy = u => { if (u === statsUrl) asked = true; return web(w5(), { [statsUrl]: stats })(u); };
  const quiet = await runSync({ db: db.adapter, get: spy, now: TUE + 60000 });
  assert.equal(quiet.live, 0);
  assert.equal(asked, false);

  // now somebody does, and the game has started
  db.place(9, [prop.id], 5);
  const live = w5(), c = live.events.find(e => `nfl:${e.id}` === prop.event).competitions[0];
  c.status = { period: 2, displayClock: '8:00', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } };
  const r = await runSync({ db: db.adapter, get: web(live, { [statsUrl]: stats }), now: Date.parse(prop.commence_at) + 600000 });
  assert.equal(r.live, 1);
  assert.equal(db.lines.get(prop.id).live, 18);
  assert.equal(db.lines.get(prop.id).outcome, undefined, 'a running number is not an outcome');
});

/* A scoreboard row moving is what tells open pages (realtime on casino_games) to
   look again. If the prop's running number were written after it, the page would
   read at the moment the clock changed and find last minute's yardage. */
test("a prop's running number is written before the scoreboard row that tells open pages to look again", async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const prop = [...db.lines.values()].find(l => l.sport === 'prop' && l.market === 'rec_yd');
  const statsUrl = 'https://api.sleeper.app/v1/stats/nfl/regular/2026/5';
  db.place(9, [prop.id], 5);
  const live = w5(), c = live.events.find(e => `nfl:${e.id}` === prop.event).competitions[0];
  c.status = { period: 2, displayClock: '8:00', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } };
  db.calls.length = 0;
  const r = await runSync({ db: db.adapter, get: web(live, { [statsUrl]: { [prop.player]: { gp: 1, rec_yd: 31, rec: 3 } } }), now: Date.parse(prop.commence_at) + 600000 });
  assert.equal(r.live, 1);
  assert.ok(r.games >= 1);
  assert.deepEqual(db.calls.map(x => x[0]).filter(n => n === 'setLive' || n === 'setGames'), ['setLive', 'setGames']);
});

test('a running number that cannot be written never stops the scoreboard or the money', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const prop = [...db.lines.values()].find(l => l.sport === 'prop' && l.market === 'rec_yd');
  const statsUrl = 'https://api.sleeper.app/v1/stats/nfl/regular/2026/5';
  db.place(9, [prop.id], 5);
  db.adapter.setLive = async () => { throw new Error('function public.casino_set_live does not exist'); };   // an older database
  const live = w5(), c = live.events.find(e => `nfl:${e.id}` === prop.event).competitions[0];
  c.status = { period: 2, displayClock: '8:00', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } };
  const r = await runSync({ db: db.adapter, get: web(live, { [statsUrl]: { [prop.player]: { gp: 1, rec_yd: 31 } } }), now: Date.parse(prop.commence_at) + 600000 });
  assert.match(r.live, /^failed: function public\.casino_set_live/, 'the report says what went wrong');
  assert.equal(r.scoreboard, undefined, 'and the scoreboard section itself did not fail');
  assert.equal(db.games.get(prop.event).state, 'in', 'the scoreboard row still went in');
  assert.equal(db.games.get(prop.event).detail, 'Q2 8:00');
});

test('a WCXC matchup ticks over live, and reads Final only once every NFL game of the week is', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const fan = [...db.games.values()].find(x => x.sport === 'fantasy');
  const scored = matchups.map(m => ({ ...m, points: 100 + m.roster_id }));
  const scoresUrl = 'https://api.sleeper.app/scores/nfl/regular/2026/5';
  const running = [{ status: 'in_game' }, { status: 'complete' }];
  const kick = Date.parse(fan.commence_at) + 3 * 3600000;

  await runSync({ db: db.adapter, get: web(w5(), { [scoresUrl]: running, 'https://api.sleeper.app/v1/league/1312128506452283392/matchups/5': scored }), now: kick });
  const mid = db.games.get(fan.event);
  assert.equal(mid.state, 'in');
  assert.equal(mid.detail, 'Live');
  assert.equal(mid.away_score, 100 + Number(mid.away));
  assert.equal(mid.home_score, 100 + Number(mid.home));

  const over = [{ status: 'complete' }, { status: 'complete' }];
  await runSync({ db: db.adapter, get: web(w5(), { [scoresUrl]: over, 'https://api.sleeper.app/v1/league/1312128506452283392/matchups/5': scored }), now: kick + 3600000 });
  const end = db.games.get(fan.event);
  assert.equal(end.state, 'post');
  assert.equal(end.detail, 'Final');
});

/* The scoreboard is display only, and that has to hold for its FAILURES too.
   Live, the table was added while PostgREST still had a stale schema cache:
   the read threw, and because grading and settlement run after it, bets stopped
   being paid over a cosmetic box. */
test('a broken scoreboard never stops a bet being graded and settled', async () => {
  const db = memoryDb();
  await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  const ev = board.events[0].id;
  db.place(1, [`nfl:${ev}:ml:home`], 40);                                   // DAL -470

  // exactly what a stale schema cache does to the read
  db.adapter.games = async () => { throw new Error("Could not find the table 'public.casino_games' in the schema cache"); };

  const fin = w5(), f = fin.events[0].competitions[0];
  f.status.type = { state: 'post', completed: true };
  f.competitors.find(x => x.homeAway === 'home').score = '27';
  f.competitors.find(x => x.homeAway === 'away').score = '20';
  const r = await runSync({ db: db.adapter, get: web(fin), now: Date.parse(f.date) + 4 * 3600000 });

  assert.match(r.scoreboard, /schema cache/, 'the report says what went wrong');
  assert.equal(r.outcomes, 1, 'and the run still reaches the outcomes');
  assert.deepEqual(db.calls.filter(x => x[0] === 'settle')[0], ['settle', 1, 'won', 48.51],
    'the bet is paid regardless');
});

test('a scoreboard that cannot be written still lets the rest of the run finish', async () => {
  const db = memoryDb();
  db.adapter.setGames = async () => { throw new Error('permission denied for table casino_games'); };
  const r = await runSync({ db: db.adapter, get: web(w5()), now: TUE });
  assert.match(r.scoreboard, /permission denied/);
  assert.ok(r.lines > 0, 'lines still went up');
  assert.equal(db.games.size, 0);
});

/* ================= college football ================= */
import { CFB_SB, CFB_SUMMARY, ESPN_STANDINGS } from '../supabase/functions/_shared/sync.mjs';
import { fdCfbPageUrl, fdPageUrl } from '../supabase/functions/_shared/casino.mjs';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const cfbBoard = fx('espn-cfb-scoreboard.json');
const FRI = Date.parse('2026-10-09T12:00:00Z');              // Georgia @ Alabama kicks off Saturday 7:30 PM ET
const cfbWeb = (extra = {}) => {
  const base = web(w5(), extra);
  return async url => {
    if (url in extra) return extra[url];
    if (url === CFB_SB) return structuredClone(cfbBoard);
    if (url === fdCfbPageUrl()) return fx('fanduel-cfb-page.json');
    if (url.includes('event-page') && url.includes('eventId=35632859')) return fx('fanduel-cfb-ugaala.json');
    if (url.endsWith('/cfb-players.json')) return fx('cfb-players-ugaala.json');
    return base(url);
  };
};

test("college: DraftKings' lines for every game yet to kick off, FanDuel's props where it has them, on a two-minute beat", async () => {
  const db = memoryDb();
  const r = await runSync({ db: db.adapter, get: cfbWeb(), now: FRI });
  const cfb = [...db.lines.values()].filter(l => l.sport === 'cfb');
  // Wednesday's and Thursday's games have kicked off by Friday: nothing on them reopens
  assert.deepEqual([...new Set(cfb.map(l => l.event_label))].sort(), ['Georgia @ Alabama', 'Old Dominion @ App State', 'UConn @ Temple']);
  assert.equal(r.cfb, cfb.length);
  assert.ok(cfb.every(l => l.status === 'open' && l.updated_at === new Date(FRI).toISOString()));
  // props: Georgia @ Alabama is on FanDuel, a day and a half out
  const props = [...db.lines.values()].filter(l => l.sport === 'cprop');
  assert.ok(props.length > 100 && props.every(l => l.event === 'cfb:401856712' && l.status === 'open'));
  assert.equal(props.find(l => l.label === 'Ryan Coleman-Williams').jersey, 1, "his number, off ESPN's roster");
  assert.ok(r.cprops.some(x => x.startsWith('401856712:')), r.cprops.join(' '));
  assert.ok(db.rules.cprops_synced['401856712'].n > 0, 'the page shows a props button only where there are some');
  assert.equal(db.rules.cfb_fd_events['401856712'], '35632859');
  // a minute later the college scoreboard isn't due again
  const again = await runSync({ db: db.adapter, get: cfbWeb(), now: FRI + 60000 });
  assert.equal(again.cfb, null);
  // and ESPN unreachable costs college its refresh, nothing else
  const down = await runSync({ db: memoryDb().adapter, get: cfbWeb({ [CFB_SB]: null }), now: FRI });
  assert.equal(down.cfb, 'unreachable');
  assert.ok(down.lines > 0, 'the NFL board still went up');
});

test('a college bet settles from the box score: the game, a player by ESPN id, one keyed by name, and one who never played', async () => {
  const db = memoryDb();
  const ev = '401862786', start = '2026-10-03T23:00:00Z';     // North Texas 45, Tulsa 44
  const base = { season: 2026, week: 5, event: `cfb:${ev}`, commence_at: start, state: 'pre', score: '', status: 'closed', point: null, team: null, teams: null, outcome: null };
  const add = l => db.lines.set(l.id, { ...base, ...l });
  add({ id: `cfb:${ev}:spread:home`, sport: 'cfb', market: 'spread', side: 'home', point: 1.5, price: 1.9091, label: 'Tulsa', nfl_team: '202' });
  add({ id: `cprop:${ev}:a4827049:rec_yd:over`, sport: 'cprop', market: 'rec_yd', side: 'over', point: 99.5, price: 2.5, label: 'Max Reese', player: '4827049', nfl_team: '249' });
  add({ id: `cprop:${ev}:n-max-reese:rec:over`, sport: 'cprop', market: 'rec', side: 'over', point: 4.5, price: 2, label: 'Max Reese', player: 'n-max-reese', nfl_team: '249' });
  add({ id: `cprop:${ev}:n-nobody-here:atd:yes`, sport: 'cprop', market: 'atd', side: 'yes', point: null, price: 3, label: 'Nobody Here', player: 'n-nobody-here', nfl_team: '249' });
  db.place(1, [`cfb:${ev}:spread:home`], 10);
  db.place(2, [`cprop:${ev}:a4827049:rec_yd:over`], 10);
  db.place(3, [`cprop:${ev}:n-max-reese:rec:over`], 10);
  db.place(4, [`cprop:${ev}:n-nobody-here:atd:yes`], 10);
  const summary = { [`${CFB_SUMMARY}?event=${ev}`]: fx('espn-cfb-summary.json') };

  // during the game: the props' running numbers, from the same box score
  const during = Date.parse(start) + 3600000;
  const live = await runSync({ db: db.adapter, get: cfbWeb(summary), now: during });
  assert.equal(db.lines.get(`cprop:${ev}:a4827049:rec_yd:over`).live, 101);
  assert.equal(db.lines.get(`cprop:${ev}:n-max-reese:rec:over`).live, 5, 'by name, within his team');
  assert.equal(live.settled, 1, 'the game is final, so the spread settles; the props wait for the box score to settle down');
  assert.equal(db.bets.find(b => b.id === 1).status, 'won', 'Tulsa +1.5 in a one-point loss');

  const after = await runSync({ db: db.adapter, get: cfbWeb(summary), now: Date.parse(start) + 5 * 3600000 });
  assert.equal(after.settled, 3);
  assert.deepEqual(db.bets.map(b => [b.id, b.status, b.payout]), [[1, 'won', 19.09], [2, 'won', 25], [3, 'won', 20], [4, 'void', 10]]);
});

/* ================= futures ================= */

const forecast = (o = {}) => ({ modelVersion: 3, leagueId: '1312128506452283392', season: 2026, sims: 10000, firstOpen: 5, lastRegular: 14,
  generated: '2026-10-06T10:20:00Z', rows: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: [0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.03, 0.02, 0.006, 0.003, 0.001][i],
    po: [0.99, 0.95, 0.9, 0.75, 0.6, 0.55, 0.5, 0.3, 0.2, 0.15, 0.08, 0.03][i], div: [0.8, 0.6, 0.55, 0.15, 0.3, 0.3, 0.05, 0.1, 0.15, 0.0, 0.0, 0.0][i] })), ...o });
const sleeperRosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, settings: { division: (i % 3) + 1, wins: 0, losses: 0 } }));
const wcxcWeb = (odds, extra = {}) => web(w5(), {
  'https://wcxcdynasty.site/odds.json': odds,
  'https://api.sleeper.app/v1/league/1312128506452283392/rosters': sleeperRosters,
  'https://api.sleeper.app/v1/league/1312128506452283392': { scoring_settings: { rec: 0.5, rec_yd: 0.1 },
    metadata: { division_1: 'Uher’s Most Hated', division_2: 'Loughman’s Fog', division_3: 'Ali’s Children' } },
  ...extra });

test("WCXC futures are open from the forecast's morning rebuild until the week's first kickoff, at its prices", async () => {
  const db = memoryDb();
  const first = Math.min(...board.events.map(e => Date.parse(e.competitions[0].date)));
  const r = await runSync({ db: db.adapter, get: wcxcWeb(forecast()), now: TUE });
  const fut = [...db.lines.values()].filter(l => l.event.startsWith('fut:wcxc:'));
  assert.ok(fut.length > 30 && fut.every(l => l.status === 'open' && Date.parse(l.commence_at) === first), 'they shut when the week kicks off');
  assert.equal(r.futures.wcxc, fut.length);
  assert.deepEqual(db.rules.fut_status.wcxc, { open: true, until: new Date(first).toISOString(), built: '2026-10-06T10:20:00Z' });
  assert.ok(fut.some(l => l.event === 'fut:wcxc:2026:div:1' && l.event_label === 'Uher’s Most Hated'));
  // kickoff: every one of them closes, and the page is told why
  const live = w5(); live.events[0].competitions[0].status.type = { state: 'in', completed: false };
  await runSync({ db: db.adapter, get: wcxcWeb(forecast(), { [ESPN_SB]: live }), now: first + 60000 });
  assert.ok([...db.lines.values()].filter(l => l.event.startsWith('fut:wcxc:')).every(l => l.status === 'closed'));
  assert.deepEqual(db.rules.fut_status.wcxc, { open: false, why: 'games' });
  // a forecast from before the bracket fix, or from another season, prices nothing
  for (const [odds, why] of [[forecast({ modelVersion: 2 }), 'stale'], [forecast({ season: 2025 }), 'stale'],
    [forecast({ generated: '2026-09-01T10:00:00Z' }), 'stale'], [forecast({ firstOpen: 15 }), 'season']]) {
    const d = memoryDb();
    await runSync({ db: d.adapter, get: wcxcWeb(odds), now: TUE });
    assert.equal([...d.lines.values()].filter(l => l.sport === 'future').length, 0, JSON.stringify(odds).slice(0, 60));
    assert.deepEqual(d.rules.fut_status.wcxc, { open: false, why });
  }
});

const nflFutPage = () => ({ attachments: { events: fdPageFix.attachments.events, markets: fx('fanduel-nfl-futures.json').attachments.markets } });
test("NFL futures are FanDuel's prices while no game is on: closed for the games, reopened at the new prices after", async () => {
  const db = memoryDb();
  const nfl = () => [...db.lines.values()].filter(l => l.event.startsWith('fut:nfl:'));
  const page = { [fdPageUrl()]: nflFutPage() };
  const first = Math.min(...board.events.map(e => Date.parse(e.competitions[0].date)));
  const r = await runSync({ db: db.adapter, get: web(w5(), page), now: TUE });
  assert.ok(nfl().length > 90 && nfl().every(l => l.status === 'open' && Date.parse(l.commence_at) === first));
  assert.equal(r.futures.nfl, nfl().length);
  // the earliest game under way: all of them shut
  const at = board.events.map(e => Date.parse(e.competitions[0].date)), i0 = at.indexOf(first);
  const live = w5(); live.events[i0].competitions[0].status.type = { state: 'in', completed: false };
  await runSync({ db: db.adapter, get: web(live, page), now: first + 60000 });
  assert.ok(nfl().every(l => l.status === 'closed'));
  assert.deepEqual(db.rules.fut_status.nfl, { open: false, why: 'games' });
  // that game over, nothing else on: back at once, closing at the next kickoff
  const done = w5(); done.events[i0].competitions[0].status.type = { state: 'post', completed: true };
  const next = Math.min(...at.filter((_, i) => i !== i0));
  await runSync({ db: db.adapter, get: web(done, page), now: first + 4 * 3600000 });
  assert.ok(nfl().every(l => l.status === 'open' && Date.parse(l.commence_at) === next));
  assert.equal(db.rules.fut_status.nfl.open, true);
});

test('futures settle when their question is answered, and the bets on them are paid', async () => {
  const db = memoryDb();
  const fut = (id, event, market, side, price, o = {}) => db.lines.set(id, { id, event, market, side, price, sport: 'future', season: 2026, week: 5,
    commence_at: '2026-10-09T00:15:00Z', state: 'pre', status: 'closed', point: null, outcome: null, team: null, label: '', ...o });
  fut('fut:wcxc:2026:title:1', 'fut:wcxc:2026:title', 'title', '1', 3, { team: 1 });
  fut('fut:wcxc:2026:title:5', 'fut:wcxc:2026:title', 'title', '5', 6, { team: 5 });
  fut('fut:wcxc:2026:po:2:yes', 'fut:wcxc:2026:po:2', 'po', 'yes', 1.5, { team: 2 });
  fut('fut:wcxc:2026:po:3:yes', 'fut:wcxc:2026:po:3', 'po', 'yes', 2, { team: 3 });
  fut('fut:wcxc:2026:div:3:7', 'fut:wcxc:2026:div:3', 'div', '7', 2.5, { team: 7 });
  fut('fut:nfl:2026:nflpo:SEA:yes', 'fut:nfl:2026:nflpo:SEA', 'nflpo', 'yes', 1.5, { label: 'SEA' });
  fut('fut:nfl:2026:nflpo:MIA:no', 'fut:nfl:2026:nflpo:MIA', 'nflpo', 'no', 1.2, { label: 'MIA' });
  fut('fut:nfl:2026:sb:SEA', 'fut:nfl:2026:sb', 'sb', 'SEA', 9, { label: 'SEA' });
  fut('fut:nfl:2026:sb:PHI', 'fut:nfl:2026:sb', 'sb', 'PHI', 12, { label: 'PHI' });
  [...db.lines.keys()].forEach((id, i) => db.place(i + 1, [id], 10));
  // the WCXC answers are Sleeper's 2025 season, served as this league's; ESPN's are its 2025 standings and Super Bowl
  const L = 'https://api.sleeper.app/v1/league/1312128506452283392';
  const postseason = { ...w5(), season: { type: 3 }, week: { number: 5 }, events: [] };
  const answers = {
    'https://api.sleeper.app/v1/state/nfl': { season: '2026', season_type: 'post', week: 18, season_start_date: '2026-09-09' },
    [L]: fx('sleeper-2025-league.json'), [`${L}/rosters`]: fx('sleeper-2025-rosters.json'), [`${L}/winners_bracket`]: fx('sleeper-2025-bracket.json'),
    [ESPN_SB]: postseason, [ESPN_STANDINGS]: fx('espn-standings-2025.json'),
    [`${ESPN_SB}?seasontype=3&week=5&dates=2026`]: fx('espn-superbowl-2025.json'),
  };
  const r = await runSync({ db: db.adapter, get: web(w5(), answers), now: Date.parse('2027-02-10T12:00:00Z') });
  assert.equal(r.futures.settle, 'ok');
  const status = Object.fromEntries(db.bets.map(b => [db.legs.find(g => g.bet_id === b.id).line_id, [b.status, b.payout]]));
  assert.deepEqual(status, {
    'fut:wcxc:2026:title:1': ['won', 30], 'fut:wcxc:2026:title:5': ['lost', 0],
    'fut:wcxc:2026:po:2:yes': ['won', 15], 'fut:wcxc:2026:po:3:yes': ['lost', 0], 'fut:wcxc:2026:div:3:7': ['won', 25],
    'fut:nfl:2026:nflpo:SEA:yes': ['won', 15], 'fut:nfl:2026:nflpo:MIA:no': ['won', 12],
    'fut:nfl:2026:sb:SEA': ['won', 90], 'fut:nfl:2026:sb:PHI': ['lost', 0],
  });
  // and a mid-season bracket settles none of the WCXC ones
  const early = memoryDb();
  for (const [id, l] of db.lines) if (id.startsWith('fut:wcxc:')) early.lines.set(id, { ...l, outcome: null });
  [...early.lines.keys()].forEach((id, i) => early.place(i + 1, [id], 10));
  const r2 = await runSync({ db: early.adapter, get: web(w5(), { ...answers,
    'https://api.sleeper.app/v1/state/nfl': { season: '2026', season_type: 'regular', week: 14, season_start_date: '2026-09-09' },
    [L]: fx('sleeper-2026-league-w5.json'), [`${L}/winners_bracket`]: fx('sleeper-2026-bracket-w5.json') }), now: TUE });
  assert.equal(r2.futures.settle, 'regular season not over');
  assert.ok(early.bets.every(b => b.status === 'open'));
});

test('before supabase-setup.sql is re-run, college and futures wait, and the NFL board and the money carry on', async () => {
  const db = memoryDb();
  for (const k of ['fut_status', 'cprops_synced', 'cfb_fd_events']) delete db.rules[k];
  // a database from before college and futures refuses their rows, as its sport check would
  const refuse = upsert => async rows => {
    if (rows.some(r => ['cfb', 'cprop', 'future'].includes(r.sport))) throw new Error('new row violates check constraint "casino_lines_sport_check"');
    return upsert(rows);
  };
  db.adapter.upsertLines = refuse(db.adapter.upsertLines);
  const asked = [], web = cfbWeb({ 'https://wcxcdynasty.site/odds.json': forecast() });
  const r = await runSync({ db: db.adapter, get: async u => { asked.push(u); return web(u); }, now: TUE });
  assert.equal(r.cfb, 'waiting for supabase-setup.sql');
  assert.equal(r.futures.wcxc, 'waiting for supabase-setup.sql');
  assert.ok(!asked.some(u => u === CFB_SB || u.endsWith('/odds.json')), 'nothing is fetched for them');
  assert.equal([...db.lines.values()].filter(l => l.sport === 'nfl').length, 24, 'the NFL board went up');
  assert.equal(db.rules.synced_at, new Date(TUE).toISOString(), 'the heartbeat still beats');
  assert.ok(!('fut_status' in db.rules), 'without writing a column that is not there');
  // and with the schema in place, a refused college or futures write still can't take the NFL board with it
  const ok = memoryDb();
  ok.adapter.upsertLines = refuse(ok.adapter.upsertLines);
  const r2 = await runSync({ db: ok.adapter, get: cfbWeb({ 'https://wcxcdynasty.site/odds.json': forecast() }), now: FRI });
  assert.match(r2.extra, /check constraint/);
  assert.ok([...ok.lines.values()].some(l => l.sport === 'nfl'));
  assert.ok(![...ok.lines.values()].some(l => ['cfb', 'cprop', 'future'].includes(l.sport)));
});
