/* The player maps the casino depends on: positions.json (position and NFL team
   per Sleeper id) for WCXC matchup prices and the same-game simulation, built
   daily by scripts/players/build.mjs. espn.json's matching is tested in
   casino.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { positionMap, jerseyNumbers, FANTASY } from '../scripts/players/build.mjs';

/* Prices are position-aware, so the casino needs each starter's position and
   NFL team. Sleeper's only source for that is a ~5MB player file, far too much
   to fetch for 120 positions. */
test('the position map keeps what the casino needs and nothing else', () => {
  const players = {
    '1': { position: 'QB', team: 'BUF' },
    '2': { position: 'WR', team: null },      // unsigned: position but no game
    '3': { position: 'OL', team: 'KC' },      // nobody's lineup slot
    '4': { position: 'TE', team: 'LV' },
    '5': null,
    '6': { position: 'DEF', team: 'SF' }
  };
  const { positions, teams } = positionMap(players);
  assert.deepEqual(positions, { '1': 'QB', '2': 'WR', '4': 'TE', '6': 'DEF' });
  assert.deepEqual(teams, { '1': 'BUF', '4': 'LV', '6': 'SF' },
    'a player with no NFL team has no game to finish, so he is left out');
  assert.ok(!('3' in positions), 'offensive line would double the file for nothing');
  assert.ok(!('5' in positions), 'a null player must not throw or appear');
  assert.deepEqual(positionMap({}), { positions: {}, teams: {} });
  assert.ok(FANTASY.includes('QB') && FANTASY.includes('TE') && !FANTASY.includes('LB'));
});

/* The casino draws a prop on the player's own jersey, so the number has to be
   the player's own. Wrong digits are worse than none. Sleeper's player file is
   deliberately not the source: it is stale for recent signings and uses 0 for
   "no number", while a real 0 is worn by a dozen starters. ESPN's roster is. */
test('jersey numbers come off ESPN rosters: zero is real, missing and junk are left out, never guessed', () => {
  const espn = {
    100: { id: '1', name: 'A', team: 'PHI' }, 101: { id: '2', name: 'B', team: 'DAL' },
    102: { id: '3', name: 'C', team: 'KC' },  103: { id: '4', name: 'D', team: 'SF' },
    104: { id: '5', name: 'E', team: 'NYJ' }, 105: { id: '6', name: 'F', team: 'MIA' },
    106: { id: '7', name: 'G', team: 'WAS' }, 107: { id: '8', name: 'H', team: 'LV' },
  };
  const rosters = [
    { team: 'PHI', athletes: [{ id: '100', jersey: '1' }, { id: '999', jersey: '77' }] },   // 999: not a player we track
    { team: 'DAL', athletes: [{ id: '101', jersey: '0' }] },                                // a real zero
    { team: 'KC', athletes: [{ id: '102', jersey: '26' }] },
    { team: 'SF', athletes: [{ id: '103', jersey: null }] },                                // ESPN has no number: none
    { team: 'NYJ', athletes: [{ id: '104' }] },                                             // field absent: none
    { team: 'MIA', athletes: [{ id: '105', jersey: '100' }] },                              // not a jersey number
    { team: 'WSH', athletes: [{ id: '106', jersey: '24' }] },                               // ESPN says WSH, Sleeper WAS
    { team: 'LV', athletes: [{ id: '107', jersey: '' }] },
    { team: 'CHI', athletes: [{ id: '100', jersey: '88' }] },                               // listed on another team than Sleeper has
  ];
  const n = jerseyNumbers(rosters, espn);
  assert.deepEqual(n, { '1': 1, '2': 0, '3': 26, '7': 24 });
  assert.equal(n['2'], 0, 'zero is kept');
  assert.ok(!('1' in jerseyNumbers([rosters[8]], espn)), 'a team disagreement gets no digits at all, not the other team\'s');
  assert.deepEqual(jerseyNumbers(null, null), {});
  assert.deepEqual(jerseyNumbers([{ team: 'PHI', athletes: [{ id: '100', jersey: 'abc' }, { id: '100', jersey: '12.5' }, { id: '100', jersey: '-3' }] }], espn), {},
    'junk is dropped');
});

test('the published position file is present and plausible', async () => {
  const file = JSON.parse(await readFile(new URL('../positions.json', import.meta.url), 'utf8'));
  assert.match(file.built, /^\d{4}-\d{2}-\d{2}$/, 'the file must say when it was built');
  assert.ok(file.count > 1000, `only ${file.count} players`);
  assert.equal(Object.keys(file.positions).length, file.count);
  assert.ok(Object.keys(file.teams).length > 500, 'most active players should have an NFL team');
  for (const pos of Object.values(file.positions)) assert.ok(FANTASY.includes(pos), `stray position ${pos}`);
  // every id with a team must also have a position, or the spread lookup misses
  for (const id of Object.keys(file.teams)) assert.ok(file.positions[id], `${id} has a team but no position`);
});

test('the published file carries jersey numbers for the players a prop can be on, and only for rostered ones', async () => {
  const file = JSON.parse(await readFile(new URL('../positions.json', import.meta.url), 'utf8'));
  const espn = JSON.parse(await readFile(new URL('../espn.json', import.meta.url), 'utf8')).players;
  assert.ok(file.numbers && typeof file.numbers === 'object', 'the casino draws jerseys from this');
  const ids = Object.keys(file.numbers);
  assert.ok(ids.length > 500, `only ${ids.length} numbers`);
  for (const id of ids) {
    assert.ok(file.teams[id], `${id} has a number but no team`);
    const n = file.numbers[id];
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 99, `${id} has number ${n}`);
  }
  /* Props exist only for players espn.json knows. Of those on a roster, nearly all
     should have a number; a handful (practice squad) legitimately have none. */
  const onRoster = Object.values(espn).filter(p => p.team && file.teams[p.id]);
  const numbered = onRoster.filter(p => p.id in file.numbers);
  assert.ok(numbered.length > 0.6 * onRoster.length, `only ${numbered.length} of ${onRoster.length} rostered prop players have a number`);
  // spot checks against well-known players (Sleeper ids), so a shifted column or a
  // mixed-up map cannot ship: the digits on a jersey must be that player's own
  assert.equal(file.numbers['6904'], 1, 'Jalen Hurts');
  assert.equal(file.numbers['4046'], 15, 'Patrick Mahomes');
  assert.equal(file.numbers['4984'], 17, 'Josh Allen');
});

test('pick \'em is gone from the site, and the casino pays $100 a ballot', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../supabase-setup.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /data-tab="picks"|renderPicks|loadPicks|submit_picks/);
  assert.doesNotMatch(page, /pick 'em/i);
  assert.doesNotMatch(sql, /create table if not exists public\.picks/, 'no longer created');
  assert.match(sql, /drop function if exists public\.submit_picks/, 'and its write path is removed');
  assert.match(sql, /reward_ballot\s+numeric\(10,2\) not null default 100/);
});
