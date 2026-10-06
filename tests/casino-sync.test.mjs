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
  max_payout: 1000, props_synced: {}, fantasy_synced_at: null };

function memoryDb(rules = {}) {
  const db = { rules: { ...RULES, ...rules }, lines: new Map(), bets: [], legs: [], calls: [] };
  const ofEvent = (ev, sports) => [...db.lines.values()].filter(l => l.event === ev && sports.includes(l.sport));
  db.adapter = {
    rules: async () => ({ ...db.rules }),
    updateRules: async p => Object.assign(db.rules, p),
    linesForEvents: async evs => [...db.lines.values()].filter(l => l.sport === 'nfl' && evs.includes(l.event)),
    closeStarted: async iso => { for (const l of db.lines.values()) if (l.state === 'pre' && l.commence_at <= iso) l.status = 'closed'; },
    closeEvent: async (ev, state, sports) => { for (const l of ofEvent(ev, sports)) Object.assign(l, { status: 'closed', state }); },
    suspendMissing: async (ev, sport, keep) => { for (const l of ofEvent(ev, [sport])) if (l.status === 'open' && !keep.includes(l.id)) l.status = 'suspended'; },
    upsertLines: async rows => { for (const r of rows) db.lines.set(r.id, { ...db.lines.get(r.id), ...r }); },
    openLegs: async () => db.legs.filter(g => !g.result && db.bets.find(b => b.id === g.bet_id).status === 'open')
      .map(g => ({ ...g, line: db.lines.get(g.line_id) })),
    setOutcomes: async list => { for (const { id, outcome } of list) Object.assign(db.lines.get(id), { outcome, status: 'closed' }); },
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
