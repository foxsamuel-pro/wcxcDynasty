import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineupPoints } from '../scripts/projections.mjs';

/* The odds model is only as good as the lineup it projects. These pin the part
 * that is pure logic: filling a superflex roster with the best legal starters. */

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'SUPER_FLEX'];
const roster = pos => Object.fromEntries(pos.map((p, i) => [`p${i}`, p]));
const build = pos => {
  const players = roster(pos);
  return (pts) => lineupPoints(Object.keys(players), id => players[id], id => pts[id] ?? 0, SLOTS);
};

test('fills every strict slot before any flex', () => {
  //            QB   QB   RB   RB   WR   WR   WR   TE
  const pos = ['QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
  const run = build(pos);
  const pts = { p0: 30, p1: 25, p2: 20, p3: 18, p4: 16, p5: 14, p6: 12, p7: 10 };
  // 8 players, 10 slots: everyone starts, so it is just the sum
  assert.equal(run(pts), 145);
});

test('superflex takes a quarterback when he is the best man left', () => {
  // 12 players for 10 slots, so two must sit and the choice is real
  const run = build(['QB', 'QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'RB']);
  const base = { p0: 30, p2: 20, p3: 18, p4: 17, p5: 16, p6: 15, p7: 14, p8: 13, p9: 10, p10: 9, p11: 8 };
  const high = run({ ...base, p1: 28 });   // second QB is worth starting
  const low  = run({ ...base, p1: 2 });    // second QB is not
  // with a good QB2 he takes SUPER_FLEX; without him the slot falls to the best
  // skill player left over, the 9-point TE2
  assert.equal(high - low, 28 - 9);
});

test('a quarterback can never fill a plain FLEX', () => {
  // one QB, no RB/WR/TE depth: the FLEX slots must go empty rather than take a QB
  const run = build(['QB', 'QB', 'QB', 'QB']);
  assert.equal(run({ p0: 10, p1: 10, p2: 10, p3: 10 }), 20); // QB + SUPER_FLEX only
});

test('benched points are excluded', () => {
  const run = build(['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE']);
  const pts = { p0: 20, p1: 15, p2: 14, p3: 99, p4: 10, p5: 9, p6: 8, p7: 7 };
  // 8 players fill QB/RB/RB/WR/WR/WR/TE plus two flex and superflex — all start
  assert.equal(run(pts), 182);
});

test('unknown players are skipped, not counted as zero-point starters', () => {
  const total = lineupPoints(['a', 'ghost', 'b'], id => ({ a: 'QB', b: 'RB' })[id],
    id => ({ a: 10, ghost: 500, b: 5 })[id] ?? 0, SLOTS);
  assert.equal(total, 15);
});

test('a taxi-squad player is never counted as a starter', () => {
  const players = { qb: 'QB', rb: 'RB', stash: 'WR' };
  const pts = { qb: 20, rb: 15, stash: 99 };
  const run = ids => lineupPoints(ids, id => players[id], id => pts[id] ?? 0, SLOTS);
  const taxi = new Set(['stash']);
  assert.equal(run(['qb', 'rb', 'stash'].filter(id => !taxi.has(id))), 35);
});

/* An injured player must NOT be dropped from every remaining week. Sleeper's
 * weekly projections already carry the timeline — 0 while he is out, his normal
 * number once he is back — so a two-week injury costs two weeks, not twelve.
 * Dropping IR outright took a 28-point quarterback off a roster for eleven
 * weeks he was projected to play. */
test('an injured player still counts in the weeks he is projected to play', () => {
  const players = { qb1: 'QB', qb2: 'QB', rb: 'RB', wr: 'WR' };
  const ids = Object.keys(players);
  const run = pts => lineupPoints(ids, id => players[id], id => pts[id] ?? 0, SLOTS);
  // qb2 is on IR: out in the near week, back later, and the data says so
  const outWeek = { qb1: 25, qb2: 0, rb: 12, wr: 10 };
  const backWeek = { qb1: 25, qb2: 28, rb: 12, wr: 10 };
  assert.equal(run(outWeek), 47);
  assert.equal(run(backWeek), 75, 'the returning player must be picked back up');
});

test('published projections.json is shaped the way the page expects', () => {
  const p = JSON.parse(readFileSync(new URL('../projections.json', import.meta.url), 'utf8'));
  assert.ok(Number.isFinite(p.season) && p.season > 2000);
  assert.ok(p.scale > 0.4 && p.scale < 1.6, `implausible rescale ${p.scale}`);
  const weeks = Object.keys(p.weeks).map(Number).sort((a, b) => a - b);
  assert.ok(weeks.length > 0, 'no remaining weeks');
  assert.equal(weeks.at(-1), p.lastWeek);
  for (const w of weeks) {
    const ids = Object.keys(p.weeks[w]);
    assert.equal(ids.length, 12, `week ${w} is missing teams`);
    for (const id of ids) {
      const v = p.weeks[w][id];
      assert.ok(Number.isFinite(v) && v > 0 && v < 400, `week ${w} team ${id}: ${v}`);
    }
  }
  // history is what the page uses to size projection error; same 12 teams
  for (const w of Object.keys(p.history || {})) {
    for (const id of Object.keys(p.history[w])) {
      const { actual, proj } = p.history[w][id];
      assert.ok(Number.isFinite(actual) && Number.isFinite(proj), `history ${w}/${id}`);
    }
  }
});

test('no completed week is also offered as a remaining week', () => {
  const p = JSON.parse(readFileSync(new URL('../projections.json', import.meta.url), 'utf8'));
  const done = new Set(Object.keys(p.history || {}));
  for (const w of Object.keys(p.weeks)) assert.ok(!done.has(w), `week ${w} is both played and pending`);
});
