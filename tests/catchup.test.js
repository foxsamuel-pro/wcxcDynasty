const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the site's actual functions with deterministic Sleeper responses.
// No DOM, dependencies, live league data, or writes to external services.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = (start, end) => {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return html.slice(from, to);
};
const source = [
  section('let UNOFFICIAL =', 'let sb = null;'),
  section('async function loadSchedule()', '/* Score model, two levels.'),
  section('function metricValues(', 'const rankMap =')
].join('\n');

function fixture({ median = true, status = 'complete', unavailable = false,
                   points = [100, 80, 90, 90], stateWeek = 3 } = {}) {
  const teams = points.map((_, i) => ({ id: i + 1, w: 1, l: median ? 1 : 0,
    t: 0, pf: 90, pa: 90, pp: 120 }));
  const requests = [];
  const context = vm.createContext({
    TEAMS: teams, T: Object.fromEntries(teams.map(t => [t.id, t])),
    MEDIAN_MATCH: median, LAST_REG_WEEK: 3, SEASON: 2026, LEAGUE_ID: 'test',
    SCHED: null,
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('/state/nfl')) {
        if (stateWeek === null) throw new Error('state unavailable');
        return { ok: true, json: async () => ({ season_type: 'regular', week: stateWeek }) };
      }
      const week = Number(url.split('/').pop());
      if (url.includes('/scores/')) return { ok: true,
        json: async () => [{ status: week === 2 ? status : 'scheduled' }] };
      if (unavailable && week === 2) throw new Error('matchups unavailable');
      return { ok: true, json: async () => points.map((p, i) => ({
        roster_id: i + 1, matchup_id: Math.floor(i / 2) + 1, points: p
      })) };
    }
  });
  vm.runInContext(source, context);
  return { context, teams, requests, read: code => vm.runInContext(code, context) };
}

test('catch-up adds head-to-head and median results, including ties, once', async () => {
  const f = fixture();
  await f.context.catchUpRecords();
  assert.deepEqual(f.teams.map(t => [t.w, t.l, t.t, t.pf, t.pa]), [
    [3, 1, 0, 190, 170], [1, 3, 0, 170, 190],
    [1, 1, 2, 180, 180], [1, 1, 2, 180, 180]
  ]);
  assert.equal(f.read('RECORDED_WEEKS'), 2);
  assert.equal(f.read('UNOFFICIAL.join(",")'), '2');
  const before = JSON.stringify(f.teams.map(t => [t.w, t.l, t.t, t.pf, t.pa]));
  await f.context.catchUpRecords();
  assert.equal(JSON.stringify(f.teams.map(t => [t.w, t.l, t.t, t.pf, t.pa])), before);
});

test('Analysis efficiency uses official PF and ceiling covering the same weeks', async () => {
  const f = fixture();
  await f.context.catchUpRecords();
  assert.deepEqual(Object.values(f.context.metricValues('eff', null)), [0.75, 0.75, 0.75, 0.75]);
  assert.equal(f.context.metricValues('pf', null)[1], 190);
  assert.equal(f.context.metricValues('record', null)[3], 0.5);
});

test('zero official ceiling remains unavailable while records catch up', async () => {
  const f = fixture();
  f.teams.forEach(t => { t.w = 0; t.l = 0; t.pf = 0; t.pp = 0; });
  f.teams[0].pfOff = 0;
  f.teams[0].ppOff = 0;
  f.teams[0].pf = 100;
  f.teams[0].pp = 120;
  assert.equal(f.context.metricValues('eff', null)[1], null);
});

for (const options of [{ status: 'in_progress' }, { unavailable: true }]) {
  test(`unfinished or unavailable results are not banked: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await f.context.catchUpRecords();
    assert.equal(f.read('RECORDED_WEEKS'), 1);
    assert.equal(f.read('UNOFFICIAL.length'), 0);
    assert.ok(f.teams.every(t => t.pf === 90 && t.w === 1 && t.l === 1));
    await f.context.loadSchedule();
    assert.equal(f.context.SCHED.firstOpen, 2);
  });
}

for (const stateWeek of [1, 4, null]) {
  test(`schedule excludes banked weeks when Sleeper state is ${stateWeek}`, async () => {
    const f = fixture({ stateWeek });
    await f.context.catchUpRecords();
    await f.context.loadSchedule();
    assert.equal(f.context.SCHED.firstOpen, 3);
    assert.equal(f.context.SCHED.weeks.map(w => w.w).join(','), '3');
    assert.ok(Object.values(f.context.SCHED.scores).every(scores => scores.length === 2));
  });
}

test('schedule respects snapshot records without a successful Sleeper bootstrap', async () => {
  const f = fixture({ stateWeek: null });
  await f.context.loadSchedule();
  assert.equal(f.context.SCHED.firstOpen, 2);
  assert.equal(f.context.metricValues('eff', null)[1], 0.75);
});

test('head-to-head-only leagues bank one result per week', async () => {
  const f = fixture({ median: false });
  await f.context.catchUpRecords();
  assert.deepEqual(f.teams.map(t => [t.w, t.l, t.t]), [
    [2, 0, 0], [1, 1, 0], [1, 0, 1], [1, 0, 1]
  ]);
  await f.context.loadSchedule();
  assert.equal(f.context.SCHED.firstOpen, 3);
});
