/* The Pick 'em page, run for real in a vm with the league data stubbed. Same
   approach as odds-ui: slice the shipped source out of index.html so these are
   assertions about the code that actually ships, with no browser needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const positions = JSON.parse(readFileSync(new URL('../positions.json', import.meta.url), 'utf8'));
const between = (from, to) => {
  const i = html.indexOf(from);
  assert.ok(i > 0, `anchor missing: ${from}`);
  const j = html.indexOf(to, i);
  assert.ok(j > i, `closing anchor missing: ${to}`);
  return html.slice(i, j);
};
// the data layer, then the page
const source = between('async function loadPicks(){', '/* ---------- tally ---------- */')
  + '\n' + between('const picksOpen = () =>', 'function renderPoll(){');

const TEAM_IDS = [1,2,3,4,5,6,7,8,9,10,11,12];
const SCORING = { pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec: 0.5,
  rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5, rec_fd: 1, rush_fd: 1, pass_fd: 0.4 };

// Real player ids, so the position spread is genuinely exercised.
const byPos = {};
for (const [id, pos] of Object.entries(positions.positions)) {
  if (positions.teams[id]) (byPos[pos] ||= []).push(id);
}
// every NFL team a starter could play for, so "is this game over" can be answered
const NFL_TEAMS = [...new Set(Object.values(positions.teams))];
const SLOTS = ['QB','RB','RB','WR','WR','WR','TE','RB','WR','QB'];
const starters = seed => SLOTS.map((pos, i) => byPos[pos][(seed * 7 + i * 13) % byPos[pos].length]);
const PROJ = {};
for (const pos of ['QB','RB','WR','TE']) for (const id of byPos[pos]) {
  PROJ[id] = pos === 'QB' ? { pass_yd: 250, pass_td: 2, pass_fd: 18 }
    : pos === 'RB' ? { rush_yd: 70, rush_td: 0.5, rec: 3, rec_yd: 25, rush_fd: 4 }
    : pos === 'WR' ? { rec: 5, rec_yd: 65, rec_td: 0.4, rec_fd: 4 }
    : { rec: 4, rec_yd: 45, rec_td: 0.3, rec_fd: 3 };
}

function context({ picks = [], week = 4, voter = 5, now = '2026-10-06T14:00:00Z',
  complete = false, matchups = null, fail = false } = {}) {
  let rpc = [], rows = picks.map(p => ({ ...p, season: 2026 })), fetched = [];
  const teams = TEAM_IDS.map(id => ({ id, name: `Team ${id}`, owner: `Manager ${id}`,
    w: 4, l: 2, t: 0, pf: 500, pa: 480, div: 1 }));
  const T = Object.fromEntries(teams.map(t => [t.id, t]));
  const mus = matchups || TEAM_IDS.map(id => ({ roster_id: id, matchup_id: Math.ceil(id / 2),
    points: complete ? (id % 2 ? 130 + id : 100 + id) : 0,
    starters: starters(id), players_points: {} }));
  const ctx = vm.createContext({
    console, Math, Date, Number, Object, Array, Set, JSON, String, isNaN, parseInt, parseFloat,
    TEAMS: teams, T, SEASON: 2026, LEAGUE_ID: 'LG', SCORING, configured: true,
    SHORT_NAMES: Object.fromEntries(TEAM_IDS.map(id => [id, `T${id}`])),
    S: { tab: 'picks', pickWeek: week, voter, pick: {}, picks: [], picksLoaded: false,
      pickSaving: false, pickMsg: null, pickLoadedFor: null, ballots: [], ranked: [], article: null },
    CM: { draft: '' },
    main: { innerHTML: '', querySelectorAll: () => [] },
    SCHED: complete ? { byWeek: { [week]: Object.fromEntries(TEAM_IDS.map(id =>
      [id, { pf: id % 2 ? 130 + id : 100 + id, pa: id % 2 ? 100 + id + 1 : 130 + id - 1,
             opp: id % 2 ? id + 1 : id - 1 }])) } } : null,
    // pairs are (1,2) (3,4) ... so the odd id always wins when `complete`
    esc: x => String(x), img: () => '', banner: () => '', header: (a, b = '') => `${a}${b}`,
    humanMins: () => '2h 0m', minsToFlip: () => 120, latestWeek: () => week,
    windowOpen: () => { const d = new Date(now).getUTCDay(), h = new Date(now).getUTCHours() - 4;
      return d === 2 || d === 3 || (d === 4 && h < 20); },
    ballotWeek: () => week, loadSchedule: async () => ctx.SCHED, render: () => {},
    busyComposing: () => false,
    document: { getElementById: id => ctx.__els[id] || null },
    sb: { from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }),
      rpc: async (name, args) => { rpc.push({ name, args });
        if (args.p_password === 'wrongpw') return { data: null, error: { message: 'Wrong password for this team.' } };
        rows = rows.filter(r => !(r.week === args.p_week && r.voter === args.p_voter));
        rows.push({ season: 2026, week: args.p_week, voter: args.p_voter, picks: args.p_picks,
          updated_at: '2026-10-06T15:00:00Z' });
        return { data: 'saved', error: null }; } },
    fetch: async url => { const u = String(url); fetched.push(u);
      const j = d => ({ ok: true, json: async () => d });
      if (u === 'positions.json') return j(positions);
      if (/\/matchups\//.test(u)) return fail ? { ok: false } : j(mus);
      if (/\/projections\//.test(u)) return j(PROJ);
      if (/\/scores\//.test(u)) return j(NFL_TEAMS.map(t => ({
        status: complete ? 'complete' : 'pre_game',
        metadata: { home_team: t, away_team: t, is_over: complete } })));
      return { ok: false };
    }
  });
  ctx.__els = {};
  vm.runInContext(source, ctx);
  /* `const` and arrow bindings are lexical: unlike a function declaration they
     never become properties of the context, so hand the ones under test over
     explicitly rather than reaching for them and finding undefined. */
  vm.runInContext(`globalThis.SPREAD = SPREAD; globalThis.picksOpen = picksOpen;
    globalThis.myPicks = myPicks; globalThis.pkName = pkName; globalThis.pctTxt = pctTxt;
    globalThis.matchupOf = matchupOf; globalThis.pickPct = pickPct;`, ctx);
  return { ctx, get rpc() { return rpc; }, get rows() { return rows; }, get fetched() { return fetched; } };
}

test('the pick page source parses on its own', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

/* Projected points come from the league's own scoring applied to Sleeper's
   weekly projections, and the win probability is position-aware because a
   quarterback's remaining points are far more predictable than a receiver's. */
test('every matchup gets a projection and a probability that sums to one', async () => {
  const f = context();
  const lines = await f.ctx.loadLines(4);
  assert.equal(lines.pairs.length, 6, 'twelve teams make six matchups');
  assert.ok(lines.ok);
  for (const p of lines.pairs) {
    assert.equal(p.sides.length, 2);
    assert.ok(Number.isFinite(p.matchup), 'the pair must carry its matchup id');
    for (const s of p.sides) {
      assert.ok(s.proj > 0 && Number.isFinite(s.proj), `bad projection ${s.proj}`);
      assert.ok(s.win >= 0 && s.win <= 1, `bad probability ${s.win}`);
    }
    assert.ok(Math.abs(p.sides[0].win + p.sides[1].win - 1) < 1e-9, 'probabilities must sum to 1');
    const [a, b] = p.sides;
    if (a.proj !== b.proj) assert.equal(a.proj > b.proj, a.win > b.win, 'the favourite is the higher projection');
  }
});

test('league scoring drives the projection, so the format is never hardcoded', async () => {
  const f = context();
  const base = (await f.ctx.loadLines(4)).pairs[0].sides[0].proj;
  // double every receiving point and the totals must move
  const g = context();
  vm.runInContext('SCORING = {...SCORING, rec: 2, rec_yd: 0.2}', g.ctx);
  const lifted = (await g.ctx.loadLines(4)).pairs[0].sides[0].proj;
  assert.ok(lifted > base * 1.2, `scoring had no effect: ${base} -> ${lifted}`);
});

test('the normal CDF behaves like one', () => {
  const { ctx } = context();
  assert.ok(Math.abs(ctx.normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(ctx.normalCdf(1) - 0.8413) < 0.002, String(ctx.normalCdf(1)));
  assert.ok(ctx.normalCdf(-4) < 0.001 && ctx.normalCdf(4) > 0.999);
  assert.ok(ctx.normalCdf(-1) < ctx.normalCdf(0) && ctx.normalCdf(0) < ctx.normalCdf(1));
  // the vm has its own intrinsics, so compare values rather than whole objects
  assert.equal(ctx.SPREAD.QB, 0.55);
  assert.equal(ctx.SPREAD.RB, 0.75);
  assert.equal(ctx.SPREAD.WR, 0.85);
  assert.equal(ctx.SPREAD.TE, 0.80);
});

/* A player whose real game has finished must stop carrying points. Without that
   check, somebody who underperformed keeps being credited with points he can no
   longer earn, and the probability drifts away from the result. */
test('a finished week has nothing left to be uncertain about', async () => {
  const f = context({ complete: true });
  const lines = await f.ctx.loadLines(4);
  for (const p of lines.pairs) {
    assert.ok(p.settled, 'every game complete means no variance left');
    for (const s of p.sides) {
      assert.equal(s.variance, 0);
      assert.equal(s.remaining, 0, 'a finished game leaves nothing to come');
      assert.ok(Number.isFinite(s.win), 'and still no divide-by-zero');
    }
    const wins = [...p.sides.map(s => s.win)].sort();
    assert.equal(wins[0], 0, 'the trailing side is certain to lose');
    assert.equal(wins[1], 1, 'the leading side is certain to win');
  }
});

test('a dropped matchup request is not cached as an empty week', async () => {
  const f = context({ fail: true });
  const lines = await f.ctx.loadLines(4);
  assert.equal(lines.ok, false);
  assert.equal(lines.pairs.length, 0);
  assert.equal(vm.runInContext('JSON.stringify(Object.keys(LINES))', f.ctx), '[]',
    'caching a failure would make one dropped request permanent for the session');
});

/* Grading only counts weeks that have been played: an unpicked or unplayed week
   is not a miss, and a tie is a push that counts for nobody. */
test('grading counts played weeks only, and a tie is a push', async () => {
  const f = context({ complete: true, picks: [
    { week: 4, voter: 1, picks: [1, 3, 5, 7, 9, 11], updated_at: 'x' },   // all winners
    { week: 4, voter: 2, picks: [2, 4, 6, 8, 10, 12], updated_at: 'x' },  // all losers
    { week: 4, voter: 3, picks: [1, 4, 5, 8, 9, 12], updated_at: 'x' },   // half each
    { week: 9, voter: 4, picks: [1, 3, 5, 7, 9, 11], updated_at: 'x' }    // week not played
  ] });
  await f.ctx.loadPicks();
  const g = f.ctx.gradePicks();
  assert.equal(g[1].right, 6); assert.equal(g[1].wrong, 0);
  assert.equal(g[2].right, 0); assert.equal(g[2].wrong, 6);
  assert.equal(g[3].right, 3); assert.equal(g[3].wrong, 3);
  assert.equal(f.ctx.pickPct(g[1]), 1);
  assert.equal(f.ctx.pickPct(g[2]), 0);
  assert.equal(f.ctx.pickPct(g[3]), 0.5);
  // the future week is submitted but ungraded
  assert.equal(g[4].right, 0, 'an unplayed week must not be graded');
  assert.equal(g[4].wrong, 0, 'an unplayed week must not count as six misses');
  assert.equal(g[4].made, 1, 'but the slate was still submitted');
  assert.equal(g[4].weeks, 0);
  assert.equal(f.ctx.pickPct(g[4]), null, 'nothing graded means no accuracy, not zero');
  assert.equal(f.ctx.pickPct(g[7]), null, 'a team that never picked has none either');

  // a tie counts for nobody on either side
  vm.runInContext('SCHED.byWeek[4][1] = {pf: 120, pa: 120, opp: 2};', f.ctx);
  vm.runInContext('SCHED.byWeek[4][2] = {pf: 120, pa: 120, opp: 1};', f.ctx);
  const tied = f.ctx.gradePicks();
  assert.equal(tied[1].push, 1, 'a tie is a push for whoever picked it');
  assert.equal(tied[1].right, 5); assert.equal(tied[1].wrong, 0);
  assert.equal(tied[2].push, 1, 'and a push for the other side too');
  assert.equal(tied[2].right, 0); assert.equal(tied[2].wrong, 5);
});

test('a pick is located by roster id alone, with no matchup id stored', async () => {
  const f = context();
  const lines = await f.ctx.loadLines(4);
  for (const id of TEAM_IDS) {
    const pair = f.ctx.matchupOf(lines, id);
    assert.ok(pair, `roster ${id} should sit in exactly one matchup`);
    assert.ok(pair.teams.includes(id));
  }
  assert.equal(f.ctx.matchupOf(lines, 99), null, 'an unknown roster resolves to nothing');
  // every team appears exactly once across the week, which is what makes the
  // roster id sufficient on its own
  const seen = lines.pairs.flatMap(p => p.teams);
  assert.equal(new Set(seen).size, 12);
});

/* The window is the ballot's, deliberately: Tue 00:00 to Thu 20:00 ET, which
   shuts before Thursday night kickoff. */
test('the window opens Tuesday and shuts Thursday evening', () => {
  for (const [when, open] of [
    ['2026-10-05T16:00:00Z', false],  // Monday noon ET
    ['2026-10-06T04:01:00Z', true],   // Tuesday 00:01 ET
    ['2026-10-07T18:00:00Z', true],   // Wednesday
    ['2026-10-08T23:59:00Z', true],   // Thursday 19:59 ET
    ['2026-10-09T00:01:00Z', false],  // Thursday 20:01 ET
    ['2026-10-10T18:00:00Z', false]   // Saturday
  ]) {
    const f = context({ now: when });
    assert.equal(f.ctx.picksOpen(), open, `expected ${open} at ${when}`);
  }
});

test('the window is re-checked on submit, not trusted from the button', async () => {
  const f = context({ now: '2026-10-05T16:00:00Z' });      // Monday: shut
  await f.ctx.loadLines(4);
  vm.runInContext('S.pick = {1:1,3:3,5:5,7:7,9:9,11:11}', f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 0, 'a shut window must refuse the write');
});

test('submitting sends exactly one winner per matchup, with the password', async () => {
  const f = context();
  const lines = await f.ctx.loadLines(4);
  f.ctx.__els.pkpw = { value: 'goodpassword', focus() {} };
  // choose the first side of every matchup
  const chosen = lines.pairs.map(p => p.teams[0]);
  vm.runInContext(`S.pick = {${chosen.map(c => `${c}:${c}`).join(',')}}`, f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 1, JSON.stringify(f.ctx.S.pickMsg));
  const { name, args } = f.rpc[0];
  assert.equal(name, 'submit_picks');
  assert.equal(args.p_season, 2026);
  assert.equal(args.p_week, 4);
  assert.equal(args.p_voter, 5);
  assert.equal(args.p_password, 'goodpassword');
  assert.equal(args.p_picks.length, 6);
  assert.equal(new Set(args.p_picks).size, 6, 'no team twice');
  assert.ok(args.p_picks.every(Number.isInteger));
  assert.equal(f.ctx.S.pickMsg.err, false);
});

test('an incomplete slate, a short password and a bad password are each refused', async () => {
  // incomplete
  let f = context();
  await f.ctx.loadLines(4);
  f.ctx.__els.pkpw = { value: 'goodpassword', focus() {} };
  vm.runInContext('S.pick = {1:1,3:3}', f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 0, `incomplete slate reached the server: ${JSON.stringify(f.ctx.S.pickMsg)}`);
  assert.match(f.ctx.S.pickMsg.text, /every matchup/);

  // short password never reaches the server
  f = context();
  const lines = await f.ctx.loadLines(4);
  const full = lines.pairs.map(p => p.teams[0]);
  f.ctx.__els.pkpw = { value: 'abc', focus() {} };
  vm.runInContext(`S.pick = {${full.map(c => `${c}:${c}`).join(',')}}`, f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 0,
    `short password reached the server: ${JSON.stringify(f.ctx.S.pickMsg)}`);
  assert.match(f.ctx.S.pickMsg.text, /at least 4 characters/);

  // wrong password: the server's own message is surfaced, not swallowed
  f.ctx.__els.pkpw.value = 'wrongpw';
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 1);
  assert.equal(f.ctx.S.pickMsg.err, true);
  assert.match(f.ctx.S.pickMsg.text, /Wrong password for this team/);
});

test('two winners from one matchup can never be submitted', async () => {
  const f = context();
  const lines = await f.ctx.loadLines(4);
  f.ctx.__els.pkpw = { value: 'goodpassword', focus() {} };
  const pair = lines.pairs[0];
  // both sides of one matchup, and four others: six picks, but not six matchups
  const bad = [...pair.teams, ...lines.pairs.slice(1, 5).map(p => p.teams[0])];
  vm.runInContext(`S.pick = {${bad.map(c => `${c}:${c}`).join(',')}}`, f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 0, 'the page must catch this before the server does');
  assert.match(f.ctx.S.pickMsg.text, /don't match this week's matchups/);
});

test('a team with no identity chosen cannot submit', async () => {
  const f = context({ voter: null });
  const lines = await f.ctx.loadLines(4);
  f.ctx.__els.pkpw = { value: 'goodpassword', focus() {} };
  vm.runInContext(`S.pick = {${lines.pairs.map(p => `${p.teams[0]}:${p.teams[0]}`).join(',')}}`, f.ctx);
  await f.ctx.submitPicks();
  assert.equal(f.rpc.length, 0);
  assert.match(f.ctx.S.pickMsg.text, /Choose your team/);
});

/* Preloading shows a team its saved slate, but only once per week and voter —
   running it on every render would make Clear appear to do nothing. */
test('a saved slate is preloaded once, so clearing it sticks', async () => {
  const f = context({ picks: [{ week: 4, voter: 5, picks: [1, 3, 5, 7, 9, 11], updated_at: 'x' }] });
  await f.ctx.loadPicks();
  f.ctx.preloadPicks();
  assert.equal(Object.keys(f.ctx.S.pick).length, 6, 'the saved slate should come back');
  vm.runInContext('S.pick = {}', f.ctx);
  f.ctx.preloadPicks();
  assert.equal(Object.keys(f.ctx.S.pick).length, 0, 'a second call must not undo a clear');
  f.ctx.preloadPicks(true);
  assert.equal(Object.keys(f.ctx.S.pick).length, 6, 'but an explicit reload still works');
  // switching week reloads for that week
  vm.runInContext('S.pickWeek = 9', f.ctx);
  f.ctx.preloadPicks();
  assert.equal(Object.keys(f.ctx.S.pick).length, 0, 'no slate saved for week 9');
});

test('loading picks never clobbers a slate in progress', async () => {
  const f = context({ picks: [{ week: 4, voter: 1, picks: [1, 3, 5, 7, 9, 11], updated_at: 'x' }] });
  let renders = 0;
  vm.runInContext('busyComposing = () => true; render = () => { __renders++ }; var __renders = 0;', f.ctx);
  await f.ctx.loadPicks();
  assert.equal(vm.runInContext('__renders', f.ctx), 0,
    'someone part-way through a slate must not have it redrawn from under them');
  assert.equal(f.ctx.S.picks.length, 1, 'the data is still refreshed underneath');
  assert.equal(f.ctx.S.picksLoaded, true);
});
