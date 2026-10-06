/* The Casino tab, run for real in a vm with the data stubbed — sliced out of
   index.html like the other UI tests, so these are claims about what ships. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkSlip } from '../supabase/functions/_shared/casino.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = html.indexOf(from); assert.ok(i > 0, `anchor missing: ${from}`);
  const j = html.indexOf(to, i); assert.ok(j > i, `closing anchor missing: ${to}`);
  return html.slice(i, j);
};
const source = between('const CS = { rules:null', '/* ---------- events ---------- */');

const RULES = { id: 1, reward_ballot: '50.00', reward_picks: '50.00', min_stake: '1.00', max_stake_straight: '100.00',
  max_stake_parlay: '25.00', max_payout: '1000.00', max_open: 10, parlay_min_legs: 2, parlay_max_legs: 6,
  parlay_max_price: '21.0000', leg_min_price: '1.2000', leg_max_price: '11.0000', live_enabled: false,
  live_delay_sec: 45, live_tolerance: '0.0500', prop_american: -115, fantasy_hold: '0.0450' };
const FUT = '2099-10-09T00:15:00Z';
const nfl = (ev, market, side, label, point, american, price, o = {}) => ({ id: `nfl:${ev}:${market}:${side}`, season: 2026, week: 5,
  event: `nfl:${ev}`, sport: 'nfl', market, side, label, event_label: 'TB @ DAL', point, price, american, team: null, teams: null,
  commence_at: FUT, state: 'pre', score: '', status: 'open', ...o });
const LINES = [
  nfl(1, 'ml', 'away', 'TB', null, 360, 4.6), nfl(1, 'ml', 'home', 'DAL', null, -470, 1.2128),
  nfl(1, 'spread', 'away', 'TB', 9.5, -115, 1.8696), nfl(1, 'spread', 'home', 'DAL', -9.5, -105, 1.9524),
  nfl(1, 'total', 'over', 'Over', 47.5, -110, 1.9091), nfl(1, 'total', 'under', 'Under', 47.5, -110, 1.9091),
  ...['5', '6'].map(t => ({ ...nfl(0, 'ml', t, '', null, t === '5' ? -150 : 130, t === '5' ? 1.6667 : 2.3),
    id: `fan:2026:5:3:ml:${t}`, event: 'fan:2026:5:3', sport: 'fantasy', team: +t, teams: [5, 6], event_label: '' })),
  { ...nfl(0, 'total', 'under', '', 240.5, -110, 1.9091), id: 'fan:2026:5:3:total:under', event: 'fan:2026:5:3',
    sport: 'fantasy', teams: [5, 6], event_label: '' },
];

function page({ voter = 5, slip = [], bets = [], banks = [] } = {}) {
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, owner: `M${i + 1}` }));
  const main = { innerHTML: '', addEventListener() {}, contains: () => false };
  const ctx = vm.createContext({ console, Math, Date, Number, Object, Array, Set, JSON, String, Infinity, isNaN,
    ET: 'America/New_York', TEAMS: teams, T: Object.fromEntries(teams.map(t => [t.id, t])),
    S: { tab: 'casino', voter }, configured: true, sb: null, main,
    document: { getElementById: () => null, activeElement: null },
    store: { get: (k, d) => d, set() {} },
    SHORT_NAMES: Object.fromEntries(teams.map(t => [t.id, `T${t.id}`])),
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    img: id => `<img data-av="${id}">`, banner: () => '', busyComposing: () => false });
  vm.runInContext(`const pkName = id => SHORT_NAMES[id] || T[id]?.name || \`Team \${id}\`;\n${source}
    CS.rules = ${JSON.stringify(RULES)}; CS.loaded = true;
    CS.lines = ${JSON.stringify(LINES)}.map(csNum); csIndex(CS.lines);
    CS.slip = ${JSON.stringify(slip)}; CS.bets = ${JSON.stringify(bets)}; CS.banks = ${JSON.stringify(banks)};
    this.CS = CS; this.csCheck = csCheck; this.renderCasino = renderCasino; this.csSel = csSel;`, ctx);
  ctx.renderCasino();
  return { html: main.innerHTML, ctx };
}

test('the board shows every market, and the slip reflects what is selected', () => {
  const { html } = page({ slip: ['nfl:1:spread:away'] });
  for (const l of LINES) assert.ok(html.includes(`data-line="${l.id}"`), `${l.id} has a button`);
  assert.match(html, /data-line="nfl:1:spread:away" aria-pressed="true"/);
  assert.match(html, /TB \+9\.5/, 'the slip names the selection with its point');
  assert.match(html, /Bet slip \(1\)/);
  assert.match(html, /NFL · Week 5/);
});

test('a team cannot even select a bet against itself', () => {
  const { html } = page({ voter: 5 });
  const btn = id => html.match(new RegExp(`<button[^>]*data-line="${id}"[^>]*>`))[0];
  assert.match(btn('fan:2026:5:3:ml:6'), /disabled/, 'the opponent');
  assert.match(btn('fan:2026:5:3:total:under'), /disabled/, 'the under on its own game');
  assert.doesNotMatch(btn('fan:2026:5:3:ml:5'), /disabled/, 'backing itself is fine');
  const other = page({ voter: 7 }).html;
  assert.doesNotMatch(other.match(/<button[^>]*data-line="fan:2026:5:3:ml:6"[^>]*>/)[0], /disabled/);
});

test('bankrolls rank every team, including teams with no money yet', () => {
  const { html } = page({ banks: [{ voter: 3, balance: '120.00', earned: '100.00', at_risk: '20.00', staked: '40.00', returned: '60.00', won: 1, lost: 1, pushed: 0 }] });
  const table = html.slice(html.indexOf('<h2>Bankrolls</h2>'));
  assert.equal((table.slice(table.indexOf('<tbody>')).match(/<tr>/g) || []).length, 12);
  assert.ok(table.indexOf('Team 3') < table.indexOf('Team 1<'), 'richest first');
  assert.match(table, /\+\$20\.00/, 'betting profit is returned minus staked');
  assert.match(table, /50\.0%/, 'ROI');
});

test('tickets show each leg at the point it was placed, with results', () => {
  const bets = [{ id: 1, voter: 2, kind: 'parlay', stake: '10.00', price: '3.6447', status: 'lost', payout: '0.00', placed_at: '2026-10-08T20:00:00Z',
    bet_legs: [{ line_id: 'nfl:1:spread:away', price: '1.9091', point: '7.5', result: 'loss' },
               { line_id: 'nfl:1:total:over', price: '1.9091', point: '47.5', result: null }] }];
  const { html } = page({ bets });
  assert.match(html, /TB \+7\.5/, 'the spread at placement, not the current +9.5');
  assert.match(html, /2-leg parlay/);
  assert.match(html, /class="r loss">✗/);
  assert.match(html, /Lost/);
});

test("the page's rule check gives the same verdict as the shared module, case for case", () => {
  const { ctx } = page();
  const rules = { min_stake: 1, max_stake_straight: 100, max_stake_parlay: 25, max_payout: 1000, parlay_min_legs: 2,
    parlay_max_legs: 6, parlay_max_price: 21, leg_min_price: 1.2, leg_max_price: 11, live_enabled: false };
  const L = o => ({ status: 'open', state: 'pre', sport: 'nfl', price: 1.9091, commence_at: FUT, label: 'X', event: 'a', ...o });
  const cases = [
    [[L()], 10, 'parlay', 5], [[L(), L()], 10, 'parlay', 5], [[L(), L()], 10, 'singles', 5],
    [[L()], 101, 'parlay', 5], [[L(), L({ event: 'b' })], 26, 'parlay', 5], [[L({ price: 11 })], 100, 'parlay', 5],
    [[L({ price: 1.1 })], 10, 'parlay', 5], [[L({ state: 'in' })], 10, 'parlay', 5], [[L({ status: 'suspended' })], 10, 'parlay', 5],
    [[L({ commence_at: '2020-01-01T00:00:00Z' })], 10, 'parlay', 5], [[L()], 10.555, 'parlay', 5], [[L()], 0.5, 'parlay', 5],
    [[L({ sport: 'fantasy', teams: [5, 6], market: 'ml', team: 6 })], 10, 'parlay', 5],
    [[L({ sport: 'fantasy', teams: [5, 6], market: 'total', side: 'under' })], 10, 'parlay', 5],
    [[L({ sport: 'fantasy', teams: [5, 6], market: 'ml', team: 6 })], 10, 'parlay', 7],
    [Array.from({ length: 7 }, (_, i) => L({ event: `e${i}` })), 1, 'parlay', 5], [[], 10, 'parlay', 5],
  ];
  for (const [legs, stake, mode, voter] of cases) {
    const mine = checkSlip({ legs, stake, voter, rules, mode });
    const pageSays = ctx.csCheck(legs, stake, voter, rules, mode);
    assert.equal(pageSays.length > 0, mine.length > 0, `same verdict for ${JSON.stringify({ n: legs.length, stake, mode, voter, l: legs[0] })}`);
    assert.equal(pageSays.length, mine.length, 'and the same number of problems');
  }
});

test('the tab is registered, routed, and its writes go only through place_bet', () => {
  assert.match(html, /data-tab="casino"/);
  assert.match(html, /const TABS = \[[^\]]*"casino"/);
  assert.match(html, /casino:renderCasino/);
  assert.match(source, /sb\.rpc\("place_bet"/);
  assert.doesNotMatch(source, /\.(insert|update|upsert|delete)\(/, 'the page never writes a table directly');
});
