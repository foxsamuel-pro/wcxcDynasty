/* The Casino tab, run for real in a vm with the data stubbed — sliced out of
   index.html like the other UI tests, so these are claims about what ships. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkSlip, simulateGame, ticketPrice, gameLines, parseEvent, simHex, americanToDecimal } from '../supabase/functions/_shared/casino.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = html.indexOf(from); assert.ok(i > 0, `anchor missing: ${from}`);
  const j = html.indexOf(to, i); assert.ok(j > i, `closing anchor missing: ${to}`);
  return html.slice(i, j);
};
const source = between('const CS = { rules:null', '/* ---------- events ---------- */');

const RULES = { id: 1, reward_ballot: '100.00', min_stake: '1.00', max_stake_straight: '100.00',
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

function page({ voter = 5, slip = [], bets = [], banks = [], rules = {}, props = null, view = 'board', games = [] } = {}) {
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, owner: `M${i + 1}` }));
  const main = { innerHTML: '', addEventListener() {}, contains: () => false };
  const ctx = vm.createContext({ console, Math, Date, Number, Object, Array, Set, JSON, String, Infinity, isNaN,
    ET: 'America/New_York', TEAMS: teams, T: Object.fromEntries(teams.map(t => [t.id, t])),
    S: { tab: 'casino', voter }, configured: true, sb: null, main,
    document: { getElementById: () => null, activeElement: null },
    store: { get: (k, d) => d, set() {} },
    SHORT_NAMES: Object.fromEntries(teams.map(t => [t.id, `T${t.id}`])),
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    rec: t => `${t?.w ?? 0}-${t?.l ?? 0}`,
    img: id => `<img data-av="${id}">`, banner: () => '', busyComposing: () => false });
  vm.runInContext(`const pkName = id => SHORT_NAMES[id] || T[id]?.name || \`Team \${id}\`;\n${source}
    CS.rules = ${JSON.stringify({ ...RULES, ...rules })}; CS.loaded = true;
    ${props ? `CS.propsOpen[${JSON.stringify(props[0].event)}] = true; CS.props[${JSON.stringify(props[0].event)}] = ${JSON.stringify(props)}.map(csNum); csIndex(CS.props[${JSON.stringify(props[0].event)}]);` : ''}
    CS.lines = ${JSON.stringify(LINES)}.map(csNum); csIndex(CS.lines);
    CS.slip = ${JSON.stringify(slip)}; CS.bets = ${JSON.stringify(bets)}; CS.banks = ${JSON.stringify(banks)};
    CS.view = ${JSON.stringify(view)}; CS.games = Object.fromEntries(${JSON.stringify(games)}.map(g => [g.event, g]));
    this.CS = CS; this.csCheck = csCheck; this.renderCasino = renderCasino; this.csSel = csSel;
    this.csTicketPrice = csTicketPrice; this.csSimBytes = csSimBytes; this.csTicket = csTicket;`, ctx);
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

test('your own matchup: the opponent and the under are disabled, and the page says why', () => {
  const open = page({ voter: 5, rules: { block_self_bets: false } }).html;
  assert.doesNotMatch(open.match(/<button[^>]*data-line="fan:2026:5:3:ml:6"[^>]*>/)[0], /disabled/, 'only if the commissioner allows it');
  assert.doesNotMatch(open, /Your matchup/);
  const { html } = page({ voter: 5, rules: { block_self_bets: true } });
  assert.match(html, /Your matchup: you can back your team, but not bet against it/, 'visible on a phone, not just a tooltip');
  const btn = id => html.match(new RegExp(`<button[^>]*data-line="${id}"[^>]*>`))[0];
  assert.match(btn('fan:2026:5:3:ml:6'), /disabled/, 'the opponent');
  assert.match(btn('fan:2026:5:3:total:under'), /disabled/, 'the under on its own game');
  assert.doesNotMatch(btn('fan:2026:5:3:ml:5'), /disabled/, 'backing itself is fine');
  const other = page({ voter: 7 }).html;
  assert.doesNotMatch(other.match(/<button[^>]*data-line="fan:2026:5:3:ml:6"[^>]*>/)[0], /disabled/);
});

test('bankrolls rank every team, including teams with no money yet', () => {
  const { html } = page({ view: 'banks', banks: [{ voter: 3, balance: '120.00', earned: '100.00', at_risk: '20.00', staked: '40.00', returned: '60.00', won: 1, lost: 1, pushed: 0 }] });
  const table = html.slice(html.indexOf('<h2>Bankrolls</h2>'));
  assert.equal((table.slice(table.indexOf('<tbody>')).match(/<tr>/g) || []).length, 12);
  assert.ok(table.indexOf('Team 3') < table.indexOf('Team 1<'), 'richest first');
  assert.match(table, /\+\$20\.00/, 'betting profit is returned minus staked');
  assert.match(table, /50\.0%/, 'ROI');
});

test('tickets show each leg at the point it was placed, with results', () => {
  const bets = [{ id: 1, voter: 2, kind: 'parlay', stake: '10.00', price: '3.6447', status: 'lost', payout: '0.00', placed_at: '2026-10-08T20:00:00Z',
    bet_legs: [{ line_id: 'nfl:1:spread:away', price: '1.9091', point: '7.5', result: 'loss', event: 'nfl:1' },
               { line_id: 'nfl:1:total:over', price: '1.9091', point: '47.5', result: null, event: 'nfl:1' }] }];
  const { html } = page({ view: 'bets', feed: 'all', bets });
  assert.match(html, /TB \+7\.5/, 'the spread at placement, not the current +9.5');
  assert.match(html, /2 Pick Parlay/);
  assert.match(html, /tkmark loss/, 'the losing leg is marked as lost');
  assert.match(html, /tkmark open/, 'and the undecided one is still open');
  assert.match(html, /Lost/);
  assert.match(html, /Wager: <b>\$10\.00<\/b>/);
  assert.match(html, /Paid: <b[^>]*>\$0\.00/, 'a settled ticket says what it paid, not what it could');
  assert.match(html, /SGP/, 'both legs are from one game');
});

/* The new part: a ticket shows the game it is riding on and how far a prop has
   got. Both are read from what the sync wrote; neither decides anything. */
test('a ticket carries the live game it rides on, and a prop bar against its line', () => {
  const games = [{ event: 'nfl:1', sport: 'nfl', season: 2026, week: 5, commence_at: FUT, state: 'in',
    detail: 'Q3 3:22', situation: '1st & 10 at DAL 27', possession: 'away', away: 'TB', home: 'DAL',
    away_score: '16', home_score: '19', away_periods: [7, 9, 0], home_periods: [3, 13, 3] }];
  const prop = { id: 'prop:1:s9:rec_yd:over', season: 2026, week: 5, event: 'nfl:1', sport: 'prop',
    market: 'rec_yd', side: 'over', label: 'Mike Evans', event_label: 'TB @ DAL', point: 24.5,
    price: 2.8, american: 180, team: null, teams: null, player: 's9', nfl_team: 'TB',
    commence_at: FUT, state: 'in', score: '', status: 'open', live: 18 };
  const bets = [{ id: 2, voter: 5, kind: 'straight', stake: '5.00', price: '2.8000', status: 'open', payout: null,
    placed_at: '2026-10-08T20:00:00Z', bet_legs: [{ line_id: prop.id, price: '2.8000', point: '24.5', result: null, event: 'nfl:1' }] }];
  const { html } = page({ view: 'bets', bets, props: [prop], games });
  assert.match(html, /Q3 3:22/, 'the clock');
  assert.match(html, /1st &amp; 10 at DAL 27/, 'the down and distance');
  assert.match(html, /bxposs" data-on="1"/, 'and who has the ball');
  const box = html.slice(html.indexOf('tkbox'));
  for (const q of ['>7<', '>9<', '>0<', '>3<', '>13<']) assert.ok(box.includes(q), `quarter ${q} is on the board`);
  assert.match(html, /class="tkbub"[^>]*>18</, 'the prop has reached 18');
  assert.match(html, /class="tkline"[^>]*>24\.5</, 'against a line of 24.5');
  // and with nothing recorded there is simply no bar
  const none = page({ view: 'bets', bets, props: [{ ...prop, live: null }], games }).html;
  assert.doesNotMatch(none, /tkbub/);
});

test("the page's rule check gives the same verdict as the shared module, case for case", () => {
  const { ctx } = page();
  const rules = { min_stake: 1, max_stake_straight: 100, max_stake_parlay: 25, max_payout: 1000, parlay_min_legs: 2,
    parlay_max_legs: 6, parlay_max_price: 21, leg_min_price: 1.2, leg_max_price: 11, live_enabled: false,
    sgp_max_legs: 4, block_self_bets: true };
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

test("the page prices a same-game parlay exactly as the shared module does", () => {
  const board = JSON.parse(readFileSync(new URL('./fixtures/espn-scoreboard-w5.json', import.meta.url), 'utf8'));
  const ev = board.events[0], e = parseEvent(ev), event = 'nfl:' + e.id;
  const rows = gameLines(ev, { season: 2026, week: 5 });
  const prop = (player, team, market, side, point) => ({ id: `prop:${e.id}:${player}:${market}:${side}`, event, sport: 'prop',
    market, side, point, price: americanToDecimal(-115), player, nfl_team: team, label: player, state: 'pre', status: 'open' });
  const props = [prop('q', 'TB', 'pass_yd', 'over', 230.5), prop('q', 'TB', 'pass_yd', 'under', 230.5),
    prop('w', 'TB', 'rec_yd', 'over', 60.5), prop('w', 'TB', 'rec_yd', 'under', 60.5)];
  const { bits } = simulateGame({ event, lines: rows, props, positions: { q: 'QB', w: 'WR' } });
  const { ctx } = page();
  // what the page receives from Supabase: hex text, decoded by the page itself
  for (const [id, b] of Object.entries(bits)) ctx.CS.sims[id] = ctx.csSimBytes(simHex(b));
  const rules = { sgp_hold: 0.15, sgp_max_legs: 4, sgp_min_hits: 20, parlay_max_price: 21 };
  const all = [...rows, ...props].map(l => ({ ...l, state: 'pre', status: 'open' }));
  const pick = (...ends) => ends.map(x => all.find(l => l.id.endsWith(x)));
  const combos = [
    pick(':spread:home', ':ml:home'), pick(':total:over', 'q:pass_yd:over'), pick('q:pass_yd:over', 'w:rec_yd:over'),
    pick('q:pass_yd:over', 'w:rec_yd:under'), pick(':spread:away', ':total:under', 'w:rec_yd:over'), pick(':total:over', ':total:under'),
  ];
  for (const legs of combos) {
    const mine = ticketPrice(legs, id => bits[id], rules), theirs = ctx.csTicketPrice(legs, rules);
    assert.equal(theirs.err, mine.err, 'same refusal for ' + legs.map(l => l.id).join(' + '));
    assert.equal(theirs.price, mine.price, 'same price for ' + legs.map(l => l.id).join(' + '));
  }
});

test('the props drawer shows touchdown scorers, over/unders and milestone ladders, and names FanDuel as the source', () => {
  const p = (id, market, side, point, american, label = 'CeeDee Lamb') => ({ id: 'prop:1:s6786:' + id, season: 2026, week: 5, event: 'nfl:1',
    sport: 'prop', market, side, label, event_label: 'TB @ DAL', point, price: american > 0 ? 1 + american / 100 : 1 + 100 / -american,
    american, team: null, teams: null, player: '6786', nfl_team: 'DAL', commence_at: FUT, state: 'pre', score: '', status: 'open' });
  const props = [p('atd:yes', 'atd', 'yes', null, 120), p('td2:yes', 'td2', 'yes', null, 600), p('ltd:yes', 'ltd', 'yes', null, 750),
    p('rec_yd:over', 'rec_yd', 'over', 80.5, -114), p('rec_yd:under', 'rec_yd', 'under', 80.5, -114),
    p('rec_yd:ms100', 'rec_yd', 'over', 99.5, 210), p('rec_yd:ms50', 'rec_yd', 'over', 49.5, -400)];
  const { html, ctx } = page({ props });
  assert.match(html, /FanDuel's lines and prices/);
  assert.match(html, /Touchdowns<\/span>.*Anytime.*\+120.*2\+ TDs.*\+600.*Last TD.*\+750/s);
  assert.ok(html.indexOf('>50+<') < html.indexOf('>100+<'), 'a ladder runs low to high');
  assert.equal(ctx.csSel(ctx.CS.byId['prop:1:s6786:atd:yes']), 'CeeDee Lamb anytime TD');
  assert.equal(ctx.csSel(ctx.CS.byId['prop:1:s6786:rec_yd:ms100']), 'CeeDee Lamb 100+ receiving yards');
  assert.equal(ctx.csSel(ctx.CS.byId['prop:1:s6786:rec_yd:over']), 'CeeDee Lamb over 80.5 receiving yards');
});

test('with no ceilings, the house rules say so and the slip shows the full return', () => {
  const none = { max_stake_straight: null, max_stake_parlay: null, max_payout: null, parlay_max_price: null, leg_max_price: null,
    parlay_max_legs: null, max_open: null };
  const { html, ctx } = page({ view: 'rules', rules: none });
  assert.match(html, /Bet as much of your bankroll as you like/);
  assert.match(html, /no cap on what a ticket can pay/);
  assert.match(html, /no cap on the odds/);
  assert.doesNotMatch(html, /open tickets at a time/);
  const legs = Array.from({ length: 20 }, (_, i) => ({ id: 'x' + i, event: 'e' + i, sport: 'nfl', price: 2, state: 'pre', status: 'open',
    commence_at: FUT, label: 'X' }));
  const rules = { min_stake: 1, parlay_min_legs: 2, leg_min_price: 1.2, ...none };
  assert.equal(ctx.csCheck(legs, 100, 5, rules, 'parlay').length, 0, 'twenty legs, $100, no ceiling');   // vm arrays: compare by length
  assert.equal(ctx.csTicketPrice(legs, rules).price, 1048576);
  // the shared module agrees
  assert.deepEqual(checkSlip({ legs, stake: 100, voter: 5, rules, mode: 'parlay' }), []);
  assert.equal(ticketPrice(legs, () => null, rules).price, 1048576);
});
