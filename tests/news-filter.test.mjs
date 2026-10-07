/* The News archive's two filters, a week picker and the category chips, run
   for real in a vm: sliced out of index.html like the casino and odds tests, so
   these are claims about what ships. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = html.indexOf(from); assert.ok(i > 0, `anchor missing: ${from}`);
  const j = html.indexOf(to, i); assert.ok(j > i, `closing anchor missing: ${to}`);
  return html.slice(i, j);
};
const source = between('let NEWS = null;', '/* Scoreboard for a matchup piece') + '\n'
  + between('function renderNews(){', '/* ---------- analysis:');
const changeHandler = between('main.addEventListener("change",e=>{', 'main.addEventListener("keydown"');

const art = (id, week, kind, date) => ({ id, week, kind, date, headline: `Story ${id}`, dek: `dek ${id}`, teams: [] });
const NEWS = [
  art('a1', 5, 'injury', '2026-10-06T10:00:00Z'),
  art('a2', 4, 'recap', '2026-10-06T09:00:00Z'), art('a3', 4, 'injury', '2026-10-05T09:00:00Z'), art('a4', 4, 'recap', '2026-10-05T07:00:00Z'),
  art('a5', 4, 'poll', '2026-10-01T09:00:00Z'),
  art('a6', 3, 'trade', '2026-09-30T09:00:00Z'), art('a7', 3, 'recap', '2026-09-29T09:00:00Z'),
  art('a8', 2, 'satire', '2026-09-20T09:00:00Z'),
];

function page(news = NEWS, state = {}) {
  const main = { innerHTML: '' }, listeners = {};
  main.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const ctx = vm.createContext({ console, Math, Date, Number, Object, Array, Set, JSON, String, Infinity, isNaN,
    S: { tab: 'news', article: null, newsKind: 'all', newsWeek: 'all', ...state }, T: {}, main,
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    img: () => '', shortName: s => s, banner: () => '', header: (t, l = '', k = '') => `<header data-kicker="${k}">${t}</header>`,
    store: { get: (k, d) => d, set() {} }, fetch: async () => ({ ok: false }), render: () => {},
    document: { getElementById: id => id === 'newsweek' ? { focus() { ctx.__focused = id; } } : null },
    configured: true, sb: null, CM: { art: null, list: [], loaded: false, busy: false, msg: null, draft: '' } });
  vm.runInContext(source, ctx);
  vm.runInContext('NEWS = ' + JSON.stringify(news), ctx);
  // the page's own change listener, registered on the same stand-in main
  vm.runInContext(changeHandler.replace(/\}\);\s*$/, '});') , ctx);
  const show = () => { ctx.renderNews(); return main.innerHTML; };
  const shown = () => [...main.innerHTML.matchAll(/data-article="([^"]+)"/g)].map(m => m[1]);
  const options = () => [...main.innerHTML.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(m => ({ value: m[1], selected: !!m[2], label: m[3] }));
  const chips = () => Object.fromEntries([...main.innerHTML.matchAll(/data-kind="([^"]+)">[^<]*<i>(\d+)<\/i>/g)].map(m => [m[1], +m[2]]));
  const pick = value => { listeners.change[0]({ target: { id: 'newsweek', value } }); };
  return { ctx, main, show, shown, options, chips, pick, S: () => ctx.S };
}

test('the archive offers a week picker, latest week first, with how many stories each week holds', () => {
  const p = page();
  p.show();
  assert.deepEqual(p.options().map(o => o.label), ['All weeks (8)', 'Week 5 (1)', 'Week 4 (4)', 'Week 3 (2)', 'Week 2 (1)']);
  assert.ok(p.options()[0].selected, 'it opens on every week');
  assert.deepEqual(p.shown().length, 8);
  assert.match(p.main.innerHTML, /<label class="wk newswk"><span class="sr">Week<\/span><select id="newsweek">/);
  assert.match(p.main.innerHTML, /data-kicker="League wire"/, 'the old "Week 5 WCXC Power Poll" would contradict a week picked here');
});

test('choosing a week shows only that week, and the choice sticks through the redraw', () => {
  const p = page();
  p.show(); p.pick('4');
  assert.equal(p.S().newsWeek, 4, 'a number, not the string, so it compares with a story\'s week');
  assert.deepEqual(p.shown(), ['a2', 'a3', 'a4', 'a5'], 'newest first');
  assert.deepEqual(p.options().find(o => o.selected), { value: '4', selected: true, label: 'Week 4 (4)' });
  assert.equal(p.ctx.__focused, 'newsweek', 'a keyboard user stays on the control the redraw replaced');
  assert.equal((p.main.innerHTML.match(/class="grouphd"/g) || []).length, 1);
  p.pick('all');
  assert.equal(p.S().newsWeek, 'all');
  assert.equal(p.shown().length, 8);
});

test('the week and the category filters combine, and each one\'s counts are what picking it would give', () => {
  const p = page();
  p.show(); p.pick('4');
  assert.deepEqual(p.chips(), { all: 4, injury: 1, recap: 2, poll: 1, trade: 0, satire: 0 }, 'the category counts are for Week 4 only');
  p.S().newsKind = 'recap'; p.show();
  assert.deepEqual(p.shown(), ['a2', 'a4']);
  assert.deepEqual(p.options().map(o => o.label), ['All weeks (3)', 'Week 5 (0)', 'Week 4 (2)', 'Week 3 (1)', 'Week 2 (0)'],
    'the week counts are for recaps only');
  p.pick('3');
  assert.deepEqual(p.shown(), ['a7']);
});

test('a combination with nothing in it says so, and the filters can be changed back', () => {
  const p = page();
  p.S().newsKind = 'satire'; p.S().newsWeek = 5;
  const out = p.show();
  assert.deepEqual(p.shown(), []);
  assert.match(out, /Nothing filed under that yet/);
  assert.match(out, /Try another week or category/);
  assert.match(out, /id="newsweek"/, 'the picker is still there to change it');
  p.pick('all');
  assert.deepEqual(p.shown(), ['a8']);
});

test('a week that is no longer in the archive does not strand the page on an empty list', () => {
  const p = page(NEWS, { newsWeek: 12 });
  p.show();
  assert.equal(p.S().newsWeek, 'all');
  assert.equal(p.shown().length, 8);
});

test('with one week of stories there is nothing to choose between, so no picker', () => {
  const one = NEWS.filter(a => a.week === 4);
  const p = page(one);
  p.show();
  assert.doesNotMatch(p.main.innerHTML, /id="newsweek"/);
  assert.equal(p.shown().length, 4);
});

test('a story with no week is still reachable, under its own heading', () => {
  const p = page([...NEWS, art('x1', null, 'recap', '2026-09-01T09:00:00Z')]);
  p.show();
  assert.equal(p.options().at(-1).label, 'Around the league (1)');
  p.pick('none');
  assert.equal(p.S().newsWeek, 'none');
  assert.deepEqual(p.shown(), ['x1']);
  assert.match(p.main.innerHTML, /class="grouphd">Around the league</);
});
