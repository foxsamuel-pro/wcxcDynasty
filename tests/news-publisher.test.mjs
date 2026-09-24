import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validBallots, pollTable, fantasyPoints, siteConfig, loadFacts } from '../scripts/news/data.mjs';
import { assembleArticle, validateDraft, editorialFacts } from '../scripts/news/writer.mjs';
import { prepare, finalize, shareFacts, readBack } from '../scripts/news/publish.mjs';
import { eastern } from '../scripts/news/schedule.mjs';
import { runInNewContext } from 'node:vm';

const teams = [{ id: 1, name: 'One', officialPF: 200 }, { id: 2, name: 'Two', officialPF: 180 }];
const player = { id: 'p1', team: 1, name: 'Player One', pos: 'WR', nfl: 'BUF', score: 30,
  projection: 20, actualRank: 'WR2', projectedRank: 'WR5', gameComplete: true };
const facts = { teams, ballotCount: 8, season: 2026, players: [player, { ...player, id: 'p2', team: 2 }],
  matchups: [{ teams: [1, 2], final: false, sides: [
    { team: 1, score: 100, projection: 120, variance: 100 }, { team: 2, score: 90, projection: 110, variance: 100 }
  ] }], trades: [], injuries: [] };
const job = { id: 'story', date: '2026-09-24', season: 2026, week: 3, slot: 'tnf-preview', kind: 'matchup' };
const draft = { kind: 'matchup', headline: 'One (1) meets Two (2)', dek: 'A close matchup.',
  body: ['First paragraph.', 'Second paragraph.'], leadTeams: [1, 2],
  watch: [{ playerId: 'p1', team: 1, note: 'One to watch.' }, { playerId: 'p2', team: 2, note: 'Another to watch.' }], eventKeys: [] };

test('ballot threshold counts valid unique voters only', () => {
  const ballot = { voter: 1, ranking: [1, 2], updated_at: '2026-09-23T17:00:00Z' };
  const rows = validBallots([ballot, ballot, { ...ballot, voter: 3 }, { ...ballot, voter: 2, ranking: [1, 1] },
    { ...ballot, voter: 2, ranking: [1] }, { ...ballot, voter: 1, ranking: [2, 1], updated_at: '2026-09-23T18:00:00Z' }], [1, 2]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ranking, [2, 1]);
});

test('poll uses league scoring and PF tiebreak; no votes means no invented ranking', () => {
  const table = pollTable([{ ranking: [1, 2] }, { ranking: [2, 1] }], teams);
  assert.equal(table[0].team, 1);
  assert.equal(table[0].points, 3);
  assert.equal(table[0].firstPlaceVotes, 1);
  assert.deepEqual(pollTable([], teams), []);
  assert.equal(fantasyPoints({ rec: 4, rec_yd: 50 }, { rec: 1.5, rec_yd: 0.1 }), 11);
  assert.equal(fantasyPoints(undefined, {}), null);
});

test('publisher reads the actual site configuration', async () => {
  const c = await siteConfig();
  assert.equal(c.leagueId, '1312128506452283392');
  assert.equal(c.managers[11], 'Sam');
  assert.match(c.supabaseUrl, /^https:\/\//);
});

test('generated scoreboard and player ranks come from data, not Claude', () => {
  const article = assembleArticle(draft, job, facts, '2026-09-24T23:15:00Z');
  assert.equal(article.box.sides[0].score, 100);
  assert.ok(article.box.sides[0].win > 0.5);
  assert.equal(article.box.sides[0].win + article.box.sides[1].win, 1);
  assert.equal(article.watch[0].rank, 'WR5');
  assert.equal(article.watch[0].proj, 20);
  assert.equal(article.editorialDate, '2026-09-24');
  const recap = assembleArticle({ ...draft, kind: 'recap' }, { ...job, kind: 'recap' },
    { ...facts, matchups: facts.matchups.map(m => ({ ...m, final: true })) }, '2026-09-25T04:10:00Z');
  assert.equal(recap.box.final, true);
  assert.equal(recap.box.sides[0].win, undefined);
  assert.equal(recap.watch[0].score, 30);
  assert.equal(recap.watch[0].proj, 20);
  assert.equal(recap.watch[0].rank, 'WR2');
});

test('watch rows distinguish projections from actuals, including zero and missing values', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('function artWatch(a)'), html.indexOf('/* ---------- comments ----------'));
  const render = runInNewContext(`${source}; artWatch`, { esc: String, T: {} });
  const row = watch => render({ watch: [{ name: 'Player', ...watch }] });
  assert.match(row({ proj: 17.6, score: 40.5 }), /proj 17\.6 · actual 40\.5/);
  assert.match(row({ proj: 10, score: 0 }), /proj 10\.0 · actual 0\.0/);
  assert.match(row({ proj: 0, score: -0.1 }), /proj 0\.0 · actual -0\.1/);
  assert.doesNotMatch(row({ proj: 17.6 }), /actual/);
  assert.doesNotMatch(row({ score: 40.5 }), /proj [\d.]+/);
});

test('validation rejects unknown players, wrong editions, unsupported news and unknown teams', () => {
  assert.throws(() => validateDraft({ ...draft, kind: 'satire' }, job, facts), /edition/);
  assert.throws(() => validateDraft({ ...draft, leadTeams: [1, 99] }, job, facts), /team/);
  assert.throws(() => validateDraft({ ...draft, watch: [{ playerId: 'fake', team: 1, note: 'fake' }] }, job, facts), /player/);
  assert.throws(() => validateDraft({ ...draft, kind: 'trade' }, { ...job, kind: 'daily' }, facts), /source event/);
  assert.throws(() => validateDraft({ ...draft, eventKeys: ['invented'] }, job, facts), /source event/);
});

test('daily stories do not recycle old trades and already-covered injuries', () => {
  const input = { ...facts, trades: [
    { id: 'old', completedAt: Date.parse('2026-09-01') },
    { id: 'new', completedAt: Date.parse('2026-09-23') }
  ], injuries: [{ id: 'p1', injuryStatus: 'Out' }] };
  const filtered = editorialFacts(input, [{ eventKeys: ['2026:injury:p1:Out'] }], '2026-09-24T21:00:00Z');
  assert.deepEqual(filtered.trades.map(t => t.id), ['new']);
  assert.deepEqual(filtered.injuries, []);
});

test('completed NFL games contribute no remaining points despite low starter scores', async () => {
  const snapshot = { season: 2026, config: { leagueId: 'test' }, league: { scoring_settings: { rec: 1 } },
    teams, ballotsByWeek: {}, games: [{ id: 'g', week: 3, home: 'BUF', away: 'NYJ', complete: true, status: 'complete' }] };
  const request = async url => {
    if (url.includes('/matchups/')) return [
      { roster_id: 1, matchup_id: 1, points: 3, starters: ['p1'], players_points: { p1: 3 } },
      { roster_id: 2, matchup_id: 1, points: 4, starters: ['p2'], players_points: { p2: 4 } }
    ];
    if (url.endsWith('/players/nfl')) return { p1: { full_name: 'One', position: 'WR', team: 'BUF' }, p2: { full_name: 'Two', position: 'WR', team: 'NYJ' } };
    if (url.includes('/projections/')) return { p1: { rec: 20 }, p2: { rec: 20 } };
    if (url.includes('/stats/')) return { p1: { rec: 3 }, p2: { rec: 4 } };
    if (url.includes('/transactions/')) return [];
    throw new Error('Unexpected URL');
  };
  const result = await loadFacts(snapshot, job, request);
  assert.ok(result.players.every(p => p.remaining === 0));
  assert.equal(result.matchups[0].final, true);
  assert.equal(result.matchups[0].sides[0].projection, 3);
});

test('preparing a prompt leaves the archive intact; published editions cannot duplicate', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'wcxc-news-'));
  try {
    const file = join(folder, 'news.json'), original = JSON.stringify({ articles: [] });
    await writeFile(file, original);
    const time = '2026-09-23T21:00:00Z';
    const snapshot = { season: 2026, week: 3, ballotsByWeek: { 3: Array(8).fill({}) },
      games: [{ id: 'tnf', week: 3, start: Date.parse('2026-09-25T00:15:00Z'), ...eastern('2026-09-25T00:15:00Z') }] };
    const options = { now: new Date(time), newsFile: file, directory: folder,
      getSnapshot: async () => snapshot, getFacts: async () => facts };
    const assignment = await prepare(options);
    assert.equal(assignment.editions.length, 1);
    assert.equal(await readFile(file, 'utf8'), original);
    const drafts = { drafts: [{ id: assignment.editions[0].job.id, article: { ...draft, kind: 'poll' } }] };
    await finalize({ ...options, drafts });
    await assert.rejects(finalize({ ...options, drafts }), /Archive changed/);
    assert.equal((await prepare(options)).editions.length, 0);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).articles.length, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('missing, wrong, or stale Claude output cannot change the archive', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'wcxc-news-'));
  try {
    const file = join(folder, 'news.json'), original = JSON.stringify({ articles: [] });
    await writeFile(file, original);
    const options = { now: new Date('2026-09-23T21:00:00Z'), newsFile: file, directory: folder,
      getSnapshot: async () => ({ season: 2026, week: 3, ballotsByWeek: {},
        games: [{ id: 'tnf', week: 3, start: Date.parse('2026-09-25T00:15:00Z'), ...eastern('2026-09-25T00:15:00Z') }] }),
      getFacts: async () => facts };
    const assignment = await prepare(options);
    await assert.rejects(finalize({ ...options, drafts: null }), /exactly one draft/);
    await assert.rejects(finalize({ ...options, drafts: { drafts: [{ id: 'fake', article: draft }] } }), /Missing edition/);
    await assert.rejects(finalize({ ...options, drafts: { drafts: [{ id: assignment.editions[0].job.id, article: draft }] } }), /wrong edition/);
    await assert.rejects(finalize({ ...options, now: new Date('2026-09-23T22:00:00Z'), drafts: null }), /expired/);
    assert.equal(await readFile(file, 'utf8'), original);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

/* Run #14 failed with error_max_turns on a 318 KB assignment. Two things made
   it that big: every starter was serialised twice (once in facts.players, once
   inside each matchup side), and two due editions each carried a full copy of
   identical league facts. Both are now collapsed, and the collapse has to be
   perfectly reversible or articles would be assembled from partial facts. */
const edition = (id, extra) => ({ job: { id }, facts: {
  season: 2026, week: 3, slot: id, teams: [{ id: 1 }, { id: 2 }],
  players: [{ id: 'p1', team: 1 }], matchups: [{ teams: [1, 2] }], ...extra } });

test('facts identical across editions are written once and restored exactly', () => {
  const before = { editions: [edition('a', { brief: 'one' }), edition('b', { brief: 'two' })] };
  const shared = shareFacts(before);
  assert.ok(shared.sharedFacts, 'common facts should be hoisted');
  assert.deepEqual(Object.keys(shared.editions[0].facts).sort(), ['brief', 'slot']);
  assert.ok(!('teams' in shared.editions[0].facts), 'shared keys must not be duplicated');
  assert.ok(JSON.stringify(shared).length < JSON.stringify(before).length, 'it should actually be smaller');
  const after = readBack(shared);
  assert.deepEqual(after.editions, before.editions);
});

test('a lone edition is left alone, and readBack is a no-op without sharedFacts', () => {
  const one = { editions: [edition('a')] };
  assert.deepEqual(shareFacts(one), one);
  assert.deepEqual(readBack(one), one);
});

test('editions that share nothing are not rewritten', () => {
  const nothing = { editions: [{ job: { id: 'a' }, facts: { x: 1 } }, { job: { id: 'b' }, facts: { x: 2 } }] };
  assert.deepEqual(shareFacts(nothing), nothing);
});

test('matchup starters are ids, not second copies of the player rows', async () => {
  const snap = { season: 2026, config: { leagueId: 'test' }, league: { scoring_settings: { rec: 1 } },
    teams, ballotsByWeek: {}, games: [{ id: 'g', week: 3, home: 'BUF', away: 'NYJ', complete: false, status: 'pre_game' }] };
  const request = async url => {
    if (url.includes('/matchups/')) return [
      { roster_id: 1, matchup_id: 1, points: 3, starters: ['p1'], players_points: { p1: 3 } },
      { roster_id: 2, matchup_id: 1, points: 4, starters: ['p2'], players_points: { p2: 4 } }
    ];
    if (url.endsWith('/players/nfl')) return { p1: { full_name: 'One', position: 'WR', team: 'BUF' }, p2: { full_name: 'Two', position: 'WR', team: 'NYJ' } };
    if (url.includes('/projections/')) return { p1: { rec: 20 }, p2: { rec: 20 } };
    if (url.includes('/stats/')) return { p1: { rec: 3 }, p2: { rec: 4 } };
    if (url.includes('/transactions/')) return [];
    throw new Error('Unexpected URL');
  };
  const facts = await loadFacts(snap, job, request);
  for (const m of facts.matchups) for (const side of m.sides) {
    assert.ok(Array.isArray(side.starters) && side.starters.length);
    for (const id of side.starters) {
      assert.equal(typeof id, 'string', 'starters must be plain ids, not player objects');
      assert.ok(facts.players.some(p => p.id === id), `starter ${id} must resolve in facts.players`);
    }
  }
});
