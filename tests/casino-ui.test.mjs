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

/* `sport` is the board's section (NFL unless a test says otherwise); `cat`
   opens a game's props drawer on one kind of prop; `cfb` stands in for cfb.json. */
function page({ voter = 5, slip = [], bets = [], banks = [], rules = {}, props = null, view = 'board', games = [], roster = null, feed = null,
  sport = 'nfl', lines = LINES, cat = null, cfb = null } = {}) {
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
    CS.lines = ${JSON.stringify(lines)}.map(csNum); csIndex(CS.lines); CS.sport = ${JSON.stringify(sport)};
    ${cat ? `CS.propCat[${JSON.stringify(cat[0])}] = ${JSON.stringify(cat[1])};` : ''}${cfb ? ` CS.cfb = ${JSON.stringify(cfb)};` : ''}
    CS.slip = ${JSON.stringify(slip)}; CS.bets = ${JSON.stringify(bets)}; CS.banks = ${JSON.stringify(banks)};
    CS.view = ${JSON.stringify(view)}; CS.games = Object.fromEntries(${JSON.stringify(games)}.map(g => [g.event, g]));
    CS.roster = ${JSON.stringify(roster)};${feed ? ` CS.feed = ${JSON.stringify(feed)};` : ''}
    this.CS = CS; this.csCheck = csCheck; this.renderCasino = renderCasino; this.csSel = csSel;
    this.csTicketPrice = csTicketPrice; this.csSimBytes = csSimBytes; this.csTicket = csTicket;`, ctx);
  ctx.renderCasino();
  return { html: main.innerHTML, ctx };
}

const drawn = o => page(o);

test('the board shows every market, and the slip reflects what is selected', () => {
  const { html } = page({ slip: ['nfl:1:spread:away'] });
  for (const l of LINES.filter(l => l.sport === 'nfl')) assert.ok(html.includes(`data-line="${l.id}"`), `${l.id} has a button`);
  // one section at a time: the WCXC tab has the matchups, and the NFL tab doesn't repeat them
  const wcxc = page({ sport: 'wcxc' }).html;
  for (const l of LINES.filter(l => l.sport === 'fantasy')) assert.ok(wcxc.includes(`data-line="${l.id}"`), `${l.id} has a button`);
  assert.doesNotMatch(html, /data-line="fan:/);
  assert.match(html, /data-cssport="nfl" aria-selected="true">NFL <i>1<\/i>/, 'the tab says how many games it holds');
  assert.match(html, /data-line="nfl:1:spread:away" aria-pressed="true"/);
  assert.match(html, /TB \+9\.5/, 'the slip names the selection with its point');
  assert.match(html, /Bet slip \(1\)/);
  assert.match(html, /NFL · Week 5/);
});

test('your own matchup: the opponent and the under are disabled, and the page says why', () => {
  const page = o => drawn({ sport: 'wcxc', ...o });
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
  // one kind of prop at a time, touchdown scorers first: every market for every player ran to 7,000px on a phone
  assert.match(html, /data-cspcat="nfl:1\|td" aria-pressed="true">TD scorers/);
  assert.match(html, /data-cspcat="nfl:1\|rec" aria-pressed="false">Receiving/);
  assert.doesNotMatch(html, /data-cspcat="nfl:1\|pass"/, 'no tab for a kind nobody has');
  assert.match(html, /Touchdowns<\/span>.*Anytime.*\+120.*2\+ TDs.*\+600.*Last TD.*\+750/s);
  assert.doesNotMatch(html, />50\+</, 'receiving waits on its own tab');
  const rec = page({ props, cat: ['nfl:1', 'rec'] }).html;
  assert.doesNotMatch(rec, /Touchdowns<\/span>/);
  assert.match(rec, /O 80\.5/);
  assert.ok(rec.indexOf('>50+<') > 0 && rec.indexOf('>50+<') < rec.indexOf('>100+<'), 'a ladder runs low to high');
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

/* A database that hasn't caught up — the table added but PostgREST still
   serving a schema cache from before it — must cost the tab its progress bars,
   not the whole Casino. This happened live: the lines query asks for `live`,
   PostgREST rejected the column, and the tab went down entirely. */
test('a stale schema cache loses the progress bars, not the Casino', () => {
  const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const load = src.slice(src.indexOf('async function loadCasino()'), src.indexOf('const csPropsQuery'));

  assert.match(load, /const lineErr = lines\.error \|\| cfbLines\.error/, 'either read can be the one that trips');
  assert.match(load, /csCols\s*===\s*CS_LINE\s*&&\s*csNoColumn\(lineErr\)/,
    'it notices the column — specifically the column — is the problem');
  assert.match(load, /csCols\s*=\s*CS_BASE/, 'and reads again without it');
  // the retry must not be in the error check, or the fallback never runs
  const bad = load.slice(load.indexOf('const bad ='));
  assert.ok(load.indexOf('csCols = CS_BASE') < load.indexOf('const bad ='),
    'the retry happens before the query is judged to have failed');

  // the base list is the full one minus exactly the display column
  const base = src.match(/const CS_BASE = "([^"]+)"/)[1].split(',');
  assert.ok(!base.includes('live') && !base.includes('jersey'), 'the fallback asks for no display column');
  for (const c of ['id', 'price', 'point', 'status', 'state', 'commence_at', 'outcome'.replace('outcome', 'score')])
    assert.ok(base.includes(c), `${c} is still read — it decides money`);
  assert.match(src, /const CS_LINE = CS_BASE \+ ",live,jersey"/, 'and the full list is the base plus them');
});

/* The old version of this test only grepped the source for both message strings
   and asserted their order — which passed while the branch it checked for could
   not be reached, because a missing TABLE also says "schema cache". So run the
   real predicates against the payloads PostgREST and Postgres actually send. */
test('a missing table and a missing column are told apart, and get opposite advice', () => {
  const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const defs = src.slice(src.indexOf('const csMsg ='), src.indexOf('const CS_GAME'));
  const ctx = vm.createContext({});
  vm.runInContext(`${defs}\nthis.csNoTable = csNoTable; this.csNoColumn = csNoColumn;`, ctx);

  const cases = [
    ['table missing, via PostgREST', { code: 'PGRST205', message: "Could not find the table 'public.casino_lines' in the schema cache" }, 'table'],
    ['table dropped, via Postgres',  { code: '42P01', message: 'relation "public.casino_lines" does not exist' }, 'table'],
    ['column missing, via Postgres', { code: '42703', message: 'column casino_lines.live does not exist' }, 'column'],
    ['column missing, via PostgREST',{ code: 'PGRST204', message: "Could not find the 'live' column of 'casino_lines' in the schema cache" }, 'column'],
    ['jersey missing, via Postgres', { code: '42703', message: 'column casino_lines.jersey does not exist' }, 'column'],
    ['an unrelated failure',         { message: 'Failed to fetch' }, 'neither'],
  ];
  for (const [name, err, want] of cases) {
    const got = ctx.csNoTable(err) ? 'table' : ctx.csNoColumn(err) ? 'column' : 'neither';
    assert.equal(got, want, name);
  }

  // and the handler must lead with the table case, since that one needs the setup script
  const handler = src.slice(src.indexOf('CS.err = csNoTable(e)'), src.indexOf('CS.loading = false'));
  assert.match(handler, /isn't switched on yet/);
  assert.match(handler, /hasn't caught up/);
  assert.ok(handler.indexOf("isn't switched on") < handler.indexOf("hasn't caught up"),
    'a missing table is diagnosed first — it is the one that needs action');
  // a missing table must NOT make the page stop asking for the column
  assert.match(src, /csCols===CS_LINE && csNoColumn\(lineErr\)/,
    'only a missing column drops the column');
});

/* A failed fetch used to clear both halves of loadTrades' own guard, so
   renderTrades called it straight back: ~200 requests in three seconds for as
   long as the tab was open. loadOdds has always latched a terminal flag. */
test('a failed trade-archive load gives up instead of refetching forever', async () => {
  const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = src.slice(src.indexOf('async function loadTrades()'), src.indexOf('const trName ='));
  let fetches = 0, renders = 0;
  const ctx = vm.createContext({ Promise, Object, Number, String, JSON,
    TRADES: null, tradesLoading: false, tradesLoaded: false,
    S: { tab: 'trades' }, main: { innerHTML: '' }, banner: () => '', header: () => '', T: {},
    bump: () => { renders++ },
    fetch: async () => { if (++fetches > 20) throw new Error('runaway'); return { ok: false }; } });
  vm.runInContext(`${code}
    function renderTrades(){ if(!TRADES){ loadTrades(); bump(); return } bump(); }
    this.renderTrades = renderTrades;`, ctx);
  ctx.renderTrades();
  await new Promise(r => setTimeout(r, 150));
  assert.ok(fetches <= 2, `it stops asking — ${fetches} fetches`);
  assert.ok(renders <= 3, `and stops redrawing — ${renders} renders`);
  // and it says so, rather than claiming to still be loading
  assert.match(src.slice(src.indexOf('function renderTrades()'), src.indexOf('function renderTrades()') + 900),
    /tradesLoaded[\s\S]*couldn't be loaded/, 'the panel admits the archive failed');
});

/* ================= how it looks: the gap, the logos, and a player on his own jersey ================= */
const stylesheet = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const positions = JSON.parse(readFileSync(new URL('../positions.json', import.meta.url), 'utf8'));
const asArray = x => Array.from(x);      // vm arrays and objects are another realm's: compare their contents

test('the stat tiles and the view switcher under them are kept apart, on a desktop and on a phone', () => {
  const gaps = [...stylesheet.matchAll(/main\[data-tab="casino"\] \.tiles\{margin-bottom:(\d+)px\}/g)].map(m => +m[1]);
  assert.ok(gaps.length >= 2, 'one rule for the page and one inside the phone breakpoint');
  assert.ok(gaps.every(g => g >= 12), `the switcher used to sit flush (0px) against the tiles; got ${gaps}`);
  // and the switcher is drawn after them in its own bar, which also carries the sync status
  const { html: casino } = page();
  assert.ok(casino.indexOf('class="tiles"') < casino.indexOf('class="csbar"'));
  assert.match(casino, /class="csbar"><div class="seg"/);
});

test('NFL logos are big enough to read, and are the set ESPN draws for a dark page', () => {
  // the sizes the page and a phone ask for: 30px was a speck
  // (a college card's own narrow size, .csgame.cfb, is a squeeze rule like the ones below, not the page's size)
  const sizes = [...stylesheet.matchAll(/(?<!\.csgame |\.cfb )\.csteam \.lg\{width:(\d+)px;height:(\d+)px/g)].map(m => [+m[1], +m[2]]);
  assert.ok(sizes.length >= 2, 'a size for the page and a smaller one for phones');
  assert.ok(sizes.every(([w, h]) => w === h && w >= 38), `got ${JSON.stringify(sizes)}`);
  assert.ok(Math.max(...sizes.map(s => s[0])) >= 44, 'the desktop size');
  // a game short of room (a 320px phone) may shrink the logo, but never below what it was before
  const squeezed = [...stylesheet.matchAll(/\.csgame \.csteam \.lg\{width:(\d+)px;height:(\d+)px/g)].map(m => [+m[1], +m[2]]);
  assert.ok(squeezed.length >= 1 && squeezed.every(([w, h]) => w === h && w >= 30), `got ${JSON.stringify(squeezed)}`);
  const { ctx } = page();
  assert.equal(vm.runInContext('csLogo("TB")', ctx), 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/tb.png');
  assert.equal(vm.runInContext('csLogo("WSH")', ctx), 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/wsh.png');
  const { html: board } = page();
  assert.match(board, /<img class="lg" alt="" src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500-dark\/tb\.png">/, 'the board draws the dark set');
  assert.doesNotMatch(board, /teamlogos\/nfl\/500\//, 'and none of the light one, which loses the Rams, Giants and Jets on this page');
  // the CSP already allows that host; the dark set is on it
  const csp = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  assert.match(csp, /img-src[^;]*https:\/\/a\.espncdn\.com/);
});

test('every team has jersey colours, in the right family, with numerals that can be read', () => {
  const { ctx } = page();
  const teams = [...new Set(Object.values(positions.teams))];
  assert.equal(teams.length, 32);
  // written down independently of the table, so a typo in a hex digit cannot slip through as "a colour"
  const FAMILY = { ARI: 'red', ATL: 'red', BAL: 'purple', BUF: 'blue', CAR: 'black', CHI: 'blue', CIN: 'orange', CLE: 'brown',
    DAL: 'blue', DEN: 'orange', DET: 'blue', GB: 'green', HOU: 'blue', IND: 'blue', JAX: 'teal', KC: 'red', LV: 'black', LAC: 'blue',
    LAR: 'blue', MIA: 'teal', MIN: 'purple', NE: 'blue', NO: 'black', NYG: 'blue', NYJ: 'green', PHI: 'teal', PIT: 'black', SF: 'red',
    SEA: 'blue', TB: 'red', TEN: 'blue', WAS: 'red' };
  const family = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (d < .07 || l < .05) return 'black';      // Carolina, New Orleans and Pittsburgh's near-black sit at .06; Green Bay's dark green at .09
    let h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    if (h < 12 || h >= 330) return 'red';
    if (h < 40) return l < .2 ? 'brown' : 'orange';
    if (h < 70) return 'gold';
    if (h < 170) return 'green';
    if (h < 200) return 'teal';
    if (h < 240) return 'blue';
    return 'purple';
  };
  for (const t of teams) {
    const c = ctx.csJerseyColors ? ctx.csJerseyColors(t) : vm.runInContext(`csJerseyColors(${JSON.stringify(t)})`, ctx);
    assert.match(c.body, /^#[0-9a-f]{6}$/i, `${t} body`);
    assert.match(c.trim, /^#[0-9a-f]{6}$/i, `${t} trim`);
    assert.notEqual(c.body.toLowerCase(), '#4b5560', `${t} fell back to the neutral jersey`);
    assert.equal(family(c.body), FAMILY[t], `${t}'s jersey is ${family(c.body)}, should be ${FAMILY[t]}`);
    const ratio = vm.runInContext(`csContrast(${JSON.stringify(c.ink)}, ${JSON.stringify(c.body)})`, ctx);
    assert.ok(ratio >= 3, `${t}: numerals ${c.ink} on ${c.body} are only ${ratio.toFixed(2)}:1`);
  }
  // the two teams whose mark is gold but whose jersey is black wear gold numerals
  for (const t of ['PIT', 'NO']) {
    const c = vm.runInContext(`csJerseyColors("${t}")`, ctx);
    assert.equal(family(c.body), 'black', `${t} is a black jersey`);
    assert.notEqual(c.ink, '#ffffff', `${t} numerals are gold`);
  }
  // ESPN says WSH, Sleeper says WAS; both are Washington, and neither is unknown
  assert.equal(vm.runInContext('csJerseyColors("WSH").body', ctx), vm.runInContext('csJerseyColors("WAS").body', ctx));
  assert.equal(vm.runInContext('csJerseyColors("ZZZ").body', ctx), '#4b5560', 'a team nobody knows gets a neutral jersey, not an error');
});

test('a jersey carries the number it is given, zero included, and never makes one up', () => {
  const { ctx } = page();
  const J = (team, n) => vm.runInContext(`csJersey(${JSON.stringify(team)}, ${n === undefined ? 'null' : n}, 44)`, ctx);
  assert.match(J('PHI', 1), /<text class="jn"[^>]*>1<\/text>/);
  assert.match(J('DAL', 88), /<text class="jn"[^>]*>88<\/text>/);
  assert.match(J('DET', 0), /<text class="jn"[^>]*>0<\/text>/, 'zero is a real number (Gibbs, Ridley, Coleman and nine others wear it)');
  assert.match(J('DET', 0), /aria-label="DET #0 jersey"/);
  assert.doesNotMatch(J('DET', undefined), /<text/, 'no number on file: a jersey with no digits, never a guessed one');
  assert.match(J('DET', undefined), /aria-label="DET jersey"/);
  assert.match(J('WSH', 4), /aria-label="WAS #4 jersey"/);
  assert.equal(vm.runInContext('csNumber("nobody")', ctx), null);
  // digits are read from the roster the page loaded, by Sleeper id
  vm.runInContext('CS.roster = {positions:{"6786":"WR"}, numbers:{"6786":88, "9221":0}}', ctx);
  assert.equal(vm.runInContext('csNumber("6786")', ctx), 88);
  assert.equal(vm.runInContext('csNumber("9221")', ctx), 0);
  assert.equal(vm.runInContext('csNumber("1")', ctx), null);
});

const lamb = (id, market, side, point, american, extra = {}) => ({ id: `prop:1:s6786:${id}`, season: 2026, week: 5, event: 'nfl:1',
  sport: 'prop', market, side, label: 'CeeDee Lamb', event_label: 'TB @ DAL', point, american,
  price: american > 0 ? 1 + american / 100 : 1 + 100 / -american, team: null, teams: null, player: '6786', nfl_team: 'DAL',
  commence_at: FUT, state: 'pre', score: '', status: 'open', ...extra });

test("a player's props are drawn on his own jersey: his team's colours, his number off the roster, his team and position", () => {
  const props = [lamb('rec_yd:over', 'rec_yd', 'over', 80.5, -114), lamb('rec_yd:under', 'rec_yd', 'under', 80.5, -114), lamb('atd:yes', 'atd', 'yes', null, 120)];
  const roster = { positions: { 6786: 'WR' }, numbers: { 6786: 88 } };
  const { html: drawer } = page({ props, roster });
  assert.match(drawer, /<p class="csplayer"><span class="jsw"><svg class="jsy"[^>]*aria-label="DAL #88 jersey"/);
  assert.match(drawer, /<text class="jn"[^>]*>88<\/text>/);
  assert.match(drawer, /<span class="who"><b>CeeDee Lamb<\/b><i>DAL · WR<\/i><\/span>/);
  assert.match(drawer, /fill="#041E42"/, "Dallas's own jersey colour");
  // no roster yet (it is a second fetch): the same jersey, no digits, and the page does not break
  const early = page({ props, roster: null }).html;
  assert.match(early, /aria-label="DAL jersey"/);
  assert.doesNotMatch(early, /<text class="jn"/);
  assert.match(early, /<span class="who"><b>CeeDee Lamb<\/b><i>DAL<\/i><\/span>/, 'position is simply left off');
});

test('the slip and a ticket show each leg\'s art: a jersey for a prop, a logo for a game, an avatar for a WCXC matchup', () => {
  const props = [lamb('rec_yd:over', 'rec_yd', 'over', 80.5, -114)];
  const roster = { positions: { 6786: 'WR' }, numbers: { 6786: 88 } };
  const slip = page({ props, roster, slip: ['prop:1:s6786:rec_yd:over', 'nfl:1:ml:home', 'fan:2026:5:3:ml:5'] }).html;
  const legs = slip.slice(slip.indexOf('id="csslip"')).split('class="slipleg"').slice(1);
  assert.equal(legs.length, 3);
  assert.match(legs[0], /^>?<span class="tkart sm"><svg class="jsy"[^>]*aria-label="DAL #88 jersey"/, 'a prop is a jersey');
  assert.match(legs[1], /<span class="tkart sm"><img alt="" src="[^"]*500-dark\/dal\.png">/, 'a game price is the team logo');
  assert.match(legs[2], /<span class="tkart sm"><img data-av="5">/, 'a WCXC matchup is the team avatar');

  const bets = [{ id: 9, voter: 5, kind: 'straight', stake: '5.00', price: '1.8772', status: 'open', payout: null, placed_at: '2026-10-08T20:00:00Z',
    bet_legs: [{ line_id: 'prop:1:s6786:rec_yd:over', price: '1.8772', point: '80.5', result: null, event: 'nfl:1' }] }];
  const ticket = page({ view: 'bets', props, roster, bets }).html;
  assert.match(ticket, /<span class="tkart"><svg class="jsy"[^>]*aria-label="DAL #88 jersey"/, 'on a ticket too, at the larger size');
  assert.match(ticket, /width="46" height="46"/);
});

test('the scoreboard on a ticket draws logos from the same set, big enough to tell apart', () => {
  const games = [{ event: 'nfl:1', sport: 'nfl', season: 2026, week: 5, commence_at: FUT, state: 'in', detail: 'Q2 4:10', situation: '',
    possession: 'home', away: 'TB', home: 'DAL', away_score: '7', home_score: '10', away_periods: [7, 0], home_periods: [3, 7] }];
  const bets = [{ id: 2, voter: 5, kind: 'straight', stake: '5.00', price: '4.6', status: 'open', payout: null, placed_at: '2026-10-08T20:00:00Z',
    bet_legs: [{ line_id: 'nfl:1:ml:away', price: '4.6', point: null, result: null, event: 'nfl:1' }] }];
  const { html: box } = page({ view: 'bets', bets, games });
  assert.match(box, /<span class="bxlg"><img alt="" src="[^"]*500-dark\/tb\.png"><\/span><span class="bxnm">TB<\/span>/);
  const bx = [...stylesheet.matchAll(/\.bxlg img\{width:(\d+)px/g)].map(m => +m[1]);
  assert.ok(bx.length && bx.every(w => w >= 32), `scoreboard logos were 28px; got ${bx}`);
});

test('on a phone the slip shortcut clears the tab bar, and its text can be read on the casino green', () => {
  // where the tab bar exists (860px and below) the shortcut rides above it; it used to sit at 14px, entirely behind
  const lift = stylesheet.split('.csfab{bottom:calc(').slice(1).map(r => parseInt(r, 10));
  assert.ok(lift.length === 1 && lift[0] >= 70, `the bar is 64px tall (plus the home-indicator inset it pads for), got ${lift}`);
  assert.ok(stylesheet.indexOf('.csfab{bottom:calc(') > stylesheet.indexOf('@media (max-width:860px)'), 'inside the rule for the tab bar');
  // the accent is green on this tab; text on it must be the accent's own ink, as the price buttons use
  const root = n => stylesheet.match(new RegExp(`--${n}:(#[0-9a-fA-F]{6})`))[1];
  const green = root('green'), ink = root('green-ink');
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  assert.ok(ratio(ink, green) >= 4.5, 'the accent ink on the accent');
  assert.ok(ratio('#ffffff', green) < 3, 'white on this green cannot be read, which is why neither may use it');
  assert.match(stylesheet, /\.csfab\{[^}]*\n?[^}]*background:var\(--acc\);color:var\(--acc-ink\)/);
  assert.doesNotMatch(stylesheet, /\.odd\[aria-pressed="true"\] small\{color:#fff/, 'a pressed price\'s label is in the same ink as its price');
});

test('a single bet\'s summary line says which game it is on instead of repeating its own title', () => {
  const straight = (line_id, extra = {}) => [{ id: 5, voter: 5, kind: 'straight', stake: '10.00', price: '1.9091', status: 'open', payout: null,
    placed_at: '2026-10-08T20:00:00Z', bet_legs: [{ line_id, price: '1.9091', point: '47.5', result: null, event: 'nfl:1' }], ...extra }];
  const nflTkt = page({ view: 'bets', bets: straight('nfl:1:total:over') }).html;
  assert.match(nflTkt, /<b class="tkttl">Over 47\.5<\/b>/);
  assert.match(nflTkt, /<div class="tksum">TB @ DAL<\/div>/, 'the game');
  const wcxc = page({ view: 'bets', bets: straight('fan:2026:5:3:ml:5', { bet_legs: [{ line_id: 'fan:2026:5:3:ml:5', price: '1.6667', point: null, result: null, event: 'fan:2026:5:3' }] }) }).html;
  assert.match(wcxc, /<div class="tksum">T5 vs T6<\/div>/, 'the matchup, by the names the league uses');
  // a parlay still lists its selections
  const parlay = page({ view: 'bets', bets: [{ ...straight('nfl:1:total:over')[0], kind: 'parlay', bet_legs: [
    { line_id: 'nfl:1:total:over', price: '1.9091', point: '47.5', result: null, event: 'nfl:1' }, { line_id: 'nfl:1:ml:away', price: '4.6', point: null, result: null, event: 'nfl:1' }] }] }).html;
  assert.match(parlay, /<div class="tksum">Over 47\.5, TB ML<\/div>/);
  // and a line the board no longer lists falls back to the selection rather than to nothing
  const gone = page({ view: 'bets', bets: straight('nfl:99:ml:home') }).html;
  assert.match(gone, /<div class="tksum">A line no longer listed<\/div>/);
});

test('team text from the database can never pick up an inherited property or break out of an attribute', () => {
  const { ctx } = page();
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const c = vm.runInContext(`csJerseyColors(${JSON.stringify(bad)})`, ctx);
    assert.equal(c.body, '#4b5560', `${bad} is not a team: the neutral jersey, no exception`);
    assert.doesNotThrow(() => vm.runInContext(`csJersey(${JSON.stringify(bad)}, 5, 40)`, ctx));
  }
  const url = vm.runInContext('csLogo(\'x" onerror="alert(1)\')', ctx);
  assert.doesNotMatch(url, /["<> ]/, 'a quote or a space cannot end the src attribute');
  assert.equal(vm.runInContext('csLogo("TB")', ctx), 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/tb.png', 'real abbreviations are unchanged');
});

test('nothing pinned to the bottom of a phone sits behind the tab bar', () => {
  // on a phone the tab bar is fixed along the bottom: 66px tall, plus the home-indicator inset it pads for
  const bodies = sel => stylesheet.split(sel + '{').slice(1).map(r => r.slice(0, r.indexOf('}')));
  const bottoms = sel => bodies(sel).map(b => (b.match(/bottom:calc\((\d+)px/) || [])[1]).filter(Boolean).map(Number);
  assert.ok(bottoms('.csfab').some(n => n >= 66), 'the floating slip shortcut, which sat at 14px: entirely behind the bar');
  assert.ok(bottoms('.actions.stick').some(n => n >= 66), "the Vote tab's Submit bar, which was half behind it");
});

test('the board stacks above the slip until there is room for both, and a game sizes its logos by the room it has', () => {
  /* The 240px side rail and the 330px slip left the board about 240px in a half-width window: team names cut to
     "Pha…", records wrapping, three prices squeezed to 43px each. Two columns need ~420px for the board, so from
     1080px up. */
  /* and stacked, the one column must be able to shrink (minmax(0,…)): a bare 1fr is as wide as its widest
     content, and the strip of games to jump to (sixty college games in one scrolling row) pushed the whole
     page sideways on a phone, taking the price buttons off the edge of the screen */
  const stack = stylesheet.match(/@media \(max-width:(\d+)px\)\{\s*\.csgrid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(stylesheet, /\.csgrid>\*\{min-width:0\}/);
  assert.ok(stack, 'a rule that stacks the slip under the board');
  assert.ok(+stack[1] >= 1000 && +stack[1] <= 1100, `stacks below ${stack[1]}px`);
  assert.match(stylesheet, /\.csslip\{position:static/, 'and the slip stops being sticky when it is below');
  // the slip shortcut is needed whenever the slip is below the board, not only on a phone
  assert.ok(bodiesOf('.csfab').some(b => /display:flex;position:fixed/.test(b)), 'the shortcut appears with the stacked layout');
  // the logo gives way before the team's abbreviation does, whatever the viewport: measured on the board's own width
  assert.match(stylesheet, /\.csgame\{container-type:inline-size\}/);
  const cq = [...stylesheet.matchAll(/@container \(max-width:(\d+)px\)\{([^@]*?)\}\s*(?=@|\n|$)/g)];
  assert.ok(cq.length >= 3, 'container rules for a narrow board');
  assert.match(stylesheet, /@container \(max-width:299px\)\{ \.csgame \.csteam \.lg\{width:30px;height:30px\} \}/);
  // they must beat the phone rules whatever the order they sit in, so they are written with the extra class
  for (const [, , body] of cq) assert.doesNotMatch(body.replace(/\.csgame(\.cfb)? \.csteam/g, ''), /(^|[ {,])\.csteam /, 'every selector inside carries .csgame');
});
function bodiesOf(sel) { return stylesheet.split(sel + '{').slice(1).map(r => r.slice(0, r.indexOf('}'))); }

test('a team with no abbreviation gets a blank where its logo goes, not a request for a logo that does not exist', () => {
  const { ctx } = page();
  assert.equal(vm.runInContext('csLogoImg("", "lg")', ctx), '<span class="lg"></span>');
  assert.equal(vm.runInContext('csLogoImg("TB", "lg")', ctx), '<img class="lg" alt="" src="https://a.espncdn.com/i/teamlogos/nfl/500-dark/tb.png">');
  assert.equal(vm.runInContext('csLogoImg("TB")', ctx), '<img alt="" src="https://a.espncdn.com/i/teamlogos/nfl/500-dark/tb.png">');
  // a scoreboard row with no abbreviations (a game ESPN has not named yet) asks for nothing
  const games = [{ event: 'nfl:1', sport: 'nfl', season: 2026, week: 5, commence_at: FUT, state: 'pre', detail: '', situation: '', possession: null, away: '', home: '',
    away_score: null, home_score: null, away_periods: null, home_periods: null }];
  const bets = [{ id: 2, voter: 5, kind: 'straight', stake: '5.00', price: '4.6', status: 'open', payout: null, placed_at: '2026-10-08T20:00:00Z',
    bet_legs: [{ line_id: 'nfl:1:ml:away', price: '4.6', point: null, result: null, event: 'nfl:1' }] }];
  assert.doesNotMatch(page({ view: 'bets', bets, games }).html, /500-dark\/\.png/);
});

/* ================= finding a bet: sections, search, futures, college ================= */
import { wcxcFutureLines, nflFutureLines } from '../supabase/functions/_shared/casino.mjs';

const fixture = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const rerender = (ctx, js) => { vm.runInContext(`${js}; renderCasino();`, ctx); return ctx.main.innerHTML; };

test('search finds a game by nickname, city or abbreviation, and a player search keeps the games he is in', () => {
  const second = LINES.filter(l => l.event === 'nfl:1').map(l => ({ ...l, id: l.id.replace('nfl:1:', 'nfl:2:'), event: 'nfl:2', event_label: 'CAR @ PHI',
    label: l.label === 'TB' ? 'CAR' : l.label === 'DAL' ? 'PHI' : l.label, commence_at: '2099-10-12T17:00:00Z' }));
  const { html, ctx } = page({ lines: [...LINES, ...second] });
  // every game in a strip at the top, to jump straight to one
  assert.match(html, /<div class="csjump"[^>]*>.*data-csjump="nfl:1".*data-csjump="nfl:2"/s);
  assert.match(html, /id="g-nfl:1"/, 'a game card is the jump target');
  for (const q of ['cowboys', 'Dallas', 'dal', 'buccaneers']) {
    const out = rerender(ctx, `CS.q = ${JSON.stringify(q)}`);
    assert.match(out, /id="g-nfl:1"/, `"${q}" finds TB @ DAL`);
    assert.doesNotMatch(out, /id="g-nfl:2"/, `and only that game for "${q}"`);
  }
  assert.match(rerender(ctx, 'CS.q = "eagles"'), /id="g-nfl:2"/);
  assert.match(rerender(ctx, 'CS.q = "zzz"'), /No games match “zzz”/);
  // a player's name matches no team, so the games his props are in stay
  const found = rerender(ctx, `CS.q = "lamb"; CS.found = {q:"lamb", list:[{event:"nfl:1", player:"6786", label:"CeeDee Lamb", nfl_team:"DAL", sport:"prop", n:7, game:"TB @ DAL", jersey:null}]}`);
  assert.match(found, /data-csfind="nfl:1\|6786">.*CeeDee Lamb.*TB @ DAL · 7 props/s);
  assert.match(found, /id="g-nfl:1"/);
  assert.doesNotMatch(found, /id="g-nfl:2"/);
  // a stale result (for an older query) is not shown
  assert.doesNotMatch(rerender(ctx, 'CS.q = "lambs"'), /data-csfind/);
});

// WCXC from a forecast shaped like odds.json; the NFL from FanDuel's real futures
const futBoard = () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: [0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.03, 0.02, 0.006, 0.003, 0][i],
    po: [0.99, 0.95, 0.9, 0.75, 0.6, 0.55, 0.5, 0.3, 0.2, 0.15, 0.08, 0.03][i], div: [0.8, 0.6, 0.55, 0.15, 0.3, 0.3, 0.05, 0.1, 0.15, 0.0, 0.0, 0.0][i] }));
  const divisions = Object.fromEntries(rows.map(r => [r.id, ((r.id - 1) % 3) + 1]));
  const w = wcxcFutureLines({ modelVersion: 3, rows }, { season: 2026, week: 6, commence: FUT, hold: 0.05, divisions,
    divNames: { 1: 'Uher’s Most Hated', 2: 'Loughman’s Fog', 3: 'Ali’s Children' } });
  const n = nflFutureLines(fixture('fanduel-nfl-futures.json').attachments.markets, { season: 2026, week: 6, commence: FUT });
  return [...w, ...n].map(l => ({ ...l, status: 'open' }));
};

test('the Futures tab: the WCXC title, playoffs and divisions, and the NFL\'s Super Bowl and playoffs', () => {
  const lines = futBoard();
  const { html, ctx } = page({ sport: 'fut', lines, voter: 9 });
  assert.match(html, /data-cssport="fut" aria-selected="true">Futures <i>5<\/i>/, 'five markets: title, playoffs and divisions; Super Bowl and playoffs');
  assert.match(html, /<h2>WCXC · 2026 season<\/h2>/);
  // the title race, shortest price first, and team 12 (no chance at all) nowhere in it
  const champ = html.slice(html.indexOf('<h3>Champion</h3>'), html.indexOf('<h3>Make the playoffs</h3>'));
  const order = [...champ.matchAll(/data-line="fut:wcxc:2026:title:(\d+)"/g)].map(m => +m[1]);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(champ, /Teams not listed are out of the running/);
  assert.match(html, /<p class="csfdiv">Uher’s Most Hated<\/p>/);
  assert.match(html, /<div class="csfrow head"><span><\/span><span>Yes<\/span><span>No<\/span><\/div>/);
  // likeliest first: team 1 (99%) has no "yes" on offer at all, and still leads the list
  const playoffs = html.slice(html.indexOf('<h3>Make the playoffs</h3>'), html.indexOf('<h3>Division winners</h3>'));
  assert.deepEqual([...playoffs.matchAll(/data-line="fut:wcxc:2026:po:(\d+):no"/g)].map(m => +m[1]).slice(0, 3), [1, 2, 3]);
  // the NFL: twelve Super Bowl prices, then the rest on request
  assert.match(html, /<h3>Super Bowl LXI<\/h3>/);
  const sb = () => (ctx.main.innerHTML.match(/data-line="fut:nfl:2026:sb:/g) || []).length;
  assert.equal(sb(), 12);
  assert.match(html, /data-csfutall="sb">Show all 32/);
  rerender(ctx, 'CS.futAll.sb = true');
  assert.equal(sb(), 32);
  assert.match(html, /<p class="csfdiv">AFC<\/p>/);
  // what a future says on a slip and a ticket
  const sel = id => ctx.csSel(ctx.CS.byId[id]);
  assert.equal(sel('fut:wcxc:2026:title:3'), 'T3 to win the title');
  assert.equal(sel('fut:wcxc:2026:po:3:no'), 'T3 to miss the playoffs');
  assert.equal(sel('fut:wcxc:2026:div:1:4'), 'T4 to win Uher’s Most Hated');
  assert.equal(sel('fut:nfl:2026:sb:PHI'), 'Philadelphia Eagles to win Super Bowl LXI');
  assert.equal(sel('fut:nfl:2026:nflpo:WSH:yes'), 'Washington Commanders to make the playoffs');
  assert.equal(vm.runInContext('csEvent(CS.byId["fut:wcxc:2026:title:3"])', ctx), 'WCXC · 2026 champion');
});

test('your own team in a WCXC future: never to miss, and in a race it is still in, the only one you can back', () => {
  const lines = futBoard();
  const on = { block_self_bets: true, leg_min_price: null, leg_max_price: null };   // no price limits in the way of the rule under test
  const { html } = page({ sport: 'fut', lines, voter: 3, rules: on });
  const btn = id => html.match(new RegExp(`<button[^>]*data-line="${id}"[^>]*>`))[0];
  assert.match(btn('fut:wcxc:2026:po:3:no'), /disabled/);
  assert.doesNotMatch(btn('fut:wcxc:2026:po:3:yes'), /disabled/);
  assert.doesNotMatch(btn('fut:wcxc:2026:title:3'), /disabled/);
  assert.match(btn('fut:wcxc:2026:title:1'), /disabled/);
  assert.match(btn('fut:wcxc:2026:title:1'), /title="Your team is still in this race/);
  assert.doesNotMatch(btn('fut:wcxc:2026:div:1:1'), /disabled/, 'another division is fair game');
  assert.doesNotMatch(btn('fut:wcxc:2026:po:1:no'), /disabled/, 'and so is a rival missing the playoffs');
  assert.doesNotMatch(btn('fut:nfl:2026:sb:LAR'), /disabled/, 'an NFL future is nobody\'s own team (the Rams lead the list)');
  assert.match(html, /Your own team: you can back it/, 'said in words, for a phone with no hover');
  // team 12 has no title line: out of the running, it may back anyone
  assert.doesNotMatch(page({ sport: 'fut', lines, voter: 12, rules: on }).html.match(/<button[^>]*data-line="fut:wcxc:2026:title:1"[^>]*>/)[0], /disabled/);
});

test('with nothing open, the Futures tab says why rather than looking broken', () => {
  const games = page({ sport: 'fut', lines: [], rules: { fut_status: { wcxc: { open: false, why: 'games' }, nfl: { open: false, why: 'games' } } } }).html;
  assert.match(games, /Closed while this week(&#39;|')s games are on\. WCXC futures reopen on Tuesday morning/);
  assert.match(games, /Closed while NFL games are on/);
  assert.match(page({ sport: 'fut', lines: [], rules: { fut_status: { wcxc: { open: false, why: 'season' } } } }).html, /decided for the season/);
});

test("the page's rule check agrees with the shared module on futures and college too", () => {
  const { ctx } = page();
  const rules = { min_stake: 1, parlay_min_legs: 2, block_self_bets: true };
  const L = o => ({ status: 'open', state: 'pre', sport: 'nfl', price: 2, commence_at: FUT, label: 'X', event: 'a', ...o });
  const t3 = L({ sport: 'future', event: 'fut:wcxc:2026:title', market: 'title', team: 3, id: 't3' });
  const t4 = L({ sport: 'future', event: 'fut:wcxc:2026:title', market: 'title', team: 4, id: 't4' });
  const no3 = L({ sport: 'future', event: 'fut:wcxc:2026:po:3', market: 'po', side: 'no', team: 3, id: 'n3' });
  const board = [t3, t4, no3];
  const cases = [
    [[t4], 3, 'parlay'], [[t4], 5, 'parlay'], [[no3], 3, 'parlay'], [[no3], 4, 'parlay'], [[t3], 3, 'parlay'],
    [[t3, L()], 5, 'parlay'], [[t3, L()], 5, 'singles'], [[L({ sport: 'future', commence_at: '2020-01-01T00:00:00Z' })], 5, 'parlay'],
    [[L({ sport: 'cfb', event: 'cfb:1' }), L({ sport: 'cfb', event: 'cfb:1', id: 'b' })], 5, 'parlay'],
    [[L({ sport: 'cfb', event: 'cfb:1' }), L({ sport: 'cprop', event: 'cfb:1', id: 'b' })], 5, 'parlay'],
    [[L({ sport: 'cfb', event: 'cfb:1' }), L()], 5, 'parlay'], [[L({ sport: 'cfb', event: 'cfb:1', state: 'in' })], 5, 'parlay'],
  ];
  for (const [legs, voter, mode] of cases) {
    const mine = checkSlip({ legs, stake: 10, voter, rules, mode, board });
    const pageSays = ctx.csCheck(legs, 10, voter, rules, mode, Date.now(), null, board);
    assert.equal(pageSays.length, mine.length, `same problems for ${JSON.stringify({ legs: legs.map(l => l.id || l.sport), voter, mode })}`);
    // a message that names nothing is word for word the same; ones that name a game name it each in their own way
    for (const m of mine.filter(x => !/^X |That (game|market)/.test(x))) assert.ok(Array.from(pageSays).includes(m), `the page says "${m}" too`);
  }
});

const cfbLines = () => fixture('espn-cfb-scoreboard.json').events
  .flatMap(ev => gameLines(ev, { season: 2026, week: 6, sport: 'cfb' })).map(l => ({ ...l, commence_at: FUT, status: 'open' }));
const CFB = { teams: {
  333: ['ALA', 'Alabama', 'Alabama Crimson Tide', '9e1b32', 'ffffff', '8'], 61: ['UGA', 'Georgia', 'Georgia Bulldogs', 'ba0c2f', '2c2a29', '8'],
  41: ['CONN', 'UConn', 'UConn Huskies', '000e2f', 'ffffff', '18'], 218: ['TEM', 'Temple', 'Temple Owls', '9e1b34', 'a7a9ac', '151'],
  295: ['ODU', 'Old Dominion', 'Old Dominion Monarchs', '003768', '7c878e', '37'], 2026: ['APP', 'App State', 'App State Mountaineers', '000000', 'ffcc00', '37'],
  2534: ['SHSU', 'Sam Houston', 'Sam Houston Bearkats', 'ff6600', 'ffffff', '12'], 2335: ['LIB', 'Liberty', 'Liberty Flames', '0a254e', 'c41230', '12'],
  55: ['JXST', 'Jax State', 'Jacksonville State Gamecocks', 'cc0000', 'ffffff', '12'], 338: ['KENN', 'Kennesaw St', 'Kennesaw State Owls', 'fdbb30', '000000', '12'] },
  ranks: { 61: 2, 333: 6 }, conferences: { 8: 'SEC', 151: 'American', 37: 'Sun Belt', 12: 'CUSA', 18: 'Independents' } };

test('the College tab: the Top 25 first, then any conference or all of FBS, with rankings, logos and props where there are some', () => {
  const { html, ctx } = page({ sport: 'cfb', lines: cfbLines(), cfb: CFB, rules: { cprops_synced: { 401856712: { at: '2026-10-09T12:00:00Z', n: 175 } } } });
  const games = out => [...out.matchAll(/class="csgame cfb" id="g-(cfb:\d+)"/g)].map(m => m[1]);
  assert.deepEqual(games(html), ['cfb:401856712'], 'the Top 25: the only game with a ranked team');
  assert.match(html, /<em class="csrk">2<\/em><b class="nf">Georgia<\/b><b class="na">UGA<\/b>/);
  assert.match(html, /<em class="csrk">6<\/em><b class="nf">Alabama<\/b><b class="na">ALA<\/b>/);
  // a narrow card (a phone) swaps the school for its abbreviation rather than break "Geor-gia" over two lines
  assert.match(stylesheet, /@container \(max-width:479px\)\{ \.csgame \.csteam \.nf\{display:none\} \.csgame \.csteam \.na\{display:inline\} \}/);
  assert.match(html, /src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/ncaa\/500-dark\/333\.png"/, "ESPN's dark-page marks, by team id");
  assert.match(html, /data-csprops="cfb:401856712"/, 'a props button where FanDuel has props');
  const picker = html.slice(html.indexOf('id="cscfb"'), html.indexOf('</select>', html.indexOf('id="cscfb"')));
  const opts = [...picker.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)</g)].map(m => [m[1], m[3], !!m[2]]);
  assert.deepEqual(opts.map(o => o[1]), ['Top 25', 'All FBS', 'American', 'CUSA', 'Independents', 'SEC', 'Sun Belt'], 'conferences on this board, A to Z');
  assert.equal(opts.find(o => o[2])[1], 'Top 25');
  const all = rerender(ctx, 'CS.cfbFilter = "all"');
  assert.equal(games(all).length, 5);
  assert.equal((all.match(/data-csprops=/g) || []).length, 1, 'and none where it has none: most college games never get props');
  assert.deepEqual(games(rerender(ctx, 'CS.cfbFilter = "conf:151"')), ['cfb:401861964'], 'the American: Temple');
  // a conference remembered from another week reads as everything, not as an empty board
  assert.equal(games(rerender(ctx, 'CS.cfbFilter = "conf:999"')).length, 5);
  // before cfb.json arrives the board still works, on the lines' own names
  assert.equal(games(page({ sport: 'cfb', lines: cfbLines() }).html).length, 5);
});

test("a college player is drawn on his school's jersey with the number off ESPN's roster, and never a guessed one", () => {
  const { ctx } = page({ sport: 'cfb', lines: cfbLines(), cfb: CFB });
  const J = (id, n) => vm.runInContext(`csJerseyCfb(${JSON.stringify(id)}, ${JSON.stringify(n)}, 40)`, ctx);
  assert.match(J('333', 1), /fill="#9e1b32"/);
  assert.match(J('333', 1), /<text class="jn"[^>]*fill="#ffffff"[^>]*>1<\/text>/);
  assert.match(J('333', 1), /aria-label="ALA #1 jersey"/);
  assert.match(J('338', 5), /fill="#0b0c0e"[^>]*>5</, "Kennesaw State's gold is too light for white numerals");
  assert.doesNotMatch(J('333', null), /<text/, 'no number on file: no digits');
  assert.doesNotMatch(J('333', 120), /<text/, 'nor an impossible one');
  assert.match(J('999999', 7), /fill="#4b5560"/, 'a school nobody knows gets the neutral jersey');
  // a school's colour from the database can't break out of the attribute it is drawn into
  vm.runInContext(`CS.cfb.teams["777"] = ["X","X","X",'"/><script>',"ffffff","1"]`, ctx);
  assert.match(J('777', 3), /fill="#4b5560"/);
  assert.equal(vm.runInContext('csCfbLogo(\'333" onerror="x\')', ctx), 'https://a.espncdn.com/i/teamlogos/ncaa/500-dark/333.png');
  // and a college prop on a slip carries it
  const prop = { id: 'cprop:401856712:a5141711:rec_yd:over', event: 'cfb:401856712', sport: 'cprop', market: 'rec_yd', side: 'over', point: 64.5,
    price: 1.8772, american: -114, label: 'Ryan Coleman-Williams', player: '5141711', nfl_team: '333', jersey: 1, event_label: 'Georgia @ Alabama',
    commence_at: FUT, state: 'pre', status: 'open', season: 2026, week: 6 };
  const slip = page({ sport: 'cfb', lines: [...cfbLines(), prop], cfb: CFB, slip: [prop.id] }).html;
  assert.match(slip, /<span class="tkart sm"><svg class="jsy"[^>]*aria-label="ALA #1 jersey"/);
  assert.match(slip, /Ryan Coleman-Williams over 64\.5 receiving yards/);
});

test('the casino redraws by patching what is there, so a tap never destroys the button under the finger', () => {
  const src = between('function renderCasino(){', '/* Casino clicks and typing.');
  assert.match(src, /csPaint\(`<div class="csroot">`/, 'the board is drawn through csPaint');
  const paint = between('function csPaint(html){', 'function renderCasino(){');
  assert.match(paint, /classList\.contains\("csroot"\)/, 'it patches only over a casino it drew itself');
  assert.match(paint, /main\.innerHTML = html/, 'arriving from another tab, it writes fresh');
  const node = between('function csMorphNode(x, y){', 'function csPaint(html){');
  assert.match(node, /mine = x===document\.activeElement/);
  assert.match(node, /if\(!mine && was!==now\) x\.value = now/, 'the box being typed in keeps what is in it');
  // the section tabs stay on screen, under the phone's top bar
  assert.match(stylesheet, /\.cssport\{position:sticky;top:0/);
  assert.match(stylesheet, /\.cssport\{top:var\(--tbh/);
  assert.match(stylesheet, /\.csq input\{[^}]*font:500 16px/, 'sixteen pixels, so tapping the search box does not zoom an iPhone');
});
