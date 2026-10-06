/* The player maps the casino depends on: positions.json (position and NFL team
   per Sleeper id) for WCXC matchup prices and the same-game simulation, built
   daily by scripts/players/build.mjs. espn.json's matching is tested in
   casino.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { positionMap, FANTASY } from '../scripts/players/build.mjs';

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

test('pick \'em is gone from the site, and the casino pays $100 a ballot', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../supabase-setup.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /data-tab="picks"|renderPicks|loadPicks|submit_picks/);
  assert.doesNotMatch(page, /pick 'em/i);
  assert.doesNotMatch(sql, /create table if not exists public\.picks/, 'no longer created');
  assert.match(sql, /drop function if exists public\.submit_picks/, 'and its write path is removed');
  assert.match(sql, /reward_ballot\s+numeric\(10,2\) not null default 100/);
});
