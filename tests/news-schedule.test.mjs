import test from 'node:test';
import assert from 'node:assert/strict';
import { eastern, weekFor, normalizeGames, planPosts } from '../scripts/news/schedule.mjs';

const game = (id, time, extra = {}) => ({ id, start: Date.parse(time), ...eastern(time),
  week: 3, complete: false, started: false, home: 'BUF', away: 'NYJ', ...extra });
const games = [
  game('tnf', '2026-09-25T00:15:00Z'),
  game('early', '2026-09-27T17:00:00Z'),
  game('late', '2026-09-27T20:25:00Z'),
  game('snf', '2026-09-28T00:20:00Z'),
  game('mnf', '2026-09-29T00:15:00Z')
];
const plan = (time, overrides = {}) => planPosts({ now: new Date(time), season: 2026, week: 3,
  games, articles: [], ballotCount: 8, ...overrides });
const article = (job, extra = {}) => ({ ...job, editorialDate: job.date, ...extra });

test('Wednesday 5 PM releases the poll at eight votes; otherwise satire', () => {
  assert.deepEqual(plan('2026-09-23T20:59:00Z'), []);
  for (const count of [0, 7, 8, 12]) {
    const jobs = plan('2026-09-23T21:00:00Z', { ballotCount: count });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, count >= 8 ? 'poll' : 'satire');
  }
});

test('threshold reached early does not release a poll before Wednesday', () => {
  const jobs = plan('2026-09-22T21:00:00Z', { ballotCount: 12 });
  assert.ok(!jobs.some(j => j.kind === 'poll'));
});

test('Thursday releases the poll regardless of count after Wednesday satire', () => {
  const wed = plan('2026-09-23T21:00:00Z', { ballotCount: 7 })[0];
  for (const count of [0, 7, 12]) {
    const jobs = plan('2026-09-24T21:00:00Z', { ballotCount: count, articles: [article(wed)] });
    assert.equal(jobs[0].kind, 'poll');
  }
});

test('Thursday posts satire if the poll ran Wednesday; Friday does not repeat it', () => {
  const wed = plan('2026-09-23T21:00:00Z')[0];
  const thu = plan('2026-09-24T21:00:00Z', { articles: [article(wed)] })[0];
  assert.equal(thu.kind, 'satire');
  assert.match(thu.brief, /tonight/);
  assert.ok(!plan('2026-09-25T21:00:00Z', { articles: [article(wed), article(thu)] }).some(j => j.kind === 'poll'));
});

test('Sunday has noon, 4 PM, SNF preview, and a single full-day postgame recap', () => {
  const noon = plan('2026-09-27T16:00:00Z');
  assert.deepEqual(noon.map(j => j.slot), ['early-preview']);
  const afternoon = plan('2026-09-27T20:00:00Z', { articles: noon.map(j => article(j)) });
  assert.deepEqual(afternoon.map(j => j.slot), ['late-preview']);
  const night = plan('2026-09-27T23:20:00Z', { articles: [...noon, ...afternoon].map(j => article(j)) });
  assert.deepEqual(night.map(j => j.slot), ['snf-preview']);
  const completed = games.map(g => g.day === 0 ? { ...g, complete: true } : g);
  const recap = plan('2026-09-28T03:45:00Z', { games: completed, articles: [...noon, ...afternoon, ...night].map(j => article(j)) });
  assert.deepEqual(recap.map(j => j.slot), ['snf-recap']);
  assert.match(recap[0].brief, /entire Sunday/);
  assert.deepEqual(recap[0].gameIds, ['early', 'late', 'snf']);
});

test('no stale early or late previews after their kickoffs', () => {
  assert.ok(!plan('2026-09-27T17:00:00Z').some(j => j.slot === 'early-preview'));
  assert.ok(!plan('2026-09-27T20:25:00Z').some(j => j.slot === 'late-preview'));
});

test('TNF gets pregame and postgame even when Thursday already published its daily edition', () => {
  const daily = plan('2026-09-24T21:00:00Z')[0];
  const pre = plan('2026-09-24T23:15:00Z', { articles: [article(daily)] });
  assert.deepEqual(pre.map(j => j.slot), ['tnf-preview']);
  const done = games.map(g => g.id === 'tnf' ? { ...g, complete: true } : g);
  const post = plan('2026-09-25T03:45:00Z', { games: done, articles: [article(daily), ...pre.map(j => article(j))] });
  assert.deepEqual(post.map(j => j.slot), ['tnf-recap']);
});

test('MNF doubleheader gets one preview before the first game, recap after both', () => {
  const double = [...games, game('mnf-early', '2026-09-28T23:00:00Z')];
  const pre = plan('2026-09-28T22:00:00Z', { games: double });
  assert.deepEqual(pre.map(j => j.slot), ['mnf-preview']);
  const partial = double.map(g => g.id === 'mnf-early' ? { ...g, complete: true } : g);
  assert.deepEqual(plan('2026-09-29T02:00:00Z', { games: partial }), []);
  const complete = partial.map(g => g.day === 1 ? { ...g, complete: true } : g);
  assert.deepEqual(plan('2026-09-29T04:30:00Z', { games: complete }).map(j => j.slot), ['mnf-recap']);
});

test('unfinished games cannot produce a final recap', () => {
  const partial = games.map(g => g.id === 'snf' ? { ...g, complete: true } : g);
  assert.ok(!plan('2026-09-28T03:45:00Z', { games: partial }).some(j => j.slot === 'snf-recap'));
});

test('post-midnight recaps belong to the game day and cannot duplicate', () => {
  const done = games.map(g => g.day === 0 ? { ...g, complete: true } : g);
  const [recap] = plan('2026-09-28T04:30:00Z', { games: done });
  assert.equal(recap.date, '2026-09-27');
  assert.equal(recap.slot, 'snf-recap');
  assert.deepEqual(plan('2026-09-28T05:00:00Z', { games: done, articles: [article(recap)] }), []);
});

test('Tuesday recap waits for the previous week to finish and keeps its week number', () => {
  const previous = game('previous-mnf', '2026-09-22T00:15:00Z', { week: 2, complete: true });
  const jobs = plan('2026-09-22T21:00:00Z', { games: [...games, previous] });
  const daily = jobs.find(j => j.slot === 'daily');
  assert.equal(daily.kind, 'recap');
  assert.equal(daily.week, 2);
  const unfinished = plan('2026-09-22T21:00:00Z', { games: [...games, { ...previous, complete: false }] });
  assert.ok(!unfinished.some(j => j.slot === 'daily'));
});

test('an existing full-week recap prevents backfilling redundant postgame stories', () => {
  const previous = game('previous-mnf', '2026-09-22T00:15:00Z', { week: 2, complete: true });
  assert.deepEqual(plan('2026-09-22T21:00:00Z', { games: [...games, previous], articles: [
    { id: '2026-w2-recap', date: '2026-09-22', week: 2, kind: 'recap' }
  ] }), []);
});

test('non-game days get at most one edition, never before 5 PM', () => {
  assert.deepEqual(plan('2026-09-26T20:59:00Z'), []);
  const jobs = plan('2026-09-26T21:00:00Z');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'daily');
  assert.deepEqual(plan('2026-09-26T22:00:00Z', { articles: jobs.map(j => article(j)) }), []);
  assert.deepEqual(plan('2026-09-26T21:00:00Z', { articles: [{ id: 'manual', date: '2026-09-26', kind: 'satire' }] }), []);
});

test('poll history is scoped to the current season and week', () => {
  for (const old of [{ season: 2025, week: 3 }, { season: 2026, week: 2 }]) {
    assert.equal(plan('2026-09-24T21:00:00Z', { articles: [{ ...old, kind: 'poll', date: `${old.season}-09-20` }] })[0].kind, 'poll');
  }
});

test('5 PM Eastern follows DST, including winter', () => {
  assert.equal(eastern('2026-09-23T21:00:00Z').minute, 17 * 60);
  assert.equal(eastern('2026-11-04T22:00:00Z').minute, 17 * 60);
  const winter = [game('winter-tnf', '2026-11-06T01:15:00Z', { week: 9 })];
  assert.deepEqual(plan('2026-11-04T21:59:00Z', { week: 9, games: winter }), []);
  assert.equal(plan('2026-11-04T22:00:00Z', { week: 9, games: winter })[0].kind, 'poll');
});

test('week rolls Tuesday using Eastern calendar days, not Sleeper state', () => {
  assert.equal(weekFor('2026-09-22T03:59:00Z', '2026-09-09'), 2);
  assert.equal(weekFor('2026-09-22T04:00:00Z', '2026-09-09'), 3);
  assert.equal(weekFor('2026-11-03T04:59:00Z', '2026-09-09'), 8);
  assert.equal(weekFor('2026-11-03T05:00:00Z', '2026-09-09'), 9);
});

test('real Sleeper schedule shape respects completion and canceled games', () => {
  const row = { game_id: '1', start_time: Date.parse('2026-09-25T00:15:00Z'), status: 'pre_game',
    metadata: { home_team: 'BUF', away_team: 'NYJ', is_over: false } };
  assert.equal(normalizeGames({ 1: row }, 3)[0].date, '2026-09-24');
  assert.equal(normalizeGames([{ ...row, metadata: { ...row.metadata, is_over: true } }], 3)[0].complete, true);
  assert.equal(normalizeGames([{ ...row, metadata: { canceled: true } }], 3).length, 0);
  assert.throws(() => normalizeGames([{ game_id: 'bad' }], 3), /kickoff/);
});
