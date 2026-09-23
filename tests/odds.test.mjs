import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineup, lottery, rng, normal, scoreStats, fitAlpha, rankingLoss, wilson, addWeek, seedField, simulate, weeklyProfile } from '../scripts/odds/model.mjs';
import { pairsFor, loadInput } from '../scripts/odds/data.mjs';
const player = (id, positions, value) => ({ id, positions, value });
const close = (a, b, e = 1e-8) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test('optimal assignment handles overlapping flex, dual positions, and no duplicate starters', () => {
  const pool = [player('a', ['RB', 'WR'], 30), player('b', ['RB'], 29), player('c', ['TE'], 28), player('d', ['QB'], 50)];
  const chosen = lineup(pool, ['RB', 'WR', 'FLEX']);
  assert.deepEqual(chosen.map(p => p.id).sort(), ['a', 'b', 'c']);
  assert.equal(lineup(pool, ['QB', 'SUPER_FLEX']).reduce((n, p) => n + p.value, 0), 80);
  assert.equal(new Set(chosen.map(p => p.id)).size, chosen.length);
});
test('locked starters retain negative points and bench players cannot displace them', () => {
  const pool = [player('locked', ['QB'], -5), player('bench', ['QB'], 50)];
  assert.equal(lineup(pool, ['QB'], new Set(['locked']))[0].id, 'locked');
  assert.throws(() => lineup(pool, ['WR'], new Set(['locked'])), /not legal/);
  assert.equal(lineup(pool, ['WR']).length, 0);
  const lockedFlex = { ...player('flex', ['RB'], 20), fixedSlot: 1 };
  const laterReceiver = player('receiver', ['WR'], 50);
  assert.deepEqual(lineup([lockedFlex, laterReceiver], ['RB', 'FLEX'], new Set(['flex'])).map(p => p.id), ['flex']);
});
test('lineup optimum matches exhaustive assignment on varied small rosters', () => {
  const random = rng(21), slots = ['RB', 'WR', 'SUPER_FLEX'];
  function brute(pool, i = 0) {
    if (i === slots.length) return 0;
    let best = brute(pool, i + 1);
    for (const p of pool) if (slots[i] === 'SUPER_FLEX' || p.positions.includes(slots[i]))
      best = Math.max(best, p.value + brute(pool.filter(x => x !== p), i + 1));
    return best;
  }
  for (let i = 0; i < 80; i++) {
    const pool = Array.from({ length: 5 }, (_, j) => player(String(j), [['RB'], ['WR'], ['QB'], ['RB', 'WR']][Math.floor(random() * 4)], Math.floor(random() * 50) - 5));
    assert.equal(lineup(pool, slots).reduce((s, p) => s + p.value, 0), brute(pool));
  }
});
test('weighted lottery favors rank but allows booms/busts without replacing profiles', () => {
  const players = Array.from({ length: 8 }, (_, id) => ({ id }));
  const profiles = players.map(p => ({ mu: 10 + p.id, sd: 3 })), random = rng(43);
  const totals = Array(8).fill(0), wins = Array(8).fill(0);
  for (let i = 0; i < 3000; i++) {
    const draw = lottery(players, profiles, 1.25, random);
    assert.equal(new Set(Object.values(draw).map(p => p.mu)).size, 8);
    for (const p of players) { totals[p.id] += draw[p.id].mu; wins[p.id] += draw[p.id].mu === 17; }
  }
  assert.ok(totals[0] > totals[7]); assert.ok(wins[0] > wins[7]);
  assert.ok(wins[7] > 0 && wins[0] < 3000);
});
test('fitted ranking weights improve ordered historical likelihood over uniform weights', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, mu: 20 - i }));
  const a = fitAlpha([rows]);
  assert.ok(a > 1); assert.ok(rankingLoss(rows, a) < rankingLoss(rows, 0));
});
test('normal variation preserves the mean, including negative fantasy scores', () => {
  const random = rng(4), values = Array.from({ length: 50000 }, () => 2 + 10 * normal(random));
  close(values.reduce((a, b) => a + b, 0) / values.length, 2, .15);
  assert.ok(values.some(v => v < 0));
});
test('league scoring applies first-down and TE bonuses exactly once', () => {
  assert.equal(scoreStats({ rec: 5, rec_yd: 50, rec_fd: 3, bonus_rec_te: 5, bonus_fd_te: 3 },
    { rec: .5, rec_yd: .1, rec_fd: 1, bonus_rec_te: .5, bonus_fd_te: .5 }), 14.5);
});
test('H2H and median ties are banked as ties; PF and PA count only once', () => {
  const st = Object.fromEntries([1, 2, 3, 4].map(id => [id, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  addWeek(st, { 1: 100, 2: 80, 3: 90, 4: 90 }, [[1, 2], [3, 4]], true);
  assert.deepEqual(st[3], { w: 0, l: 0, t: 2, pf: 90, pa: 90 });
  assert.deepEqual(st[1], { w: 2, l: 0, t: 0, pf: 100, pa: 80 });
});
test('division winners qualify, two get byes, third may seed below wildcards', () => {
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, div: Math.floor(i / 4) }));
  const st = Object.fromEntries(teams.map(t => [t.id, { w: 20 - t.id, l: t.id, t: 0, pf: 100, pa: 100 }]));
  const f = seedField(teams, st, rng(3));
  assert.deepEqual(f.winners.map(t => t.id), [1, 5, 9]);
  assert.deepEqual(f.byes.map(t => t.id), [1, 5]);
  assert.deepEqual(f.seeds.map(t => t.id), [1, 5, 2, 3, 4, 9]);
  st[1] = { ...st[2], pf: 100 - 1e-12, pa: 101 }; // float noise cannot defeat PA tiebreak
  assert.equal(seedField(teams, st, rng(3)).winners[0].id, 1);
});
test('Wilson intervals show finite-sample uncertainty at 0%, 50%, and 100%', () => {
  assert.ok(wilson(0, 1000)[1] > .003);
  assert.ok(wilson(1, 1000)[0] < .997);
  close(wilson(.5, 1000)[1] - .5, .031, .001);
});

function fixture() {
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, div: Math.floor(i / 4), players: ['p' + i], record: { w: 0, l: 0, t: 0, pf: 0, pa: 0 } }));
  const players = teams.map((t, i) => ({ id: 'p' + i, pos: 'QB', positions: ['QB'], team: 'NFL' + i, projected: 20 - i, weekly: { 1: 20, 2: 20, 3: 20, 4: 20 } }));
  const pairs = Array.from({ length: 6 }, (_, i) => [i * 2 + 1, i * 2 + 2]);
  return { teams, players, slots: ['QB'], firstOpen: 1, lastRegular: 1, lastWeek: 4, medianMatch: true, reseed: true,
    weeks: Object.fromEntries([1, 2, 3, 4].map(w => [w, { pairs, active: players.map(p => p.team), finished: [] }])),
    history: { positions: { QB: { seasons: [players.map((p, i) => ({ mu: 30 - i, sd: 5 }))], alpha: 1, hazard: 0, recovery: 1 } } } };
}
test('full season conserves qualification probabilities and W/L/T results, reproducibly', () => {
  const input = fixture(), rows = simulate(input, 100, 7);
  assert.deepEqual(rows, simulate(input, 100, 7));
  for (const [key, total] of Object.entries({ po: 6, div: 3, bye: 2, final: 2, title: 1 })) close(rows.reduce((s, r) => s + r[key], 0), total);
  close(rows.reduce((s, r) => s + r.projW + r.projT / 2, 0), 12);
  for (const r of rows) { close(r.projW + r.projL + r.projT, 2); assert.ok(r.title <= r.final && r.final <= r.po); }
});
test('actual playoff weeks use byes and zero projections, and tied playoffs favor higher seed', () => {
  const input = fixture();
  // Everybody has zero available players throughout: all games tie. Division
  // winners still seed, two finalists always come from the bye recipients.
  for (const w of Object.values(input.weeks)) w.active = [];
  const rows = simulate(input, 200, 8);
  for (const r of rows) { assert.equal(r.meanPoints, 0); close(r.final, r.bye); assert.equal(r.projT, 2); }
  const baseline = fixture(), noFinal = fixture();
  noFinal.weeks[4].active = [];
  assert.notDeepEqual(simulate(baseline, 200, 5).map(r => r.title), simulate(noFinal, 200, 5).map(r => r.title));
});
test('zero projected weeks exclude players without permanently removing injured reserve', () => {
  const input = fixture(); input.players[0].weekly[1] = 0;
  assert.equal(simulate(input, 20, 3).find(r => r.id === 1).meanPoints, 0);
  input.players[0].weekly[1] = 20;
  assert.ok(simulate(input, 20, 3).find(r => r.id === 1).meanPoints > 0);
});
test('completed player scores stay locked through simulations', () => {
  const input = fixture(); input.weeks[1].finished = input.weeks[1].active;
  input.weeks[1].locked = Object.fromEntries(input.teams.map((t, i) => [t.id, { ['p' + i]: i - 5 }]));
  const rows = simulate(input, 20, 3);
  for (const r of rows) assert.equal(r.meanPoints, r.id - 6);
});
test('persistent season PPG is retained across weeks when weekly noise is zero', () => {
  const input = fixture();
  input.history.positions.QB.seasons[0].forEach(p => p.sd = 0);
  const oneWeek = simulate(input, 1, 4);
  input.lastRegular = 2; input.lastWeek = 5;
  input.weeks[5] = input.weeks[4]; input.players.forEach(p => p.weekly[5] = 20);
  const rows = simulate(input, 1, 4);
  rows.forEach(r => assert.equal(r.meanPoints, oneWeek.find(x => x.id === r.id).meanPoints));
});
test('incomplete matchup data is rejected', () => {
  assert.throws(() => pairsFor([{ roster_id: 1, matchup_id: 1 }], 12), /Incomplete/);
});

test('weekly matchup adjustments preserve baseline talent and scale spread consistently', () => {
  const p = { projected: 20, weekly: { 1: 10, 2: 30, 3: 0 } }, talent = { mu: 16, sd: 6 };
  assert.deepEqual(weeklyProfile(p, talent, 1), { mu: 8, sd: 3 });
  assert.deepEqual(weeklyProfile(p, talent, 2), { mu: 24, sd: 9 });
  assert.deepEqual(weeklyProfile(p, talent, 3), { mu: 0, sd: 0 });
  close((weeklyProfile(p, talent, 1).mu + weeklyProfile(p, talent, 2).mu) / 2, talent.mu);
  assert.deepEqual(talent, { mu: 16, sd: 6 });
});

function fixedPlayoffs() {
  const input = fixture(); input.firstOpen = 2;
  input.teams.forEach(t => t.record = { w: 24 - t.id, l: t.id, t: 0, pf: 100, pa: 100 });
  input.players.forEach(p => p.projected = 20);
  input.history.positions.QB.seasons[0].forEach(p => { p.mu = 20; p.sd = 6; });
  return input; // seeds 1,5,2,3,4,9; division winners 1,5,9
}

test('bye, final and title frequencies match exact equal-strength bracket probabilities', () => {
  const rows = simulate(fixedPlayoffs(), 10000, 42);
  for (const r of rows) {
    const bye = [1, 5].includes(r.id), qualifies = [1, 5, 2, 3, 4, 9].includes(r.id);
    assert.equal(r.bye, Number(bye)); assert.equal(r.po, Number(qualifies));
    close(r.final, bye ? .5 : qualifies ? .25 : 0, .02);
    close(r.title, bye ? .25 : qualifies ? .125 : 0, .02);
  }
  assert.equal(rows.find(r => r.id === 2).bye, 0, 'strong wildcard never takes a division-winner bye');
});

test('playoff-week matchup projections change title chances without changing qualification or byes', () => {
  const normal = fixedPlayoffs(), favorableFinal = fixedPlayoffs();
  favorableFinal.players[0].weekly[4] = 80;
  const a = simulate(normal, 2000, 7), b = simulate(favorableFinal, 2000, 7);
  const before = a.find(r => r.id === 1), after = b.find(r => r.id === 1);
  assert.equal(before.po, after.po); assert.equal(before.bye, after.bye);
  close(before.final, after.final); assert.ok(after.title > before.title + .15);
});

test('known playoff results override random scores and preserve a known champion', () => {
  const input = fixedPlayoffs();
  input.bracket = [
    { r: 1, t1: 2, t2: 9, w: 9 }, { r: 1, t1: 3, t2: 4, w: 4 },
    { r: 2, t1: 1, t2: 9, w: 9 }, { r: 2, t1: 5, t2: 4, w: 5 },
    { r: 3, t1: 9, t2: 5, w: 9 }
  ];
  const rows = simulate(input, 50, 8);
  assert.equal(rows.find(r => r.id === 9).title, 1);
  assert.equal(rows.find(r => r.id === 5).final, 1);
  assert.equal(rows.find(r => r.id === 1).final, 0);
});

test('reseeded semifinals send the lowest surviving seed to seed one', () => {
  const input = fixedPlayoffs();
  input.bracket = [{ r: 1, t1: 2, t2: 9, w: 9 }, { r: 1, t1: 3, t2: 4, w: 3 }];
  input.history.positions.QB.seasons[0].forEach(p => p.sd = 0);
  // Semifinal scores: seed 1=40, seed 2=30, seed 4=35, seed 6=20.
  for (const [id, points] of [[1, 40], [5, 30], [3, 35], [9, 20]]) input.players.find(p => p.id === 'p' + (id - 1)).weekly[3] = points;
  const reseeded = simulate(input, 1, 8);
  assert.equal(reseeded.find(r => r.id === 1).final, 1);
  assert.equal(reseeded.find(r => r.id === 3).final, 1);
  input.reseed = false;
  const fixed = simulate(input, 1, 8);
  assert.equal(fixed.find(r => r.id === 5).final, 1);
  assert.equal(fixed.find(r => r.id === 3).final, 0);
});

test('data loader catches up finished weeks, excludes taxi, keeps IR, and rejects live games', async () => {
  let live = false;
  const projection = Object.fromEntries(Array.from({ length: 110 }, (_, i) => ['p' + i, { pass_yd: 250 }]));
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1,
    settings: { wins: 0, losses: 0, division: Math.floor(i / 4) }, players: ['p' + i, 'taxi'], taxi: ['taxi'], reserve: ['p' + i] }));
  const request = async url => {
    if (url.endsWith('/players/nfl')) return Object.fromEntries(Object.keys(projection).map(id => [id, { position: 'QB', team: 'A' }]));
    if (url.endsWith('/rosters')) return rosters;
    if (url.endsWith('/winners_bracket')) return [];
    if (url.includes('/scores/')) return [{ status: live ? 'in_progress' : url.endsWith('/1') ? 'complete' : 'pre_game', metadata: { home_team: 'A', away_team: 'B' } }];
    if (url.includes('/matchups/')) return rosters.map((r, i) => ({ roster_id: r.roster_id, matchup_id: Math.floor(i / 2), points: 100 + i, starters: [], players_points: {} }));
    if (url.includes('/projections/')) return projection;
    return { season: 2026, scoring_settings: { pass_yd: .04 }, roster_positions: ['QB', 'BN'],
      settings: { divisions: 3, playoff_teams: 6, playoff_round_type: 0, playoff_type: 0, playoff_week_start: 3, league_average_match: 1, playoff_seed_type: 1 } };
  };
  const options = { request, historyLoader: async () => fixture().history, configLoader: async () => ({ leagueId: 'test' }) };
  const input = await loadInput(options);
  assert.equal(input.firstOpen, 2);
  assert.ok(input.teams.every(t => t.record.w + t.record.l + t.record.t === 2));
  assert.ok(input.teams.every(t => t.players.length === 1));
  assert.ok(input.players.some(p => p.id === 'p0'));
  live = true;
  await assert.rejects(loadInput(options), /in progress/);
});
