/* College football: DraftKings' lines through ESPN's FBS scoreboard, FanDuel's
   player props for the games that have them, and settlement from ESPN's box
   score. Every fixture is a real response (Week 6 of 2026; a finished North
   Texas-Tulsa game for the box score), trimmed to what the code reads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseEvent, gameLines, cfbGameRow, fdGames, fdMatchCfb, fdRunnerTeam, findCfbPlayer, fdCfbPropLines, cfbNameKey,
  cfbBox, cfbStatsFor, cfbPropOutcome, cfbLiveValue, gradeLeg, sameGameProblems, checkSlip, lineStatus,
} from '../supabase/functions/_shared/casino.mjs';
import { slateTeams, teamRows, apRanks, rosterIndex } from '../scripts/cfb/build.mjs';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const board = fx('espn-cfb-scoreboard.json');
const events = board.events.map(parseEvent);
const uga = events.find(e => e.homeShort === 'Alabama');
const rosters = fx('cfb-players-ugaala.json').teams;
const markets = fx('fanduel-cfb-ugaala.json').attachments.markets;

test('a college game is priced from the same DraftKings feed, named by school and keyed by ESPN team id', () => {
  const lines = gameLines(uga, { season: 2026, week: 6, sport: 'cfb' });
  assert.equal(lines.length, 6, 'moneyline, spread and total, both sides each');
  assert.ok(lines.every(l => l.sport === 'cfb' && l.event === `cfb:${uga.id}` && l.id.startsWith(`cfb:${uga.id}:`)));
  const home = lines.find(l => l.market === 'ml' && l.side === 'home');
  assert.equal(home.label, 'Alabama', 'the school, not "ALA"');
  assert.equal(home.nfl_team, '333', "ESPN's team id: abbreviations collide (two OSUs) and the page finds logo, colours and rank by it");
  assert.equal(lines.find(l => l.market === 'total').nfl_team, null);
  assert.equal(home.event_label, 'Georgia @ Alabama');
  // the NFL's own lines are untouched by the option
  const nfl = gameLines(uga, { season: 2026, week: 6 });
  assert.ok(nfl.every(l => l.sport === 'nfl' && l.label !== 'Alabama'));
  // a college game is never live-bettable, whatever the commissioner does with the NFL
  assert.equal(lineStatus(null, { ...home, state: 'in' }, { live_enabled: true }), 'closed');
  // its ticket box: ESPN team ids for sides, which the page names from cfb.json
  const row = cfbGameRow(uga, { season: 2026, week: 6 });
  assert.deepEqual([row.event, row.sport, row.away, row.home], [`cfb:${uga.id}`, 'cfb', '61', '333']);
});

test("college games find FanDuel's twin even where the two name a school differently", () => {
  const games = fdGames(fx('fanduel-cfb-page.json'));
  const pairs = events.map(e => [e, fdMatchCfb(games, e)]);
  assert.ok(pairs.every(([, g]) => g), 'all five games on the fixture');
  const named = (away, home) => pairs.find(([e]) => e.awayShort === away && e.homeShort === home)[1];
  assert.deepEqual([named('Old Dominion', 'App State').away, named('Old Dominion', 'App State').home], ['Old Dominion', 'Appalachian State']);
  assert.equal(named('UConn', 'Temple').away, 'Connecticut', 'one school agreeing at the same kickoff is enough');
  assert.equal(named('Georgia', 'Alabama').id, '35632859');
  // but not when that would be a guess between two games
  const twin = { ...games.find(g => g.home === 'Temple'), id: 'other', away: 'Somebody Else' };
  assert.equal(fdMatchCfb([...games, twin], events.find(e => e.homeShort === 'Temple')), null);
  // and never a game at another time
  const late = games.map(g => ({ ...g, start: '2026-11-01T00:00:00Z' }));
  assert.equal(fdMatchCfb(late, uga), null);
});

test("college props: FanDuel's prices, each player found on his own team's ESPN roster", () => {
  const lines = fdCfbPropLines(markets, uga, { season: 2026, week: 6, rosters });
  assert.ok(lines.length > 100);
  assert.ok(lines.every(l => l.sport === 'cprop' && l.event === `cfb:${uga.id}` && !/\s/.test(l.id)), 'ids carry no spaces');
  // on the roster: his ESPN id, his number, his team
  const rcw = lines.find(l => l.label === 'Ryan Coleman-Williams' && l.market === 'rec_yd' && l.side === 'over' && !/:ms/.test(l.id));
  assert.deepEqual([rcw.player, rcw.jersey, rcw.nfl_team, rcw.point], ['5141711', 1, '333', 64.5]);
  assert.equal(rcw.id, `cprop:${uga.id}:a5141711:rec_yd:over`);
  assert.ok(lines.some(l => l.id === rcw.id.replace(':over', ':under')), 'an over/under is offered only with both sides');
  // a ladder rung is an over at k - 0.5
  const rung = lines.find(l => l.label === 'Ryan Coleman-Williams' && l.id.endsWith(':rec_yd:ms50'));
  assert.equal(rung.point, 49.5);
  // ESPN's roster doesn't list Georgia's quarterback: keyed by name, within the team FanDuel's jersey image names
  const qb = lines.filter(l => l.label === 'Gunner Stockton');
  assert.ok(qb.length > 0);
  assert.ok(qb.every(l => l.player === 'n-gunner-stockton' && l.nfl_team === '61' && l.jersey === null));
  // a team's defence is not a player, whatever the anytime-TD list says
  assert.ok(!lines.some(l => / Defense$/.test(l.label)));
  assert.ok(lines.some(l => l.market === 'atd' && l.side === 'yes'));
  // the side of a selection comes off its jersey image
  const runner = Object.values(markets).find(m => m.marketType === 'ANY_TIME_TOUCHDOWN_SCORER_CFB').runners.find(r => r.runnerName === 'Gunner Stockton');
  assert.equal(fdRunnerTeam(runner, uga), '61');
  // and a name two players on one roster share is skipped, never guessed
  assert.equal(findCfbPlayer({ 333: { 'jo smith': 0 } }, 'Jo Smith', ['333']), null);
  assert.equal(findCfbPlayer({ 333: { 'jo smith': ['1', 4] }, 61: { 'jo smith': ['2', 9] } }, 'Jo Smith', ['333', '61']), null, 'or one on each side');
});

test("a college box score settles props by ESPN id, or by name within the team", () => {
  const box = cfbBox(fx('espn-cfb-summary.json'));
  assert.equal(box.completed, true);
  assert.deepEqual([box.home.id, box.home.score, box.away.id, box.away.score], ['202', 44, '249', 45]);
  const reese = { sport: 'cprop', player: '4827049', nfl_team: '249' };
  assert.deepEqual(cfbPropOutcome(cfbStatsFor(box, { ...reese, market: 'rec_yd' }), 'rec_yd'), { played: true, value: 101 });
  assert.deepEqual(cfbPropOutcome(cfbStatsFor(box, reese), 'rec'), { played: true, value: 5 });
  assert.deepEqual(cfbPropOutcome(cfbStatsFor(box, reese), 'atd'), { played: true, tds: 1 });
  // the passer's touchdown passes are his receivers'; his own run is his
  const qb = cfbStatsFor(box, { player: '4801307' });
  assert.deepEqual([qb.pass_yd, qb.pass_td, qb.pass_cmp, qb.pass_att, qb.pass_int], [332, 4, 24, 39, 2]);
  assert.deepEqual(cfbPropOutcome(qb, 'atd'), { played: true, tds: 1 });
  // the same receiver, keyed by name because ESPN's roster had missed him
  const byName = { sport: 'cprop', player: `n-${cfbNameKey('Max Reese')}`, nfl_team: '249' };
  assert.equal(cfbStatsFor(box, byName), cfbStatsFor(box, reese));
  assert.equal(cfbStatsFor(box, { ...byName, nfl_team: '202' }), undefined, 'only within his own team');
  // somebody ESPN doesn't list didn't play: the bet voids, as a book voids a player who sits
  assert.deepEqual(cfbPropOutcome(cfbStatsFor(box, { player: '999' }), 'rec_yd'), { played: false });
  assert.deepEqual(cfbPropOutcome(cfbStatsFor(box, { player: 'n-nobody-here', nfl_team: '249' }), 'rec_yd'), { played: false });
  // the running number on a ticket reads the same keys
  assert.equal(cfbLiveValue(cfbStatsFor(box, reese), 'rec_yd'), 101);
  assert.equal(cfbLiveValue(cfbStatsFor(box, reese), 'atd'), 1);
  // a defensive score sits in two of ESPN's columns and counts once
  assert.deepEqual(cfbPropOutcome({ gp: 1, int_td: 1, def_td: 1 }, 'atd'), { played: true, tds: 1 });
  assert.deepEqual(cfbPropOutcome({ gp: 1, rush_td: 1, kr_td: 1 }, 'td2'), { played: true, tds: 2 });
});

test('college lines and props grade like their NFL twins; no same-game parlay is priced for a college game', () => {
  const l = (market, side) => ({ sport: 'cfb', market, side });
  const final = { home: 44, away: 45 };
  assert.equal(gradeLeg(l('ml', 'away'), null, final), 'win');
  assert.equal(gradeLeg(l('spread', 'home'), 1.5, final), 'win');
  assert.equal(gradeLeg(l('spread', 'home'), -1.5, final), 'loss');
  assert.equal(gradeLeg(l('total', 'over'), 88.5, final), 'win');
  assert.equal(gradeLeg({ sport: 'cprop', market: 'rec_yd', side: 'over' }, 99.5, { played: true, value: 101 }), 'win');
  assert.equal(gradeLeg({ sport: 'cprop', market: 'rec_yd', side: 'under' }, 99.5, { played: false }), 'void');
  const rules = { min_stake: 1, parlay_min_legs: 2 };
  const leg = o => ({ status: 'open', state: 'pre', commence_at: '2099-01-01T00:00:00Z', price: 1.9, event: 'cfb:9', label: 'X', ...o });
  for (const pair of [[leg({ sport: 'cfb' }), leg({ sport: 'cfb', id: 'b' })], [leg({ sport: 'cfb' }), leg({ sport: 'cprop' })]]) {
    assert.deepEqual(sameGameProblems(pair, rules), ['Same-game parlays are NFL only.']);
    assert.match(checkSlip({ legs: pair, stake: 5, voter: 1, rules }).join(), /NFL only/);
  }
  assert.deepEqual(checkSlip({ legs: [leg({ sport: 'cfb' }), leg({ sport: 'nfl', event: 'nfl:1' })], stake: 5, voter: 1, rules }), [],
    'a college game is one leg like any other');
});

test('the daily college build: names, colours, rankings and conferences for the page; skill-position rosters for the sync', () => {
  const slate = slateTeams([board]);
  assert.equal(slate.conferences['8'], 'SEC', 'a conference is named by its own conference games');
  assert.equal(slate.teams['333'].conf, '8');
  const espnTeams = [{ id: '333', abbreviation: 'ALA', shortDisplayName: 'Alabama', displayName: 'Alabama Crimson Tide', color: '9e1b32', alternateColor: 'ffffff' },
    { id: '61', abbreviation: 'UGA', shortDisplayName: 'Georgia', displayName: 'Georgia Bulldogs', color: 'BA0C2F', alternateColor: 'not a colour' },
    { id: '999', abbreviation: 'NOPE', shortDisplayName: 'Not Playing', displayName: 'Not Playing', color: '000000' }];
  const rows = teamRows(espnTeams, slate);
  assert.deepEqual(rows['333'], ['ALA', 'Alabama', 'Alabama Crimson Tide', '9e1b32', 'ffffff', '8']);
  assert.deepEqual(rows['61'].slice(3, 5), ['ba0c2f', ''], 'a colour that is not a colour is left out, not passed on to a page');
  assert.equal(rows['999'], undefined, 'only teams that are on a scoreboard');
  assert.deepEqual(apRanks({ rankings: [{ name: 'AFCA Coaches Poll', ranks: [{ current: 1, team: { id: '61' } }] },
    { name: 'AP Top 25', ranks: [{ current: 1, team: { id: '251' } }, { current: 2, team: { id: '61' } }] }] }), { 251: 1, 61: 2 });
  const roster = { athletes: [{ items: [
    { id: '1', fullName: "Trae'Shawn Brown Jr.", jersey: '17', position: { abbreviation: 'RB' } },
    { id: '2', fullName: 'Big Lineman', jersey: '73', position: { abbreviation: 'OL' } },
    { id: '3', fullName: 'Jo Smith', jersey: '0', position: { abbreviation: 'WR' } },
    { id: '4', fullName: 'Jo Smith', jersey: '11', position: { abbreviation: 'TE' } },
    { id: '5', fullName: 'No Number', jersey: '', position: { abbreviation: 'QB' } }] }] };
  assert.deepEqual(rosterIndex(roster), { 'traeshawn brown': ['1', 17], 'jo smith': 0, 'no number': ['5', null] },
    'skill positions only; a shared name is 0; a missing number is null, never 0');
  // and the sync finds FanDuel's spelling in it
  assert.equal(findCfbPlayer({ 333: rosterIndex(roster) }, "Trae'shawn Brown", ['333']).id, '1');
});
