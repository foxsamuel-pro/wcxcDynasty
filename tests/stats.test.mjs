import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const source = slice('/* ---------- stats ----------', '/* ---------- events ---------- */');
const file = JSON.parse(readFileSync(new URL('../stats.json', import.meta.url), 'utf8'));

function context() {
  const ids = Object.keys(file.seasons.at(-1).teams).map(Number);
  const T = Object.fromEntries(ids.map(id => [id, { id, name: 'Team ' + id, owner: 'Manager ' + id }]));
  const ctx = vm.createContext({
    TEAMS: ids.map(id => T[id]), T, SHORT_NAMES: {}, S: { tab: 'stats' }, main: { innerHTML: '' },
    store: { get: (k, d) => d, set() {} }, esc: x => String(x), img: id => `<img data-id="${id}">`,
    ord: n => n + 'th', banner: () => '', header: (a, b = '', k = '') => k + a + b,
    window: { scrollTo() {} },
    document: { getElementById: () => ({ addEventListener() {} }) },
    // the live refresh: Sleeper is "down", so the file's copy stands
    fetch: async url => url === 'stats.json' ? { ok: true, json: async () => structuredClone(file) } : { ok: false }
  });
  vm.runInContext(source, ctx);
  return ctx;
}

test('records match Sleeper\'s own totals for every team in every season', async () => {
  const ctx = context();
  await ctx.loadStats();
  for (const s of file.seasons) {
    const A = vm.runInContext(`stTeams({season:${s.season}, week:"all", phase:"reg", median:true})`, ctx);
    for (const [id, team] of Object.entries(s.teams))
      assert.deepEqual([A[id].W, A[id].L, A[id].T], team.rec, `${s.season} roster ${id}`);
  }
});

test('champions and finishes come from the winners bracket', async () => {
  const ctx = context();
  await ctx.loadStats();
  const champ = y => vm.runInContext(`(s=>Object.keys(s.places).map(Number).find(id=>s.places[id]===1))(stSeason(${y}))`, ctx);
  assert.equal(champ(2023), 1); assert.equal(champ(2024), 5); assert.equal(champ(2025), 1);
  const s25 = vm.runInContext('stSeason(2025)', ctx);
  assert.equal(s25.playoffIds.size, 6);
  assert.deepEqual(Object.values(s25.finish).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  // a bracket Sleeper has only drawn is not a playoff trip yet
  if (file.seasons.at(-1).status !== 'complete')
    assert.equal(vm.runInContext('STATS.seasons.at(-1).playoffIds.size', ctx), 0);
  // two-week rounds are one game each
  const g24 = vm.runInContext('STATS.games.filter(g=>g.po && g.season===2024)', ctx);
  assert.equal(g24.length, 4); assert.ok(g24.every(g => g.weeks.length === 2));
});

test('every view renders for every kind of filter', async () => {
  const ctx = context();
  await ctx.loadStats();
  const filters = [
    { season: '"all"', week: '"all"', phase: '"all"', median: true },
    { season: 2025, week: 3, phase: '"reg"', median: false },
    { season: 2024, week: '"all"', phase: '"po"', median: true },
    { season: '"all"', week: 16, phase: '"all"', median: true }
  ];
  for (const f of filters) for (const view of ['standings', 'h2h', 'games', 'records', 'honors', 'team']) for (const b of ['"all"', 5]) {
    vm.runInContext(`Object.assign(ST, {season:${f.season}, week:${f.week}, phase:${f.phase}, median:${f.median}, view:"${view}", b:${b}}); renderStats()`, ctx);
    const page = ctx.main.innerHTML;
    assert.doesNotMatch(page, /NaN|undefined|Infinity|\[object/, `${view} ${JSON.stringify(f)}`);
    assert.match(page, /How this is counted/);
  }
});
