/* The casino's pricing, parsing, grading and settlement — the shared module the
   edge function runs — against real ESPN responses saved as fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as C from '../supabase/functions/_shared/casino.mjs';

const board = JSON.parse(readFileSync(new URL('./fixtures/espn-scoreboard-w5.json', import.meta.url), 'utf8'));
const props = JSON.parse(readFileSync(new URL('./fixtures/espn-props.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const RULES = { min_stake: 1, max_stake_straight: 100, max_stake_parlay: 25, max_payout: 1000,
  parlay_min_legs: 2, parlay_max_legs: 6, parlay_max_price: 21, leg_min_price: 1.2, leg_max_price: 11,
  live_enabled: false, live_delay_sec: 45, live_tolerance: 0.05, pending_timeout_sec: 300,
  sgp_hold: 0.15, sgp_max_legs: 4, sgp_min_hits: 20 };

test('American and decimal odds convert both ways and parse ESPN strings', () => {
  assert.equal(C.americanToDecimal(-110), 1.9091);
  assert.equal(C.americanToDecimal(360), 4.6);
  assert.equal(C.americanToDecimal(-470), 1.2128);
  assert.equal(C.decimalToAmerican(4.6), 360);
  assert.equal(C.decimalToAmerican(1.9091), -110);
  assert.equal(C.parseAmerican('+360'), 360);
  assert.equal(C.parseAmerican('-470'), -470);
  assert.equal(C.parseAmerican('EVEN'), 100);
  assert.equal(C.parseAmerican(''), null);
  assert.equal(C.parseAmerican('50'), null, 'not a valid American price');
  assert.equal(C.parlayPrice([1.9091, 1.9091]), 3.6447);
  assert.equal(C.parlayPrice([6, 6, 6], 21), 21, 'parlays are capped');
});

test('DraftKings game lines come off the ESPN scoreboard as complete markets', () => {
  const rows = C.gameLines(board.events[0], { season: 2026, week: 5 });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rows.length, 6);
  assert.equal(by['nfl:401872980:ml:home'].american, -470);
  assert.equal(by['nfl:401872980:ml:away'].american, 360);
  assert.equal(by['nfl:401872980:spread:home'].point, -9.5);
  assert.equal(by['nfl:401872980:spread:away'].point, 9.5);
  assert.equal(by['nfl:401872980:spread:home'].american, -105);
  assert.equal(by['nfl:401872980:total:over'].point, 47.5);
  for (const r of rows) {
    assert.equal(r.event, 'nfl:401872980', 'every market of one game shares an event, so a parlay takes one');
    assert.equal(r.event_label, 'TB @ DAL');
    assert.equal(r.state, 'pre');
    assert.ok(r.price > 1);
  }
  // a market missing a side is dropped whole
  const ev = structuredClone(board.events[0]);
  delete ev.competitions[0].odds[0].moneyline.home;
  assert.ok(!C.gameLines(ev, { season: 2026, week: 5 }).some(r => r.market === 'ml'));
  // no DraftKings odds at all: nothing to offer
  const bare = structuredClone(board.events[0]); bare.competitions[0].odds = [];
  assert.deepEqual(C.gameLines(bare, { season: 2026, week: 5 }), []);
});

test('props are over/under lines matched by ESPN id, priced at the house price, deduplicated', () => {
  const e = C.parseEvent(board.events[0]);
  const ids = [...new Set(props.items.map(i => i.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1]).filter(Boolean))];
  const espn = Object.fromEntries(ids.slice(1).map((a, i) => [a, { id: String(9000 + i), name: `P${i}`, team: 'DAL' }]));
  const rows = C.propLines(props.items, e, { season: 2026, week: 5, espn });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.american === -115 && r.price === C.americanToDecimal(-115)));
  assert.ok(rows.every(r => C.PROP_BY_KEY[r.market]), 'only plain over/unders, never milestones or anytime TD');
  assert.ok(!rows.some(r => r.id.includes(`:${ids[0]}:`)), 'an athlete Sleeper cannot be matched to is not offered');
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'ESPN lists each prop twice; offered once');
  const over = rows.filter(r => r.side === 'over').length, under = rows.filter(r => r.side === 'under').length;
  assert.equal(over, under);
  assert.ok(rows.every(r => r.event === 'nfl:401872980'));
});

test('a live line is suspended when the game moves and the price has not', () => {
  const pre = { state: 'in', sport: 'nfl', score: '7-0|DAL', price: 1.9, point: -3.5, status: 'open' };
  const on = { live_enabled: true };
  assert.equal(C.lineStatus(pre, { ...pre }, on), 'open');
  assert.equal(C.lineStatus(pre, { ...pre, score: '7-7|TB' }, on), 'suspended');
  assert.equal(C.lineStatus(pre, { ...pre, score: '7-7|TB', price: 2.1 }, on), 'open');
  assert.equal(C.lineStatus({ ...pre, status: 'suspended' }, { ...pre }, on), 'suspended', 'stays shut until the book reprices');
  assert.equal(C.lineStatus(pre, { ...pre }, { live_enabled: false }), 'closed');
  assert.equal(C.lineStatus(pre, { ...pre, sport: 'prop' }, on), 'closed', 'props are pregame only');
  assert.equal(C.lineStatus(null, { state: 'post' }, on), 'closed');
});

test('grading uses the point the bet was placed at, and handles pushes and voids', () => {
  const nfl = (market, side) => ({ sport: 'nfl', market, side });
  const o = { home: 24, away: 17 };
  assert.equal(C.gradeLeg(nfl('ml', 'home'), null, o), 'win');
  assert.equal(C.gradeLeg(nfl('ml', 'away'), null, o), 'loss');
  assert.equal(C.gradeLeg(nfl('ml', 'home'), null, { home: 20, away: 20 }), 'push');
  assert.equal(C.gradeLeg(nfl('spread', 'home'), -7, o), 'push');
  assert.equal(C.gradeLeg(nfl('spread', 'home'), -6.5, o), 'win');
  assert.equal(C.gradeLeg(nfl('spread', 'away'), 6.5, o), 'loss');
  assert.equal(C.gradeLeg(nfl('total', 'over'), 40.5, o), 'win');
  assert.equal(C.gradeLeg(nfl('total', 'under'), 41, o), 'push');
  const prop = side => ({ sport: 'prop', market: 'rec_yd', side });
  assert.equal(C.gradeLeg(prop('over'), 55.5, { played: true, value: 56 }), 'win');
  assert.equal(C.gradeLeg(prop('under'), 55.5, { played: true, value: 56 }), 'loss');
  assert.equal(C.gradeLeg(prop('over'), 55.5, { played: false }), 'void');
  const fan = (market, side, team) => ({ sport: 'fantasy', market, side, team, teams: [3, 8] });
  const f = { pts: { 3: 120.4, 8: 110.2 } };
  assert.equal(C.gradeLeg(fan('ml', '3', 3), null, f), 'win');
  assert.equal(C.gradeLeg(fan('spread', '8', 8), 10.5, f), 'win');
  assert.equal(C.gradeLeg(fan('spread', '3', 3), -10.5, f), 'loss');
  assert.equal(C.gradeLeg(fan('total', 'over'), 230.5, f), 'win');
  assert.equal(C.gradeLeg(nfl('ml', 'home'), null, null), null, 'no outcome yet');
  assert.equal(C.gradeLeg(nfl('ml', 'home'), null, { void: true }), 'void');
});

test('prop outcomes come from Sleeper weekly stats; a player who did not play voids', () => {
  assert.deepEqual(C.propOutcome({ gp: 1, pass_yd: 299, rush_yd: 12 }, 'pass_rush_yd'), { played: true, value: 311 });
  assert.deepEqual(C.propOutcome({ gp: 1 }, 'rec'), { played: true, value: 0 });
  assert.deepEqual(C.propOutcome({ gms_active: 1 }, 'rec'), { played: false });
  assert.deepEqual(C.propOutcome(undefined, 'rec'), { played: false });
});

test('settlement: straights, parlays, pushes and voids, with both caps', () => {
  const s = (kind, stake, legs) => C.settleBet({ kind, stake }, legs, RULES);
  assert.deepEqual(s('straight', 10, [{ price: 1.9091, result: 'win' }]), { status: 'won', payout: 19.09 });
  assert.deepEqual(s('straight', 10, [{ price: 1.9091, result: 'push' }]), { status: 'push', payout: 10 });
  assert.deepEqual(s('straight', 10, [{ price: 1.9091, result: 'void' }]), { status: 'void', payout: 10 });
  assert.equal(s('straight', 10, [{ price: 1.9, result: null }]), null);
  // a parlay is lost the moment any leg loses, even with legs still to play
  assert.deepEqual(s('parlay', 10, [{ price: 2, result: 'loss' }, { price: 2, result: null }]), { status: 'lost', payout: 0 });
  assert.equal(s('parlay', 10, [{ price: 2, result: 'win' }, { price: 2, result: null }]), null);
  // pushed and voided legs drop out and the rest is repriced
  assert.deepEqual(s('parlay', 10, [{ price: 2, result: 'win' }, { price: 3, result: 'push' }, { price: 1.5, result: 'win' }]),
    { status: 'won', payout: 30 });
  assert.deepEqual(s('parlay', 10, [{ price: 2, result: 'void' }, { price: 3, result: 'push' }]), { status: 'push', payout: 10 });
  assert.deepEqual(s('parlay', 25, [{ price: 6, result: 'win' }, { price: 6, result: 'win' }]), { status: 'won', payout: 525 },
    'the +2000 parlay cap applies at settlement too');
  assert.deepEqual(s('straight', 100, [{ price: 11, result: 'win' }]), { status: 'won', payout: 1000 }, 'max payout');
});

test('a live bet is accepted only when the line refreshed, the game stood still and the price held', () => {
  const placed = '2026-10-11T17:00:00Z', t0 = Date.parse(placed);
  const leg = { line_id: 'L', price: 1.9091, point: -3.5, score_at: '7-0|DAL' };
  const line = { status: 'open', price: 1.9091, point: -3.5, score: '7-0|DAL', updated_at: '2026-10-11T17:01:00Z' };
  const go = (l, at = t0 + 70000) => C.resolvePending({ placed_at: placed }, [leg], { L: l }, RULES, at);
  assert.equal(go(line, t0 + 30000), null, 'still inside the delay');
  assert.deepEqual(go(line), { accept: true, note: null });
  assert.equal(go({ ...line, price: 1.95 }).accept, true, 'a small move is within tolerance');
  assert.equal(go({ ...line, price: 2.2 }).accept, false);
  assert.equal(go({ ...line, score: '7-7|TB' }).accept, false);
  assert.equal(go({ ...line, score: '7-0|TB' }).accept, false, 'a turnover counts as the game moving');
  assert.equal(go({ ...line, point: -4.5 }).accept, false);
  assert.equal(go({ ...line, status: 'suspended' }).accept, false);
  assert.equal(go({ ...line, updated_at: '2026-10-11T16:59:00Z' }), null, 'wait for a sync after the bet');
  assert.equal(go({ ...line, updated_at: '2026-10-11T16:59:00Z' }, t0 + 400000).accept, false, 'but not forever');
  assert.equal(C.resolvePending({ placed_at: placed }, [leg], {}, RULES, t0 + 70000).accept, false);
});

test('fantasy lines are a moneyline and a total: the hold is kept, totals never push, no spreads', () => {
  const pairs = [{ matchup: 2, teams: [3, 8], total: 241.2,
    sides: [{ team: 3, proj: 125.6, win: 0.62 }, { team: 8, proj: 115.6, win: 0.38 }] }];
  const rows = C.fantasyLines(pairs, { season: 2026, week: 5, commence: '2026-10-09T00:15:00Z' });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rows.length, 4, 'two moneyline sides and two total sides');
  const fav = by['fan:2026:5:2:ml:3'], dog = by['fan:2026:5:2:ml:8'];
  assert.ok(1 / fav.price + 1 / dog.price > 1.03, 'the book keeps a margin');
  assert.ok(fav.american < 0 && dog.american > 0);
  assert.ok(!rows.some(r => r.market === 'spread'), 'spreads are not offered: too little history to price one fairly');
  assert.equal(by['fan:2026:5:2:total:over'].point, 241.5);
  assert.ok(rows.every(r => r.commence_at === '2026-10-09T00:15:00Z' && r.event === 'fan:2026:5:2'));
  assert.deepEqual(C.fantasyLines([{ ...pairs[0], total: 0 }], { season: 2026, week: 5 }), [], 'no projections, no prices');
  assert.equal(C.priceFromProb(0.5, 0.045).american, -109);
});

test('the projection calibration is measured from results, and only moves the level', () => {
  const s = n => Array.from({ length: n }, (_, i) => ({ proj: 200 + i, actual: 0.8 * (200 + i) }));
  assert.equal(C.calibrationScale(s(48)), 0.8);
  assert.equal(C.calibrationScale(s(12)), null, 'one week is not enough to measure');
  assert.equal(C.calibrationScale(s(30).map(x => ({ ...x, actual: x.proj * 5 }))), 1.5, 'clamped');
  assert.equal(C.calibrationScale([]), null);
  // scaling a matchup moves the total and keeps the win probability
  const m = [{ roster_id: 1, matchup_id: 1, starters: ['a1', 'a2'] }, { roster_id: 2, matchup_id: 1, starters: ['b1', 'b2'] }];
  const proj = { a1: { pts: 120 }, a2: { pts: 90 }, b1: { pts: 100 }, b2: { pts: 80 } };
  const pos = { a1: 'QB', a2: 'WR', b1: 'QB', b2: 'RB' };
  const raw = C.fantasyPairs({ matchups: m, proj, positions: pos, scoring: { pts: 1 } })[0];
  const cal = C.fantasyPairs({ matchups: m, proj, positions: pos, scoring: { pts: 1 }, scale: 0.8 })[0];
  assert.ok(Math.abs(cal.total - 0.8 * raw.total) < 1e-9, 'the total scales');
  assert.ok(Math.abs(cal.sides[0].win - raw.sides[0].win) < 1e-12, 'the moneyline does not move');
});

/* The WCXC model is the newspaper's: the same league scoring and the same
   position spreads (QB .55, RB .75, WR .85, TE .80 of what is left to score). */
test('the WCXC model scores players and spreads positions exactly as the newspaper does', async () => {
  const { fantasyPoints } = await import('../scripts/news/data.mjs');
  const scoring = { pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rec: 0.5, rec_yd: 0.1, rec_fd: 1, bonus_rec_te: 0.5 };
  for (const stats of [{ pass_yd: 250, pass_td: 2 }, { rec: 5, rec_yd: 62, rec_fd: 3 }, { rush_yd: 80, rec: 2, bonus_rec_te: 1 }, {}])
    assert.ok(Math.abs(C.scorePoints(stats, scoring) - fantasyPoints(stats, scoring)) < 1e-9);
  const news = readFileSync(new URL('../scripts/news/data.mjs', import.meta.url), 'utf8');
  assert.match(news, /{ QB: 0.55, RB: 0.75, WR: 0.85, TE: 0.80 }/, 'the newspaper still uses these spreads');
  assert.deepEqual(C.SPREAD, { QB: 0.55, RB: 0.75, WR: 0.85, TE: 0.80 });
  // a win probability is the projection gap over the combined spread of what is left
  const m = [{ roster_id: 1, matchup_id: 1, points: 0, starters: ['q', 'w'] }, { roster_id: 2, matchup_id: 1, points: 0, starters: ['r'] }];
  const [p] = C.fantasyPairs({ matchups: m, proj: { q: { pts: 20 }, w: { pts: 10 }, r: { pts: 25 } }, positions: { q: 'QB', w: 'WR', r: 'RB' }, scoring: { pts: 1 } });
  const sd = Math.sqrt((0.55 * 20) ** 2 + (0.85 * 10) ** 2 + (0.75 * 25) ** 2);
  assert.ok(Math.abs(p.sides[0].win - C.normalCdf(5 / sd)) < 1e-12);
});

test('the slip check mirrors place_bet', () => {
  const now = Date.parse('2026-10-06T16:00:00Z');
  const L = o => ({ status: 'open', state: 'pre', sport: 'nfl', price: 1.9091, commence_at: '2026-10-09T00:15:00Z', label: 'X', ...o });
  const ok = (legs, stake, extra = {}) => C.checkSlip({ legs, stake, rules: RULES, now, ...extra });
  assert.deepEqual(ok([L({ event: 'a' })], 10), []);
  assert.deepEqual(ok([L({ event: 'a' }), L({ event: 'a', price: 1.8 })], 10), [], 'a same-game NFL parlay is allowed');
  assert.match(ok([L({ event: 'f', sport: 'fantasy' }), L({ event: 'f', sport: 'fantasy' })], 10).join(), /one leg per WCXC matchup/);
  assert.match(ok([L({ event: 'a', state: 'in' }), L({ event: 'a', state: 'in' })], 10, { rules: { ...RULES, live_enabled: true } }).join(), /pregame only/);
  assert.match(ok(Array.from({ length: 5 }, () => L({ event: 'a' })), 1).join(), /at most 4 legs/);
  assert.deepEqual(ok([L({ event: 'a' }), L({ event: 'a' })], 10, { mode: 'singles' }), [], 'two singles on one game are fine');
  assert.match(ok([L({ event: 'a' }), L({ event: 'b' })], 25, { price: 50 }).join(), /at most \$1000/, 'a known ticket price is what the cap uses');
  assert.match(ok([L({ event: 'a' })], 101).join(), /Maximum straight/);
  assert.match(ok([L({ event: 'a' }), L({ event: 'b' })], 26).join(), /Maximum parlay/);
  assert.match(ok([L({ event: 'a', price: 11 })], 100).join(), /at most \$1000.*\$90\.9/);
  assert.match(ok([L({ event: 'a', price: 1.1 })], 10).join(), /too short/);
  assert.match(ok([L({ event: 'a', commence_at: '2026-10-06T15:00:00Z' })], 10).join(), /kicked off/);
  assert.match(ok([L({ event: 'a', state: 'in' })], 10).join(), /closed/);
  assert.match(ok([L({ event: 'a', status: 'suspended' })], 10).join(), /suspended/);
  const fan = o => L({ sport: 'fantasy', event: 'f', teams: [5, 6], ...o });
  assert.deepEqual(ok([fan({ market: 'ml', team: 6 })], 10, { voter: 5 }), [], 'betting against yourself is allowed by default');
  const strict = { rules: { ...RULES, block_self_bets: true } };
  assert.match(ok([fan({ market: 'ml', team: 6 })], 10, { voter: 5, ...strict }).join(), /against it/);
  assert.match(ok([fan({ market: 'total', side: 'under' })], 10, { voter: 5, ...strict }).join(), /against it/);
  assert.deepEqual(ok([fan({ market: 'ml', team: 5 })], 10, { voter: 5, ...strict }), []);
  assert.deepEqual(ok([fan({ market: 'ml', team: 6 })], 10, { voter: 7, ...strict }), []);
  // no cap on legs unless one is set
  const eight = Array.from({ length: 8 }, (_, i) => L({ event: 'g' + i }));
  assert.deepEqual(ok(eight, 1, { rules: { ...RULES, parlay_max_legs: null } }), []);
  assert.match(ok(eight, 1).join(), /2 to 6 legs/);
  assert.match(ok([L({ event: 'a' }), L({ event: 'a', market: 'ftd' })], 10).join(), /First and last touchdown scorer/);
});

test('ESPN athletes map to Sleeper by espn_id, else by name within the same NFL team', async () => {
  const { espnMap, normName } = await import('../scripts/players/build.mjs');
  const players = {
    '3294': { full_name: 'Dak Prescott', position: 'QB', team: 'DAL', espn_id: 2577417 },
    '8137': { full_name: 'George Pickens', position: 'WR', team: 'DAL', espn_id: null },
    '4037': { full_name: 'Chris Godwin', position: 'WR', team: 'TB', espn_id: null },
    '900':  { full_name: 'Terry McLaurin', position: 'WR', team: 'WAS', espn_id: null },
    '901':  { full_name: 'Mike Williams', position: 'WR', team: 'NYJ' },
    '902':  { full_name: 'Mike Williams', position: 'RB', team: 'NYJ' },
    '903':  { full_name: 'George Pickens', position: 'WR', team: 'PIT' },   // same name, other team
    '904':  { full_name: 'Some Lineman', position: 'OT', team: 'DAL' },
  };
  const rosters = [
    { team: 'DAL', athletes: [{ id: '4426354', name: 'George Pickens' }, { id: '1', name: 'Some Lineman' }] },
    { team: 'TB', athletes: [{ id: '3116165', name: 'Chris Godwin Jr.' }] },
    { team: 'WSH', athletes: [{ id: '3121422', name: 'Terry McLaurin' }] },
    { team: 'NYJ', athletes: [{ id: '5', name: 'Mike Williams' }] },
  ];
  const m = espnMap(players, rosters);
  assert.equal(m['2577417'].id, '3294', 'espn_id first');
  assert.equal(m['4426354'].id, '8137', 'the Dallas Pickens, not the Pittsburgh one');
  assert.equal(m['3116165'].id, '4037', 'generational suffixes are ignored');
  assert.equal(m['3121422'].id, '900', 'ESPN says WSH where Sleeper says WAS');
  assert.equal(m['5'], undefined, 'two players share the name on one roster: skipped, never guessed');
  assert.equal(m['1'], undefined, 'not a fantasy position');
  assert.equal(normName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(normName('Amon-Ra St. Brown'), 'amon ra st brown');
});

/* ---------------- same-game parlays ---------------- */
const SGP_GAME = (() => {
  const ev = board.events[0], rows = C.gameLines(ev, { season: 2026, week: 5 });
  const e = C.parseEvent(ev);
  const mk = (player, team, market, point) => ['over', 'under'].map(side => ({
    id: `prop:${e.id}:${player}:${market}:${side}`, event: `nfl:${e.id}`, sport: 'prop', market, side, point,
    price: C.americanToDecimal(-115), player, nfl_team: team, label: player, state: 'pre' }));
  const props = [
    ...mk('qbTB', 'TB', 'pass_yd', 230.5), ...mk('wr1TB', 'TB', 'rec_yd', 60.5), ...mk('wr2TB', 'TB', 'rec_yd', 40.5),
    ...mk('wr1TB', 'TB', 'rec', 4.5), ...mk('rbDAL', 'DAL', 'rush_yd', 70.5), ...mk('wrDAL', 'DAL', 'rec_yd', 80.5),
  ];
  const positions = { qbTB: 'QB', wr1TB: 'WR', wr2TB: 'WR', rbDAL: 'RB', wrDAL: 'WR' };
  return { e, rows, props, positions, event: `nfl:${e.id}` };
})();
const sim = () => C.simulateGame({ event: SGP_GAME.event, lines: SGP_GAME.rows, props: SGP_GAME.props, positions: SGP_GAME.positions });
const by = id => [...SGP_GAME.rows, ...SGP_GAME.props].find(l => l.id.endsWith(id));

test('the game simulation reproduces DraftKings prices and its own logic', () => {
  const { bits, params } = sim();
  const p = id => C.jointHits([bits[by(id).id]]) / C.SIM_N;
  const nv = (a, b) => (1 / by(a).price) / (1 / by(a).price + 1 / by(b).price);
  assert.ok(params.sdM >= 8 && params.sdM <= 20, 'the margin spread is fitted from moneyline and spread');
  for (const [a, b] of [[':ml:home', ':ml:away'], [':spread:home', ':spread:away'], [':total:over', ':total:under']])
    assert.ok(Math.abs(p(a) - nv(a, b)) < 0.025, `${a} simulated ${p(a)} vs no-vig ${nv(a, b)}`);
  for (const id of ['qbTB:pass_yd:over', 'wr1TB:rec_yd:over']) assert.ok(Math.abs(p(id) - 0.5) < 0.03, 'a prop line is the median');
  const both = (a, b) => C.jointHits([bits[by(a).id], bits[by(b).id]]);
  assert.equal(both(':spread:home', ':ml:home'), C.jointHits([bits[by(':spread:home').id]]), 'a DAL -9.5 cover is always a DAL win');
  assert.equal(both(':total:over', ':total:under'), 0, 'over and under never both win');
  assert.equal(both(':ml:home', ':ml:away'), 0);
  // deterministic: the same game on the same seeds gives the same bits
  assert.deepEqual(sim().bits[by('qbTB:pass_yd:over').id], bits[by('qbTB:pass_yd:over').id]);
  // and a game line simulated alone shares its games with the full simulation
  const alone = C.simulateGame({ event: SGP_GAME.event, lines: SGP_GAME.rows }).bits;
  assert.deepEqual(alone[by(':total:over').id], bits[by(':total:over').id]);
});

test('the simulation links legs the way football does, erring towards more correlation', () => {
  const { bits } = sim();
  const corr = (a, b) => {
    const x = bits[by(a).id], y = bits[by(b).id], n = C.SIM_N;
    const pa = C.jointHits([x]) / n, pb = C.jointHits([y]) / n, pab = C.jointHits([x, y]) / n;
    return (pab - pa * pb) / Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
  };
  const latent = c => Math.sin(c * Math.PI / 2);     // indicator correlation back to the underlying one
  const qbwr = latent(corr('qbTB:pass_yd:over', 'wr1TB:rec_yd:over'));
  assert.ok(qbwr > 0.45 && qbwr < 0.7, `QB yards vs his receiver: ${qbwr.toFixed(2)}`);
  const self = latent(corr('wr1TB:rec:over', 'wr1TB:rec_yd:over'));
  assert.ok(self > 0.7, `a receiver's catches vs his yards: ${self.toFixed(2)}`);
  const ou = latent(corr('qbTB:pass_yd:over', ':total:over'));
  assert.ok(ou > 0.3, `QB yards vs the game total: ${ou.toFixed(2)}`);
  const rb = latent(corr('rbDAL:rush_yd:over', ':ml:home'));
  assert.ok(rb > 0.2, `a running back vs his team winning: ${rb.toFixed(2)}`);
  const opp = latent(corr('qbTB:pass_yd:over', 'wrDAL:rec_yd:over'));
  assert.ok(opp > 0 && opp < 0.35, `opposing passing games: ${opp.toFixed(2)}`);
});

test('a same-game group pays the simulated chance less the hold, never more than the legs multiplied', () => {
  const { bits } = sim();
  const simOf = id => bits[id];
  const legs = ids => ids.map(i => ({ ...by(i), status: 'open' }));
  // DAL -9.5 with DAL ML is just the spread bet: less than the spread alone pays
  const cover = C.ticketPrice(legs([':spread:home', ':ml:home']), simOf, RULES);
  assert.ok(cover.price < by(':spread:home').price, `priced ${cover.price}, spread alone ${by(':spread:home').price}`);
  // a stack pays less than multiplied, because the legs move together
  const stack = C.ticketPrice(legs(['qbTB:pass_yd:over', 'wr1TB:rec_yd:over']), simOf, RULES);
  const naive = by('qbTB:pass_yd:over').price * by('wr1TB:rec_yd:over').price;
  assert.ok(stack.price < naive * 0.85, `stack ${stack.price} vs multiplied ${naive}`);
  // opposite directions are capped at multiplied, so a correlation guess can't hand out an edge
  const mixed = C.ticketPrice(legs(['qbTB:pass_yd:over', 'wr1TB:rec_yd:under']), simOf, RULES);
  assert.ok(mixed.price <= Math.round(naive * 10000) / 10000 + 1e-9, `mixed ${mixed.price} never above ${naive}`);
  assert.match(C.ticketPrice(legs([':total:over', ':total:under']), simOf, RULES).err, /can't all win together/);
  assert.match(C.ticketPrice(legs([':ml:home', ':ml:away']), simOf, RULES).err, /can't all win together/);
  assert.match(C.ticketPrice(legs([':total:over', 'qbTB:pass_yd:over']), () => null, RULES).err, /isn't priced/);
  // a leg from another game multiplies in as usual
  const other = { id: 'nfl:2:ml:home', event: 'nfl:2', sport: 'nfl', price: 2, state: 'pre' };
  const two = C.ticketPrice([...legs(['qbTB:pass_yd:over', 'wr1TB:rec_yd:over']), other], simOf, RULES);
  assert.equal(two.price, Math.round(stack.price * 2 * 10000) / 10000);
  assert.equal(two.sgp.length, 1);
});

test('a same-game group settles as one: all win to pay, any push or void takes the game out', () => {
  const s = legs => C.settleBet({ kind: 'parlay', stake: 10 }, legs, RULES);
  const g = (result, extra = {}) => ({ event: 'nfl:1', price: 1.87, group_price: 2.4, result, ...extra });
  const solo = result => ({ event: 'nfl:2', price: 2, group_price: 2, result });
  assert.deepEqual(s([g('win'), g('win'), solo('win')]), { status: 'won', payout: 48 }, 'the group pays its own price, not multiplied');
  assert.deepEqual(s([g('win'), g('void'), solo('win')]), { status: 'won', payout: 20 }, 'a void in the group takes the game out');
  assert.deepEqual(s([g('win'), g('push')]), { status: 'push', payout: 10 }, 'nothing left: refunded');
  assert.deepEqual(s([g('win'), g('loss'), solo('win')]), { status: 'lost', payout: 0 });
  assert.equal(s([g('win'), g(null)]), null, 'still waiting on a leg');
});

/* ---------------- FanDuel props and touchdown markets ---------------- */
const fdFixture = JSON.parse(readFileSync(new URL('./fixtures/fanduel-tbdal.json', import.meta.url), 'utf8'));
const fdPage = JSON.parse(readFileSync(new URL('./fixtures/fanduel-nfl-page.json', import.meta.url), 'utf8'));
const fdPlayers = {
  e1: { id: '3294', name: 'Dak Prescott', team: 'DAL' }, e2: { id: '6786', name: 'CeeDee Lamb', team: 'DAL' },
  e3: { id: '8137', name: 'George Pickens', team: 'DAL' }, e4: { id: '8110', name: 'Jake Ferguson', team: 'DAL' },
  e5: { id: '7588', name: 'Javonte Williams', team: 'DAL' }, e6: { id: '11584', name: 'Bucky Irving', team: 'TB' },
  e7: { id: '4037', name: 'Chris Godwin', team: 'TB' }, e8: { id: '13425', name: 'Jalon Daniels', team: 'TB' },
  e9: { id: '12514', name: 'Emeka Egbuka', team: 'TB' }, e10: { id: '9999', name: 'Ted Hurst', team: 'TB' },
  e11: { id: '9998', name: 'Tez Johnson', team: 'TB' }, e12: { id: '8111', name: 'Cade Otton', team: 'TB' },
  e13: { id: '5555', name: 'CeeDee Lamb', team: 'NYG' },          // same name, another team: never chosen
};
const fdEvent = () => C.parseEvent(board.events[0]);
const fdRows = () => C.fdPropLines(fdFixture.attachments.markets, fdEvent(), { season: 2026, week: 5, idx: C.playerIndex(fdPlayers) });

test('FanDuel games are matched to ESPN games by team names and kickoff', () => {
  const e = fdEvent();
  assert.equal(e.homeName, 'Dallas Cowboys');
  assert.equal(C.fdMatch(C.fdGames(fdPage), e)?.id, String(fdFixture.eventId));
  assert.equal(C.fdMatch(C.fdGames(fdPage), { ...e, commence: '2026-12-25T00:00:00Z' }), null, 'same teams, another week');
});

test('FanDuel props carry real prices: over/unders, milestones and touchdown scorers', () => {
  const rows = fdRows();
  const ids = new Set(rows.map(r => r.id));
  assert.equal(ids.size, rows.length);
  const td = rows.filter(r => C.TD_COUNT[r.market] || C.TD_ORDER[r.market]);
  assert.ok(td.length > 10 && td.every(r => r.side === 'yes' && r.point === null));
  const lamb = rows.find(r => r.player === '6786' && r.market === 'atd');
  assert.ok(lamb, 'CeeDee Lamb anytime TD is offered');
  assert.ok(new Set(td.map(r => r.american)).size > 5, 'real prices, all different: -230, +115, +195...');
  assert.ok(!rows.some(r => r.player === '5555'), 'the other CeeDee Lamb is never matched');
  // an over/under always has both sides at one line
  for (const o of rows.filter(r => r.side === 'over' && !/:ms\d+$/.test(r.id))) {
    const u = rows.find(r => r.id === o.id.replace(/:over$/, ':under'));
    assert.ok(u && u.point === o.point, o.id);
  }
  // a milestone is an over at k - 0.5, priced on its own
  const ms = rows.filter(r => /:ms\d+$/.test(r.id));
  assert.ok(ms.length > 20);
  for (const m of ms) assert.equal(m.point, Number(m.id.match(/:ms(\d+)$/)[1]) - 0.5);
  assert.ok(ms.some(m => m.american > 0) && ms.some(m => m.american < 0), 'ladders run from favourites to long shots');
});

test('touchdown markets settle from the player\'s own touchdowns, first and last from the scorer', () => {
  const p = market => ({ sport: 'prop', market, side: 'yes', player: '6786' });
  assert.deepEqual(C.propOutcome({ gp: 1, rec_td: 1, rush_td: 1, pass_td: 3 }, 'atd'), { played: true, tds: 2 }, 'passing TDs are the receivers\'');
  assert.equal(C.gradeLeg(p('atd'), null, { played: true, tds: 1 }), 'win');
  assert.equal(C.gradeLeg(p('td2'), null, { played: true, tds: 1 }), 'loss');
  assert.equal(C.gradeLeg(p('td2'), null, { played: true, tds: 2 }), 'win');
  assert.equal(C.gradeLeg(p('atd'), null, { played: false }), 'void', 'did not play: void, as at FanDuel');
  assert.equal(C.gradeLeg(p('ftd'), null, { played: true, scorer: '6786' }), 'win');
  assert.equal(C.gradeLeg(p('ftd'), null, { played: true, scorer: 'other' }), 'loss', 'a defensive touchdown first');
  assert.equal(C.gradeLeg(p('ltd'), null, { played: true, scorer: null }), 'loss', 'nobody scored one');
  // milestones grade as overs at k - 0.5
  assert.equal(C.gradeLeg({ sport: 'prop', market: 'rec_yd', side: 'over' }, 49.5, { played: true, value: 50 }), 'win');
  assert.equal(C.gradeLeg({ sport: 'prop', market: 'rec_yd', side: 'over' }, 49.5, { played: true, value: 49 }), 'loss');
  // ESPN's scoring plays: first and last touchdowns, and the scorer by athlete id
  const plays = C.tdPlays({ scoringPlays: [{ id: 'fg', scoringType: { name: 'field-goal' } },
    { id: 'p1', scoringType: { name: 'touchdown' } }, { id: 'p2', scoringType: { name: 'touchdown' } }] });
  assert.deepEqual(plays, { first: 'p1', last: 'p2', any: true });
  assert.equal(C.scorerOf({ participants: [{ type: 'passer', athlete: { $ref: '.../athletes/111' } },
    { type: 'scorer', athlete: { $ref: '.../athletes/4241389?lang=en' } }] }), '4241389');
});

test('milestones and touchdown counts nest inside the simulation, and first/last scorer stay out', () => {
  const rows = fdRows(), e = fdEvent();
  const { bits } = C.simulateGame({ event: 'nfl:' + e.id, lines: C.gameLines(board.events[0], { season: 2026, week: 5 }), props: rows,
    positions: { 6786: 'WR', 8137: 'WR', 7588: 'RB', 3294: 'QB', 13425: 'QB' } });
  const hits = id => C.jointHits([bits[id]]);
  // a higher milestone only wins where a lower one does
  const ladder = rows.filter(r => /:ms\d+$/.test(r.id) && r.market === 'rec_yd').reduce((a, r) => ((a[r.player] ||= []).push(r), a), {});
  const one = Object.values(ladder).find(l => l.length >= 3).sort((a, b) => a.point - b.point);
  for (let i = 1; i < one.length; i++)
    assert.equal(C.jointHits([bits[one[i].id], bits[one[i - 1].id]]), hits(one[i].id), `${one[i].id} inside ${one[i - 1].id}`);
  // 2+ touchdowns only where anytime
  const td2 = rows.find(r => r.market === 'td2'), atd = rows.find(r => r.market === 'atd' && r.player === td2.player);
  assert.equal(C.jointHits([bits[td2.id], bits[atd.id]]), hits(td2.id));
  assert.ok(rows.filter(r => C.TD_ORDER[r.market]).every(r => !bits[r.id]), 'first/last scorer have no simulation');
});

test('with no ceilings set, nothing caps a stake, a price, a parlay or a payout', () => {
  const open = { ...RULES, max_stake_straight: null, max_stake_parlay: null, max_payout: null, parlay_max_price: null,
    leg_max_price: null, parlay_max_legs: null };
  const now = Date.parse('2026-10-06T16:00:00Z');
  const L = o => ({ status: 'open', state: 'pre', sport: 'nfl', price: 2, commence_at: '2026-10-09T00:15:00Z', label: 'X', ...o });
  assert.deepEqual(C.checkSlip({ legs: [L({ event: 'a', price: 61 })], stake: 5000, rules: open, now }), [], 'a big stake at +6000');
  const twenty = Array.from({ length: 20 }, (_, i) => L({ event: 'e' + i }));
  assert.deepEqual(C.checkSlip({ legs: twenty, stake: 100, rules: open, now }), []);
  assert.equal(C.parlayPrice(twenty.map(l => l.price), C.lim(open.parlay_max_price)), 1048576);
  assert.equal(C.ticketPrice(twenty, () => null, open).price, 1048576);
  // settlement pays in full: a null ceiling must never read as $0
  assert.deepEqual(C.settleBet({ kind: 'parlay', stake: 100 }, twenty.map(l => ({ price: 2, result: 'win' })), open),
    { status: 'won', payout: 104857600 });
  assert.deepEqual(C.settleBet({ kind: 'straight', stake: 400 }, [{ price: 61, result: 'win' }], open), { status: 'won', payout: 24400 });
  assert.equal(C.lim(null), Infinity);
  assert.equal(C.lim(undefined), Infinity);
  assert.equal(C.lim('1000.00'), 1000);
  assert.match(C.checkSlip({ legs: [L({ event: 'a', price: 1.1 })], stake: 10, rules: open, now }).join(), /too short/, 'the -500 floor stays');
});
