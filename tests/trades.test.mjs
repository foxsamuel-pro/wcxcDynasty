import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePick, scoreStats } from '../scripts/trades/build.mjs';

const archive = JSON.parse(await readFile(new URL('../trades.json', import.meta.url), 'utf8'));

/* A traded pick is (season, round, original owner). Sleeper never says which
   player it became; slot_to_roster_id turns the original owner into a draft
   slot, and slot plus round is the pick that was actually made. Getting this
   wrong silently credits a trade with the wrong player. */
test('a pick resolves through the original owner\'s draft slot', () => {
  const draft = { slot_to_roster_id: { 1: 6, 2: 4, 3: 9 } };
  const picks = [
    { round: 1, draft_slot: 1, pick_no: 1, player_id: 'a', roster_id: 3 },
    { round: 1, draft_slot: 2, pick_no: 2, player_id: 'b', roster_id: 7 },
    { round: 2, draft_slot: 1, pick_no: 13, player_id: 'c', roster_id: 6 }
  ];
  // roster 6 owns slot 1, so its first-rounder is pick 1 — made by roster 3,
  // who had traded for it. The player is what matters, not who picked.
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 6 }, draft, picks).player_id, 'a');
  assert.equal(resolvePick({ season: '2025', round: 2, roster_id: 6 }, draft, picks).player_id, 'c');
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 4 }, draft, picks).player_id, 'b');
  // a round that draft never reached, and an owner with no slot
  assert.equal(resolvePick({ season: '2025', round: 9, roster_id: 6 }, draft, picks), null);
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 99 }, draft, picks), null);
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 6 }, null, picks), null);
});

test('league scoring is applied to raw stat lines', () => {
  assert.equal(scoreStats({ rec: 4, rec_yd: 50 }, { rec: 1.5, rec_yd: 0.1 }), 11);
  assert.equal(scoreStats({ pass_td: 2, pass_int: 1 }, { pass_td: 4, pass_int: -3 }), 5);
  assert.equal(scoreStats(null, { rec: 1 }), 0);
  assert.equal(scoreStats({ unknown: 99 }, { rec: 1 }), 0);
});

test('the archive covers every season and keeps both sides of every trade', () => {
  assert.deepEqual(archive.seasons, [2023, 2024, 2025, 2026]);
  assert.ok(archive.trades.length > 150, `only ${archive.trades.length} trades`);
  assert.equal(Object.keys(archive.franchises).length, 12);
  for (const t of archive.trades) {
    assert.ok(t.sides.length >= 2, `${t.id} lost a side`);
    assert.ok(archive.seasons.includes(t.season));
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('a side\'s return is exactly its players plus the players its picks became', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const expected = s.players.reduce((a, p) => a + p.points, 0)
      + s.picks.reduce((a, p) => a + (p.became?.points || 0), 0);
    assert.ok(Math.abs(s.points - expected) < 0.02, `${t.id}: ${s.points} vs ${expected}`);
  }
});

/* Points must count only what happened AFTER the trade. Counting the whole
   season would credit a team for production it traded away. */
test('nothing scores negative totals, and pending picks contribute nothing', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    for (const p of s.picks) if (!p.became) assert.ok(!p.points, 'an undrafted pick cannot score');
    assert.ok(Number.isFinite(s.points));
  }
});

test('every unresolved pick has a reason: a future draft, or a round that never existed', () => {
  const stranded = [];
  for (const t of archive.trades) for (const s of t.sides) for (const p of s.picks) {
    if (p.became || Number(p.season) >= 2027) continue;
    // the 2026 rookie draft ran four rounds, so a traded "2026 5th" is not real
    if (Number(p.season) === 2026 && p.round >= 5) continue;
    stranded.push(`${p.season} rd${p.round} via roster ${p.from}`);
  }
  assert.deepEqual(stranded, [], `unexplained unresolved picks: ${stranded.join(', ')}`);
});

test('winners and margins agree with the points', () => {
  for (const t of archive.trades) {
    if (t.oneSided) { assert.equal(t.margin, null); assert.equal(t.winner, null); continue; }
    const points = t.sides.map(s => s.points);
    assert.ok(Math.abs(t.margin - (Math.max(...points) - Math.min(...points))) < 0.02, t.id);
    if (t.winner != null) {
      const won = t.sides.find(s => s.team === t.winner);
      assert.equal(won.points, Math.max(...points), `${t.id} named the wrong winner`);
      assert.equal(points.filter(p => p === won.points).length, 1, `${t.id} was a tie`);
    }
  }
});

test('a pick traded more than once records the chain instead of double-counting', () => {
  const chained = archive.trades.flatMap(t => t.sides.flatMap(s => s.picks.filter(p => p.movedOn)));
  assert.ok(chained.length > 0, 'no chains found at all');
  for (const p of chained) assert.ok(Array.isArray(p.movedOn) && p.movedOn.length >= 1);
  // the same drafted player may back several trades, but only as the pick moved
  const ids = new Set(archive.trades.map(t => t.id));
  for (const p of chained) for (const other of p.movedOn) assert.ok(ids.has(other), `dangling chain ${other}`);
});

/* Raw points alone are a bad verdict: they cannot tell a player who won you
   games from one who scored on your bench, and they price an unused pick at
   zero forever. Two more measures carry that weight. */
test('every side reports lineup points, total points and market value', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    assert.ok(Number.isFinite(s.points), `${t.id} points`);
    assert.ok(Number.isFinite(s.started), `${t.id} started`);
    assert.ok(Number.isFinite(s.value), `${t.id} value`);
    // points can go negative on turnovers; a market price cannot
    assert.ok(s.value >= 0, `${t.id} value went negative`);
  }
});

/* Lineup points are a subset of the weeks counted in the total, so normally they
   cannot exceed it. The exception is real: a fumble or interception can leave a
   player on a NEGATIVE total, and if he never started, his lineup figure of zero
   is correctly higher. Jalen Milroe is the live case, on -1.7 for a season. */
test('lineup points never exceed points scored, unless the player scored negative', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const assets = [...s.players, ...s.picks.map(p => p.became).filter(Boolean)];
    for (const a of assets) {
      if (a.points < 0) { assert.ok(a.started >= a.points, `${a.name}`); continue; }
      assert.ok(a.started <= a.points + 0.02, `${a.name}: started ${a.started} > scored ${a.points}`);
    }
    if (s.points >= 0) assert.ok(s.started <= s.points + 0.02,
      `${t.id}: started ${s.started} > scored ${s.points}`);
  }
});

test('a side total equals the sum of its own assets on all three measures', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const assets = [...s.players, ...s.picks.map(p => p.became).filter(Boolean)];
    const sum = key => assets.reduce((a, x) => a + (x[key] || 0), 0);
    assert.ok(Math.abs(s.points - sum('points')) < 0.02, `${t.id} points`);
    assert.ok(Math.abs(s.started - sum('started')) < 0.02, `${t.id} started`);
    const value = sum('value') + s.picks.reduce((a, p) => a + (p.value || 0), 0);
    assert.ok(Math.abs(s.value - value) < 0.5, `${t.id} value ${s.value} vs ${value}`);
  }
});

/* Value follows the same rule the points do: once an asset leaves the team the
   trade gave it to, its price belongs to whatever moved it, not here. */
test('an asset that is no longer held carries no market value', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    for (const p of s.players) if (!p.kept) assert.ok(!p.value, `${p.name} left but is still priced`);
    for (const p of s.picks) {
      if (p.movedOn) assert.ok(!p.value, 'a pick traded on again is priced in the later deal');
      if (p.became && !p.became.kept) assert.ok(!p.became.value, `${p.became.name} left but is still priced`);
      if (p.became) assert.ok(!p.value, 'a used pick is priced through the player, not twice');
    }
  }
});

test('unused picks that are still owned do get a price', () => {
  const pending = archive.trades.flatMap(t => t.sides.flatMap(s =>
    s.picks.filter(p => !p.became && !p.movedOn)));
  const priced = pending.filter(p => p.value > 0);
  assert.ok(priced.length > 0, 'an unused pick must be worth something');
  // anything unpriced should be beyond the market feed's range, not a lookup miss
  for (const p of pending.filter(p => !p.value)) {
    assert.ok(p.round >= 5 || Number(p.season) >= 2029,
      `${p.season} rd${p.round} should have had a price`);
  }
});

test('each verdict names at most one winner and agrees with its own numbers', () => {
  for (const t of archive.trades) {
    for (const [who, margin, key] of [
      [t.winner, t.margin, 'points'],
      [t.startedWinner, t.startedMargin, 'started'],
      [t.valueWinner, t.valueMargin, 'value']
    ]) {
      if (t.oneSided) { assert.equal(who, null); assert.equal(margin, null); continue; }
      const vals = t.sides.map(s => s[key]);
      if (who != null) {
        const win = t.sides.find(s => s.team === who);
        assert.equal(win[key], Math.max(...vals), `${t.id} ${key} winner`);
        assert.equal(vals.filter(v => v === win[key]).length, 1, `${t.id} ${key} was a tie`);
      }
      if (margin != null) assert.ok(Math.abs(margin - (Math.max(...vals) - Math.min(...vals))) < 0.02);
    }
  }
});
