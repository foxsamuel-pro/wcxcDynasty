import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { windowOpen, submitBallot, listBallots, checkPassword, hashPassword } from '../server/ballots.mjs';

// A D1-shaped wrapper over Node's own SQLite, loaded with the real schema.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prep = (sql, args = []) => ({
    bind: (...a) => prep(sql, a),
    first: async col => { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : r) : null; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  return { prepare: sql => prep(sql) };
}

const TUE = new Date('2026-11-10T17:00:00Z');   // Tuesday noon ET
const ranking = [3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ballot = (over = {}) => ({ season: 2026, week: 11, voter: 5, ranking, password: 'hunter2', ...over });

test('the window matches index.html: Tue 00:00 to Thu 20:00 Eastern', () => {
  assert.equal(windowOpen(new Date('2026-11-10T05:00:00Z')), true, 'Tue 00:00 ET opens');
  assert.equal(windowOpen(new Date('2026-11-10T04:59:00Z')), false, 'Mon 23:59 ET is shut');
  assert.equal(windowOpen(new Date('2026-11-13T00:59:00Z')), true, 'Thu 19:59 ET still open');
  assert.equal(windowOpen(new Date('2026-11-13T01:00:00Z')), false, 'Thu 20:00 ET closes');
  assert.equal(windowOpen(new Date('2026-09-10T23:30:00Z')), true, 'Thu 19:30 EDT, summer time');
  assert.equal(windowOpen(new Date('2026-09-11T00:30:00Z')), false, 'Thu 20:30 EDT, summer time');
});

test('a team\'s first ballot sets its password, later ones must match', async () => {
  const db = fakeD1();
  assert.equal(await submitBallot(db, ballot(), TUE), 'created');
  assert.equal(await submitBallot(db, ballot({ ranking: [...ranking].reverse() }), TUE), 'saved');
  await assert.rejects(submitBallot(db, ballot({ password: 'wrong1' }), TUE), { message: 'Wrong password for this team.', status: 403 });
  const rows = await listBallots(db, 2026);
  assert.equal(rows.length, 1, 'resubmitting replaces the ballot');
  assert.deepEqual(rows[0].ranking, [...ranking].reverse());
  assert.deepEqual(Object.keys(rows[0]).sort(), ['ranking', 'season', 'updated_at', 'voter', 'week']);
});

test('ballots are refused outside the window', async () => {
  const db = fakeD1();
  await assert.rejects(submitBallot(db, ballot(), new Date('2026-11-13T02:00:00Z')), { status: 403, message: /Voting is closed/ });
  assert.equal((await listBallots(db)).length, 0);
});

test('bad ballots are refused before anything is written', async () => {
  const db = fakeD1();
  for (const bad of [{ voter: 13 }, { week: 0 }, { ranking: ranking.slice(1) }, { ranking: [1, 1, ...ranking.slice(2)] },
    { password: 'abc' }, { season: '2026' }]) {
    await assert.rejects(submitBallot(db, ballot(bad), TUE), { status: 400 });
  }
  assert.equal(await db.prepare('select count(*) n from team_passwords').first('n'), 0, 'no password was set by a bad ballot');
});

test('passwords are stored hashed and checked in full', async () => {
  const h = await hashPassword('hunter2');
  assert.match(h, /^pbkdf2\$100000\$/);
  assert.ok(!h.includes('hunter2'));
  assert.equal(await checkPassword('hunter2', h), true);
  assert.equal(await checkPassword('hunter3', h), false);
  assert.equal(await checkPassword('hunter2', 'garbage'), false);
});
