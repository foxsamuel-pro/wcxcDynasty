/* The historical market feed. Offline — the CSV and commit list are fixtures, so
   this tests the parsing and date selection rather than the network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseValues, normalName, loadSnapshots } from '../scripts/trades/history.mjs';

const CSV = [
  'player,pos,team,value_1qb,value_2qb,scrape_date',
  'Josh Allen,QB,BUF,7000,10160,2026-09-25',
  '"Marvin Harrison Jr.",WR,ARI,3400,3423,2026-09-25',
  'Brock Bowers,TE,LV,4800,4835,2026-09-25',
  '2027 Early 1st,PICK,PICK,4000,4517,2026-09-25',
  '2027 1st,PICK,PICK,2000,2182,2026-09-25',
  '2027 2nd,PICK,PICK,300,311,2026-09-25',
  '2026 Pick 1.03,PICK,PICK,2200,2305,2026-09-25'
].join('\n');

test('a snapshot reads players and picks off the superflex column', () => {
  const v = parseValues(CSV);
  assert.equal(v.player('Josh Allen'), 10160, 'must read value_2qb, not value_1qb');
  assert.equal(v.player('Brock Bowers'), 4835);
  assert.equal(v.players.size, 3, 'picks must not land in the player table');
  assert.equal(v.player('Nobody At All'), null, 'an unknown player is null, never zero');
  assert.equal(parseValues(''), null);
  assert.equal(parseValues('player,pos\n'), null, 'a file with no rows is not a snapshot');
});

/* Suffixes are the whole ballgame on name matching: "Marvin Harrison" against
   "Marvin Harrison Jr." costs seven points of match rate across the archive. */
test('names match across generational suffixes and punctuation', () => {
  const v = parseValues(CSV);
  for (const spelling of ['Marvin Harrison Jr.', 'Marvin Harrison', 'marvin harrison jr', "Marvin Harrison, Jr."]) {
    assert.equal(v.player(spelling), 3423, `failed on "${spelling}"`);
  }
  assert.equal(normalName('A.J. Brown'), normalName('AJ Brown'));
  assert.equal(normalName(null), '', 'a missing name must not throw');
});

/* A pick is priced by tier when the draft slot is known and by plain round when
   it is not. The plain round is what the then/now comparison uses, because
   today's draft order is not the order that stood when an old trade was made. */
test('a pick prefers its tier but falls back to the plain round', () => {
  const v = parseValues(CSV);
  assert.equal(v.pick(2027, 1, 2), 4517, 'an early slot should get the Early price');
  assert.equal(v.pick(2027, 1, null), 2182, 'no slot means the plain round');
  assert.equal(v.pick(2027, 1, 11), 2182, 'a Late 1st is not in this fixture, so fall back');
  assert.equal(v.pick(2027, 2, null), 311);
  assert.equal(v.pick(2029, 1, null), null, 'a draft with no market is null, not zero');
  assert.equal(v.pick(2027, 6, null), null, 'and so is a round nobody prices');
});

/* The snapshot in force on a date is the most recent commit at or before it.
   Picking the nearest in either direction would price a trade with information
   that did not exist yet, which is the one thing this must never do. */
test('as-of selects the snapshot in force, never a later one', async () => {
  const commits = [
    { sha: 'c', commit: { committer: { date: '2026-09-25T00:00:00Z' } } },
    { sha: 'b', commit: { committer: { date: '2025-09-26T00:00:00Z' } } },
    { sha: 'a', commit: { committer: { date: '2024-08-16T00:00:00Z' } } }
  ];
  const fetched = [];
  const h = await loadSnapshots({
    json: async url => url.includes('page=1') ? commits : [],
    request: async url => { fetched.push(url.split('/')[4]); return CSV; }
  });
  assert.equal(h.count, 3);
  assert.deepEqual(h.span, ['2024-08-16', '2026-09-25']);

  assert.equal((await h.asOf('2026-09-30')).date, '2026-09-25', 'the latest at or before');
  assert.equal((await h.asOf('2025-09-26')).date, '2025-09-26', 'the same day counts');
  assert.equal((await h.asOf('2025-09-25')).date, '2024-08-16', 'a day early falls back, never forward');
  assert.equal(await h.asOf('2019-01-01'), null, 'before the archive begins there is no answer');

  const before = fetched.length;
  await h.asOf('2026-09-30');
  assert.equal(fetched.length, before, 'a snapshot already read must not be fetched twice');
});
