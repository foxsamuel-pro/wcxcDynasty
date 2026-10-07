/* Futures: WCXC's priced from the league's own forecast, the NFL's from
   FanDuel, and every one of them settled only once its question is answered.
   Real responses wherever they decide money: Sleeper's finished 2025 season
   and the PROJECTED bracket it serves in the middle of this one, ESPN's final
   2025 standings and the Super Bowl, and FanDuel's futures as they stood. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  futurePrice, priceFromProb, wcxcFutureLines, wcxcField, wcxcStandings, wcxcSettlement, bracketTeams,
  nflFutureLines, nflPlayoffFates, superBowlWinner, NFL_ABBR, gradeLeg, checkSlip, futureAgainstOwn, americanToDecimal,
} from '../supabase/functions/_shared/casino.mjs';
import { seedField, rng } from '../scripts/odds/model.mjs';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const league25 = fx('sleeper-2025-league.json'), rosters25 = fx('sleeper-2025-rosters.json'), bracket25 = fx('sleeper-2025-bracket.json');

/* ---------------- pricing ---------------- */

test('a forecast chance becomes a price with the hold on top; long shots are capped and near-certainties left off', () => {
  const hold = 0.05;
  assert.deepEqual(futurePrice(0.5, hold), priceFromProb(0.5, hold), 'the same arithmetic as a WCXC matchup');
  assert.equal(futurePrice(0.0004, hold), null, 'fewer than 5 seasons in 10,000: off the board');
  // half the hold alone is 2.5%, so at the default hold no long shot pays better than about +3900
  assert.equal(futurePrice(0.0005, hold).american, 3822);
  assert.ok(futurePrice(0.01, hold).american < 3900);
  assert.equal(futurePrice(0.0005, 0.01).american, 4900, 'and with a thin hold the 2% floor stops it at +4900');
  assert.equal(futurePrice(0.956, hold), null, 'past 98% with the hold on there is no fair price to offer');
  assert.equal(futurePrice(0.95, hold).american, -3900);
  // whatever the forecast says, the house never offers a bet it expects to lose
  for (let p = 0.0005; p < 0.97; p += 0.0005) {
    const pr = futurePrice(p, hold);
    if (pr) assert.ok(p * pr.price < 1, `at ${p.toFixed(4)}, ${pr.american} would be a gift`);
  }
});

// A forecast shaped like odds.json: twelve rows that add up the way the real one does
function forecast(version = 3) {
  const title = [0.30, 0.20, 0.15, 0.12, 0.08, 0.06, 0.04, 0.03, 0.015, 0.004, 0.0009, 0.0001];
  const po = [0.995, 0.97, 0.9, 0.8, 0.7, 0.6, 0.45, 0.3, 0.15, 0.08, 0.04, 0.0];
  const div = [0.7, 0.6, 0.5, 0.25, 0.2, 0.25, 0.3, 0.1, 0.05, 0.03, 0.01, 0.01];
  return { modelVersion: version, leagueId: '1312128506452283392', season: 2026, sims: 10000, firstOpen: 6, lastRegular: 14,
    generated: '2026-10-06T16:51:41Z', rows: title.map((t, i) => ({ id: i + 1, title: t, po: po[i], div: div[i] })) };
}
const divisions = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, (i % 3) + 1]));
const divNames = { 1: 'Uher’s Most Hated', 2: 'Loughman’s Fog', 3: 'Ali’s Children' };
const opts = { season: 2026, week: 6, commence: '2026-10-16T00:15:00Z', hold: 0.05, divisions, divNames };

test('WCXC futures are only priced from a forecast that reads Sleeper\'s bracket properly', () => {
  assert.deepEqual(wcxcFutureLines(forecast(2), opts), [], 'model 2 took the projected mid-season bracket as real');
  const lines = wcxcFutureLines(forecast(3), opts);
  const by = m => lines.filter(l => l.market === m);
  // the title: everyone the forecast gives a real chance, nobody it doesn't
  assert.deepEqual(by('title').map(l => l.team), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'team 12 is off the board at 1 in 10,000');
  assert.ok(by('title').every(l => l.event === 'fut:wcxc:2026:title' && l.side === String(l.team)));
  // make the playoffs: each team its own event, both sides where both can be priced
  const po1 = by('po').filter(l => l.team === 1), po12 = by('po').filter(l => l.team === 12);
  assert.deepEqual(po1.map(l => l.side), ['no'], 'a 99.5% team has no "yes" anyone could be fairly offered');
  assert.deepEqual(po12.map(l => l.side), [], 'a team with no chance offers nothing: its "yes" is off the board and its "no" a certainty');
  assert.deepEqual(by('po').filter(l => l.team === 7).map(l => l.side).sort(), ['no', 'yes']);
  assert.ok(by('po').every(l => l.event === `fut:wcxc:2026:po:${l.team}`));
  // divisions: grouped by Sleeper's division, under the league's own names
  const d1 = by('div').filter(l => l.event === 'fut:wcxc:2026:div:1');
  assert.deepEqual(d1.map(l => l.team), [1, 4, 7, 10]);
  assert.ok(d1.every(l => l.event_label === 'Uher’s Most Hated'));
  // everything closes at the week's first kickoff, like a game line
  assert.ok(lines.every(l => l.sport === 'future' && l.state === 'pre' && l.commence_at === opts.commence && l.price > 1));
  // and the playoffs-only switches
  assert.ok(wcxcFutureLines(forecast(3), { ...opts, regular: false }).every(l => l.market === 'title'));
});

/* ---------------- settlement: WCXC ---------------- */

test("the settlement seeds the field exactly as the forecast does, without the coin flip", () => {
  const random = rng(20261007);
  for (let n = 0; n < 400; n++) {
    const teams = Array.from({ length: 12 }, (_, i) => {
      const w = Math.floor(random() * 29);
      return { id: i + 1, div: (i % 3) + 1, w, l: 28 - w, t: 0, pf: 1000 + Math.round(random() * 80000) / 100, pa: 1000 + Math.round(random() * 80000) / 100 };
    });
    const mine = wcxcField(teams);
    if (mine.tied) continue;
    const theirs = seedField(teams.map(t => ({ id: t.id, div: t.div })), Object.fromEntries(teams.map(t => [t.id, t])), random);
    assert.deepEqual(mine.winners, theirs.winners.map(t => t.id));
    assert.deepEqual(mine.byes, theirs.byes.map(t => t.id));
    assert.deepEqual(mine.seeds, theirs.seeds.map(t => t.id));
  }
  // a tie no tiebreaker separates can't be settled by a program
  const flat = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, div: (i % 3) + 1, w: 14, l: 14, t: 0, pf: 2000, pa: 2000 }));
  assert.equal(wcxcField(flat).tied, true);
});

test("a finished season settles from Sleeper's own bracket, checked against its standings", () => {
  const st = wcxcSettlement({ league: league25, rosters: rosters25, bracket: bracket25 });
  assert.equal(st.why, null);
  assert.deepEqual(Object.entries(st.po).filter(([, v]) => v).map(([k]) => +k), [1, 2, 5, 6, 7, 11]);
  assert.deepEqual(st.div, { 1: 1, 2: 5, 3: 7 });
  assert.equal(st.title, 1);
  assert.equal(String(st.title), String(league25.metadata.latest_league_winner_roster_id), "the same champion Sleeper's own record names");
  assert.deepEqual([...bracketTeams(bracket25)].sort((a, b) => a - b), [1, 2, 5, 6, 7, 11]);
});

test("in the middle of a season, Sleeper's projected bracket settles nothing", () => {
  const league = fx('sleeper-2026-league-w5.json'), projected = fx('sleeper-2026-bracket-w5.json');
  assert.equal(bracketTeams(projected).size, 6, 'Sleeper does serve a full field in Week 5');
  const st = wcxcSettlement({ league, rosters: rosters25, bracket: projected });
  assert.deepEqual([st.po, st.div, st.title], [null, null, null]);
  assert.equal(st.why, 'regular season not over');
});

test('when anything disagrees, nothing settles and the report says why', () => {
  const copy = x => structuredClone(x);
  // a bracket with a team the standings left out
  const wrong = copy(bracket25); wrong[0].t2 = 3;
  assert.equal(wcxcSettlement({ league: league25, rosters: rosters25, bracket: wrong }).why, 'bracket and standings disagree');
  // the byes given to the wrong division winners
  const byes = copy(bracket25); for (const g of byes) if (g.r === 2 && g.p == null) g.t1 = g.t1 === 1 ? 6 : g.t1;
  assert.notEqual(wcxcSettlement({ league: league25, rosters: rosters25, bracket: byes }).why, null);
  // a roster still missing a result: Sleeper hasn't caught up
  const short = copy(rosters25); short[0].settings.losses -= 1;
  assert.equal(wcxcSettlement({ league: league25, rosters: short, bracket: bracket25 }).why, 'standings incomplete');
  // the regular season scored but not the final: the field settles, the title waits
  const mid = copy(league25); mid.settings.last_scored_leg = 15;
  const st = wcxcSettlement({ league: mid, rosters: rosters25, bracket: bracket25 });
  assert.ok(st.po && st.div);
  assert.equal(st.title, null);
  // a league that isn't this league's shape
  const ten = copy(league25); ten.settings.playoff_teams = 4;
  assert.equal(wcxcSettlement({ league: ten, rosters: rosters25, bracket: bracket25 }).why, 'league format changed');
});

/* ---------------- the NFL ---------------- */

test("FanDuel's NFL futures: the Super Bowl and every team's playoffs, both ways, at FanDuel's prices", () => {
  const lines = nflFutureLines(fx('fanduel-nfl-futures.json').attachments.markets, { season: 2026, week: 5, commence: '2026-10-09T00:15:00Z' });
  const sb = lines.filter(l => l.market === 'sb'), po = lines.filter(l => l.market === 'nflpo');
  assert.equal(sb.length, 32);
  assert.ok(sb.every(l => l.event === 'fut:nfl:2026:sb' && l.event_label === 'Super Bowl LXI' && l.side === l.label));
  assert.equal(new Set(po.map(l => l.label)).size, 32, 'every team has a playoff market');
  assert.ok(po.every(l => l.event === `fut:nfl:2026:nflpo:${l.label}` && /^(AFC|NFC) playoffs$/.test(l.event_label)));
  assert.ok(po.filter(l => l.side === 'yes').length >= 30 && po.filter(l => l.side === 'no').length >= 30);
  assert.ok(lines.every(l => l.price === americanToDecimal(l.american)));
  assert.ok(sb.some(l => l.label === 'WSH'), "Washington under ESPN's abbreviation, which draws its logo");
  assert.equal(Object.keys(NFL_ABBR).length, 32);
  assert.equal(new Set(Object.values(NFL_ABBR)).size, 32);
  // a suspended market offers nothing
  const shut = structuredClone(fx('fanduel-nfl-futures.json').attachments.markets);
  for (const m of Object.values(shut)) m.marketStatus = 'SUSPENDED';
  assert.deepEqual(nflFutureLines(shut, { season: 2026, week: 5, commence: '2026-10-09T00:15:00Z' }), []);
});

test("ESPN's clinch codes settle each NFL team the moment its season is decided; the Super Bowl when it is final", () => {
  const fates = nflPlayoffFates(fx('espn-standings-2025.json'));
  assert.equal(Object.values(fates).filter(Boolean).length, 14, 'fourteen teams in');
  assert.equal(Object.values(fates).filter(v => v === false).length, 18, 'eighteen out');
  assert.equal(fates.SEA, true);
  assert.equal(fates.NE, true);
  // a team with no code yet is undecided, not out
  const open = structuredClone(fx('espn-standings-2025.json'));
  for (const c of open.children) for (const e of c.standings.entries) e.stats = e.stats.filter(s => (s.name || s.type) !== 'clincher');
  assert.deepEqual(nflPlayoffFates(open), {});
  const sb = fx('espn-superbowl-2025.json');
  assert.equal(superBowlWinner(sb), 'SEA');
  const unfinished = structuredClone(sb); unfinished.events[0].competitions[0].status.type.completed = false;
  assert.equal(superBowlWinner(unfinished), null);
});

/* ---------------- grading and the slip ---------------- */

test('a future grades on its answer', () => {
  const po = side => ({ sport: 'future', market: 'po', side });
  assert.equal(gradeLeg(po('yes'), null, { made: true }), 'win');
  assert.equal(gradeLeg(po('no'), null, { made: true }), 'loss');
  assert.equal(gradeLeg(po('no'), null, { made: false }), 'win');
  const title = team => ({ sport: 'future', market: 'title', side: String(team) });
  assert.equal(gradeLeg(title(1), null, { winner: 1 }), 'win', 'a roster id against a side held as text');
  assert.equal(gradeLeg(title(5), null, { winner: 1 }), 'loss');
  assert.equal(gradeLeg({ sport: 'future', market: 'sb', side: 'SEA' }, null, { winner: 'SEA' }), 'win');
  assert.equal(gradeLeg(title(1), null, { void: true }), 'void');
  assert.equal(gradeLeg(title(1), null, {}), null, 'no answer, no grade');
});

test('futures on the slip: single bets only, shut outside their window, and never against your own team', () => {
  const rules = { min_stake: 1, parlay_min_legs: 2, block_self_bets: true };
  const FUT = '2099-01-01T00:00:00Z';
  const f = o => ({ sport: 'future', state: 'pre', status: 'open', price: 3, commence_at: FUT, label: 'X', ...o });
  const t3 = f({ id: 't3', event: 'fut:wcxc:2026:title', market: 'title', team: 3 }), t4 = f({ id: 't4', event: 'fut:wcxc:2026:title', market: 'title', team: 4 });
  const no3 = f({ id: 'n3', event: 'fut:wcxc:2026:po:3', market: 'po', side: 'no', team: 3 });
  const board = [t3, t4, no3];
  assert.equal(futureAgainstOwn(no3, 3, board), true);
  assert.equal(futureAgainstOwn(no3, 4, board), false);
  assert.equal(futureAgainstOwn(t4, 3, board), true, 'team 3 is listed in the race');
  assert.equal(futureAgainstOwn(t4, 5, board), false, 'team 5 is not');
  assert.equal(futureAgainstOwn(t4, 3, [t4]), false, 'once team 3 is off the board, the race opens up');
  assert.equal(futureAgainstOwn(f({ event: 'fut:nfl:2026:sb', market: 'sb' }), 3, board), false);
  assert.match(checkSlip({ legs: [t4], stake: 10, voter: 3, rules, board }).join(), /only team you can back in it is your own/);
  assert.match(checkSlip({ legs: [no3], stake: 10, voter: 3, rules, board }).join(), /can't bet against it/);
  assert.deepEqual(checkSlip({ legs: [t3], stake: 10, voter: 3, rules, board }), []);
  assert.match(checkSlip({ legs: [t3, f({ id: 'x', event: 'other' })], stake: 10, voter: 5, rules, board }).join(), /Futures are single bets/);
  assert.deepEqual(checkSlip({ legs: [t3, t4], stake: 10, voter: 5, rules, board, mode: 'singles' }), [], 'as singles, both go');
  assert.match(checkSlip({ legs: [f({ commence_at: '2020-01-01T00:00:00Z' })], stake: 10, voter: 5, rules }).join(), /closed for betting right now/);
});
