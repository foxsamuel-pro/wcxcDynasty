/* Clicking a voter opens their voter report. The page's own goTo() and click
   listener run in a vm: goTo() clears S.profile on its way, and choosing the
   voter before calling it left the report unreachable after the six-tab redesign. */
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
const goTo = between('function goTo(tab, view){', 'document.querySelectorAll(".tab")');
const click = between('main.addEventListener("click",e=>{\r\n  const prow', '\nfunction copyPoll') || '';

test('clicking a voter opens their report on the Voters view', () => {
  const listeners = [];
  const drawn = [];
  const ctx = vm.createContext({
    MOVED: {}, TABS: ['poll', 'vote', 'news', 'casino', 'outlook', 'trades'],
    S: { tab: 'poll', pv: 'poll', profile: null, ranked: [1] },
    store: { set() {} }, window: { scrollTo() {} },
    render: () => drawn.push({ pv: ctx.S.pv, profile: ctx.S.profile }),
    loadCasino() {}, refreshBallots() {}, preloadOwn() {},
    main: { addEventListener: (t, f) => { if (t === 'click') listeners.push(f); } },
  });
  vm.runInContext(goTo + click, ctx);
  const row = { dataset: { profile: '7' } };
  listeners[0]({ target: { closest: sel => sel === '[data-profile]' ? row : null } });
  assert.equal(ctx.S.pv, 'voters');
  assert.equal(ctx.S.profile, 7, 'the voter survives the trip through goTo()');
  assert.deepEqual(drawn.at(-1), { pv: 'voters', profile: 7 }, 'and the last drawing is their report');
});
