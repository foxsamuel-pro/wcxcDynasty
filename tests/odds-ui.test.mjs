import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dueToday } from '../scripts/odds/build.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const source = slice('let SCHED = null, ODDS = null', 'async function loadSchedule()') + '\n' + slice('const pct =', '\nfunction render(){');
const snapshot = JSON.parse(readFileSync(new URL('../odds.json', import.meta.url), 'utf8'));
function context(data = snapshot, error = false) {
  const teams = snapshot.rows.map((r, i) => ({ id: r.id, name: 'Team ' + r.id, div: Math.floor(i / 4),
    owner: 'Manager', ...snapshot.records[r.id] }));
  let requests = 0;
  const ctx = vm.createContext({ TEAMS: teams, SEASON: snapshot.season, LEAGUE_ID: snapshot.leagueId,
    DIVISIONS: { 0: 'One', 1: 'Two', 2: 'Three' }, S: { tab: 'odds' }, main: { innerHTML: '' },
    esc: x => String(x), img: () => '', rec: t => `${t.w}-${t.l}`, banner: () => '', header: (a, b = '') => a + b,
    fetch: async url => { requests++; assert.equal(url, 'odds.json'); if (error) throw Error('offline'); return { ok: true, json: async () => data }; }
  });
  vm.runInContext(source, ctx);
  return { ctx, get requests() { return requests; } };
}
test('inline application script parses after odds replacement', () => {
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  assert.doesNotThrow(() => new vm.Script(script));
});
test('odds load independently after Analysis has already cached its schedule', async () => {
  const f = context(); vm.runInContext('SCHED={weeks:[]}', f.ctx);
  await f.ctx.loadOdds();
  const page = f.ctx.main.innerHTML;
  assert.equal((page.match(/<tr>/g) || []).length, 13);
  assert.match(page, /1,000 simulated seasons/); assert.match(page, /95% simulation sampling interval/);
  assert.match(page, /superflex/); assert.doesNotMatch(page, /NaN|undefined/);
  f.ctx.renderOdds(); assert.equal(f.requests, 1);
});
test('unavailable, wrong-season, and incomplete snapshots show an explicit failure', async () => {
  for (const [data, error] of [[snapshot, true], [{ ...snapshot, season: 2000 }, false], [{ ...snapshot, rows: snapshot.rows.slice(1) }, false]]) {
    const f = context(data, error); await f.ctx.loadOdds();
    assert.match(f.ctx.main.innerHTML, /Forecast unavailable/);
    assert.doesNotMatch(f.ctx.main.innerHTML, /Sim pts\/wk/);
  }
});
test('stale snapshots remain readable with a visible update warning', async () => {
  const f = context({ ...snapshot, generated: '2020-01-01T12:00:00Z' });
  await f.ctx.loadOdds(); assert.match(f.ctx.main.innerHTML, /daily update is delayed/);
  assert.equal((f.ctx.main.innerHTML.match(/<tr>/g) || []).length, 13);
});
test('new banked results mark an otherwise fresh forecast as behind', async () => {
  const f = context({ ...snapshot, generated: new Date().toISOString() });
  f.ctx.TEAMS[0].w += 2;
  await f.ctx.loadOdds(); assert.match(f.ctx.main.innerHTML, /New results have arrived/);
});
test('daily refresh uses Eastern dates and 6 AM through daylight saving changes', () => {
  assert.equal(dueToday(null, new Date('2026-09-23T09:17:00Z')), false);
  assert.equal(dueToday(null, new Date('2026-09-23T10:17:00Z')), true);
  assert.equal(dueToday(null, new Date('2026-12-23T10:17:00Z')), false);
  assert.equal(dueToday(null, new Date('2026-12-23T11:17:00Z')), true);
  const old = { modelVersion: 1, generated: '2026-09-23T10:17:00Z' };
  assert.equal(dueToday(old, new Date('2026-09-23T18:17:00Z')), false);
  assert.equal(dueToday(old, new Date('2026-09-24T10:17:00Z')), true);
});
