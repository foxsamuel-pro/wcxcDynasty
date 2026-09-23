import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dueToday } from '../scripts/odds/build.mjs';
import { MODEL_VERSION } from '../scripts/odds/model.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const source = slice('let SCHED = null, ODDS = null', 'async function loadSchedule()') + '\n' + slice('const pct =', '\nfunction render(){') + '\n' + slice('function renderPoll(){', 'function renderGrid(){');
const snapshot = JSON.parse(readFileSync(new URL('../odds.json', import.meta.url), 'utf8'));
function context(data = snapshot, error = false) {
  const teams = snapshot.rows.map((r, i) => ({ id: r.id, name: 'Team ' + r.id, div: Math.floor(i / 4),
    owner: 'Manager', ...snapshot.records[r.id] }));
  let requests = 0;
  const ctx = vm.createContext({ TEAMS: teams, SEASON: snapshot.season, LEAGUE_ID: snapshot.leagueId,
    DIVISIONS: { 0: 'One', 1: 'Two', 2: 'Three' }, S: { tab: 'odds', week: 1 }, main: { innerHTML: '' },
    tally: () => ({ bs: [{ voter: 1 }], rows: teams.map((t, i) => ({ t, pts: 12 - i, avg: i + 1, hi: i + 1, lo: i + 1 })) }),
    waitingOn: () => '', emptyState: () => 'No ballots yet',
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
  assert.match(page, /10,000 simulated seasons/); assert.match(page, /95% simulation sampling interval/);
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
  const old = { modelVersion: MODEL_VERSION, generated: '2026-09-23T10:17:00Z' };
  assert.equal(dueToday(old, new Date('2026-09-23T18:17:00Z')), false);
  assert.equal(dueToday(old, new Date('2026-09-24T10:17:00Z')), true);
});

test('Poll lazily loads playoff odds by team ID and labels historical polls with latest forecast', async () => {
  const f = context(); f.ctx.S.tab = 'poll'; f.ctx.TEAMS.reverse();
  f.ctx.renderPoll();
  assert.match(f.ctx.main.innerHTML, /Loading the latest playoff forecast/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests, 1);
  const page = f.ctx.main.innerHTML;
  assert.match(page, /Playoffs<i class="subh">latest odds/);
  assert.match(page, /including when viewing an older poll/);
  const cells = [...page.matchAll(/data-l="Playoffs \(latest\)"[^>]*>(.*?)<\/td>/g)].map(m => m[1]);
  assert.equal(cells.length, 12);
  for (let i = 0; i < cells.length; i++) {
    const p = snapshot.rows.find(r => r.id === f.ctx.TEAMS[i].id).po;
    assert.equal(cells[i], vm.runInContext(`oddsPct(${p})`, f.ctx));
  }
  f.ctx.renderPoll(); assert.equal(f.requests, 1);
});

test('Poll remains usable when odds are unavailable and marks stale odds visibly', async () => {
  const failed = context(snapshot, true); failed.ctx.S.tab = 'poll';
  await failed.ctx.loadOdds();
  assert.match(failed.ctx.main.innerHTML, /Playoff forecast unavailable/);
  assert.equal((failed.ctx.main.innerHTML.match(/<tr>/g) || []).length, 13);
  const stale = context({ ...snapshot, generated: '2020-01-01T12:00:00Z' }); stale.ctx.S.tab = 'poll';
  await stale.ctx.loadOdds(); assert.match(stale.ctx.main.innerHTML, /Update pending/);
});

test('small title chances and very high probabilities never round to a false zero or certainty', () => {
  const f = context();
  assert.equal(vm.runInContext('oddsPct(.0001)', f.ctx), '&lt;0.1%');
  assert.equal(vm.runInContext('oddsPct(.9999)', f.ctx), '&gt;99.9%');
  assert.equal(vm.runInContext('oddsPct(.125)', f.ctx), '12.5%');
});
