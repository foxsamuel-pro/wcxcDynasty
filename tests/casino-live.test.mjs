/* Does a score the sync writes actually reach an open page? The Casino page run
   for real in a vm against a stand-in for Supabase: an in-memory database that
   answers the page's own queries (filters, ordering and row limits included),
   realtime channels the test can fire, and timers the test controls. What is
   exercised is the code that ships, sliced out of index.html. */
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
const realtime = between('let csTimer = null;', '/* ---------- tally ---------- */');      // csSoon and subscribe
const casino = between('const CS = { rules:null', '/* ---------- events ---------- */');

const now = Date.now(), iso = ms => new Date(ms).toISOString();
const GAME = 'nfl:7';
const RULES = { id: 1, reward_ballot: '100', min_stake: '1', parlay_min_legs: 2, live_enabled: false, live_delay_sec: 45, live_tolerance: '0.05',
  prop_american: -115, fantasy_hold: '0.045', sgp_hold: '0.15', sgp_min_hits: 20, block_self_bets: true, synced_at: iso(now) };
const line = (id, o = {}) => ({ id, season: 2026, week: 5, event: GAME, sport: 'nfl', market: 'ml', side: 'away', label: 'TB', event_label: 'TB @ DAL',
  point: null, price: 4.5, american: 350, team: null, teams: null, player: null, nfl_team: 'TB', commence_at: iso(now - 3600e3), state: 'in',
  score: '', status: 'closed', updated_at: iso(now), live: null, ...o });
const PROP = line('prop:7:s11584:rush_yd:over', { sport: 'prop', market: 'rush_yd', side: 'over', label: 'Bucky Irving', point: 51.5, price: 1.88, american: -114, player: '11584', live: 22 });
const game = (o = {}) => ({ event: GAME, sport: 'nfl', season: 2026, week: 5, commence_at: iso(now - 3600e3), state: 'in', detail: 'Q1 11:42',
  situation: '1st & 10 at TB 25', possession: 'away', away: 'TB', home: 'DAL', away_score: 3, home_score: 0, away_periods: [3], home_periods: [0], ...o });
const bet = (id, status = 'open', o = {}) => ({ id, voter: 5, kind: 'straight', stake: 10, price: 1.88, status, payout: status === 'won' ? 18.8 : null, note: null,
  placed_at: iso(now - 7200e3 + id), accepted_at: null, settled_at: null,
  bet_legs: [{ line_id: PROP.id, price: 1.88, point: 51.5, result: null, event: GAME, group_price: null }], ...o });

/* The stand-in database. A query is answered from a snapshot taken when it is
   asked, and delivered when the test's `gate` (if any) opens — a slow network. */
function world(seed = {}) {
  const db = { casino_rules: [RULES], casino_lines: [line(`${GAME}:ml:away`), PROP], casino_bankrolls: [], casino_games: [game()], bets: [bet(1)], ...seed };
  const w = { db, gate: null, queries: [], channels: [], timers: [], fail: {}, main: { innerHTML: '', addEventListener() {}, contains: () => false } };
  let tid = 0;
  const builder = table => {
    const st = { filters: [], order: null, limit: null, single: false };
    const api = {
      select: () => api, eq: (c, v) => (st.filters.push(r => r[c] === v), api), neq: (c, v) => (st.filters.push(r => r[c] !== v), api),
      in: (c, vs) => (st.filters.push(r => vs.includes(r[c])), api), is: (c, v) => (st.filters.push(r => (r[c] ?? null) === v), api),
      order: (c, o) => (st.order = [c, o && o.ascending === false ? -1 : 1], api), limit: n => (st.limit = n, api),
      maybeSingle: () => (st.single = true, api),
      then(res, rej) {
        w.queries.push({ table, order: st.order, limit: st.limit });
        let rows = (db[table] || []).filter(r => st.filters.every(f => f(r)));
        if (st.order) rows = rows.slice().sort((a, b) => ((a[st.order[0]] > b[st.order[0]]) - (a[st.order[0]] < b[st.order[0]])) * st.order[1]);
        if (st.limit != null) rows = rows.slice(0, st.limit);
        const out = { data: JSON.parse(JSON.stringify(st.single ? rows[0] || null : rows)), error: w.fail[table] ? { message: 'boom' } : null };
        return (async () => { if (w.gate) await w.gate; return out; })().then(res, rej);
      },
    };
    return api;
  };
  const sb = { from: builder, rpc: async () => ({ data: null, error: null }),
    channel(name) { const ch = { name, bindings: [], on(type, filter, cb) { ch.bindings.push({ table: filter.table, cb }); return ch; }, subscribe() { return ch; } };
      w.channels.push(ch); return ch; } };
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, owner: `M${i + 1}` }));
  const ctx = vm.createContext({ console, Math, Date, Number, Object, Array, Set, JSON, String, Infinity, isNaN, Promise,
    ET: 'America/New_York', TEAMS: teams, T: Object.fromEntries(teams.map(t => [t.id, t])),
    S: { tab: 'casino', voter: 5 }, configured: true, sb, main: w.main,
    document: { getElementById: () => null, activeElement: null },
    store: { get: (k, d) => d, set() {} }, SHORT_NAMES: Object.fromEntries(teams.map(t => [t.id, `T${t.id}`])),
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    rec: t => `${t?.w ?? 0}-${t?.l ?? 0}`, img: id => `<img data-av="${id}">`, banner: () => '', busyComposing: () => false,
    loadBallots: () => {}, fetch: async () => ({ ok: false }),
    setTimeout: (f, ms) => { w.timers.push({ f, ms, id: ++tid }); return tid; },
    clearTimeout: id => { const i = w.timers.findIndex(t => t.id === id); if (i >= 0) w.timers.splice(i, 1); } });
  vm.runInContext(`const pkName = id => SHORT_NAMES[id] || T[id]?.name || \`Team \${id}\`;\n${realtime}\n${casino}
    CS.view = 'bets'; CS.feed = 'all';`, ctx);
  w.ctx = ctx;
  w.run = code => vm.runInContext(code, ctx);
  w.text = () => w.main.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // let every promise and the timers the page set run to completion
  w.settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  w.fire = async ms => { const ts = w.timers.filter(t => t.ms === ms); for (const t of ts) { w.timers.splice(w.timers.indexOf(t), 1); t.f(); } await w.settle(); };
  return w;
}
const score = w => Array.from(w.main.innerHTML.matchAll(/class="bxsc">(\d+)</g)).map(m => m[1]).join(',');

test('a first read draws the live box and the prop bar from what the sync wrote', async () => {
  const w = world();
  await w.run('loadCasino()');
  assert.match(w.text(), /Q1 11:42/);
  assert.equal(score(w), '3,0');
  assert.match(w.main.innerHTML, /class="tkbub"[^>]*>22</);
});

test('the scoreboard has a realtime channel of its own, so it can never take ballots down with it', () => {
  const w = world();
  w.run('subscribe()');
  const by = Object.fromEntries(w.channels.map(c => [c.name, c.bindings.map(b => b.table)]));
  assert.deepEqual(by['ballots-live'], ['ballots', 'bets', 'casino_ledger']);
  assert.deepEqual(by['casino-games-live'], ['casino_games'], 'the docs promised scores arrive over realtime; the page now listens');
});

test('a score pushed over realtime reaches the ticket, with the prop number that landed with it', async () => {
  const w = world();
  await w.run('loadCasino()');
  w.run('subscribe()');
  // the sync writes the running number first and the scoreboard row last; the row is what realtime announces
  Object.assign(w.db.casino_lines[1], { live: 58 });
  Object.assign(w.db.casino_games[0], { detail: 'Q3 3:22', situation: '3rd & 4 at DAL 31', possession: 'home', away_score: 16, home_score: 19,
    away_periods: [3, 6, 7], home_periods: [0, 13, 6] });
  w.channels.find(c => c.name === 'casino-games-live').bindings[0].cb({ eventType: 'UPDATE' });
  assert.ok(w.timers.some(t => t.ms === 800), 'a burst of events is gathered into one read');
  await w.fire(800);
  assert.match(w.text(), /Q3 3:22/);
  assert.equal(score(w), '16,19');
  assert.match(w.text(), /3rd &amp; 4 at DAL 31/);              // innerHTML text: the page escapes the ampersand
  assert.match(w.main.innerHTML, /class="tkbub"[^>]*>58</, 'the bar moved with the score');
  assert.match(w.main.innerHTML, /bxposs" data-on="1"/);
});

test('twenty events in one second make one read, not twenty', async () => {
  const w = world();
  await w.run('loadCasino()'); w.run('subscribe()');
  const before = w.queries.length;
  const cb = w.channels.find(c => c.name === 'casino-games-live').bindings[0].cb;
  for (let i = 0; i < 20; i++) cb({});
  assert.equal(w.timers.filter(t => t.ms === 800).length, 1);
  await w.fire(800);
  assert.equal(w.queries.filter(q => q.table === 'casino_games').length, 2, 'the first load and one more');
  assert.ok(w.queries.length > before);
});

test('a read asked for while another is running is not dropped: the later data is read when the first finishes', async () => {
  const w = world();
  await w.run('loadCasino()');
  let open; w.gate = new Promise(r => { open = r; });                      // a slow network
  const first = w.run('loadCasino()');                                      // reads the database now
  Object.assign(w.db.casino_games[0], { detail: 'Q3 3:22', home_score: 19 });   // the sync lands while that read is in flight
  w.run('loadCasino()');                                                    // realtime asks again: the first is still running
  assert.equal(w.run('CS.again'), true, 'remembered, not dropped');
  w.gate = null; open();
  await first; await w.settle();
  assert.ok(w.timers.some(t => t.ms === 300), 'it reads once more shortly after');
  await w.fire(300);
  assert.match(w.text(), /Q3 3:22/, 'the page ends on the newer data');
  assert.equal(w.run('CS.again'), false);
});

test('the scoreboard is read newest first, so this week survives a season of rows', async () => {
  const old = Array.from({ length: 260 }, (_, i) => game({ event: `nfl:old${i}`, week: 1 + (i % 4), commence_at: iso(now - (40 + i) * 21600e3), state: 'post', detail: 'Final', away: 'AAA', home: 'BBB' }));
  const w = world({ casino_games: [...old, game()] });
  await w.run('loadCasino()');
  const q = w.queries.find(x => x.table === 'casino_games');
  assert.deepEqual([q.order[0], q.order[1], q.limit], ['commence_at', -1, 200]);
  assert.match(w.text(), /Q1 11:42/, 'with 261 rows in the table, the current game is still there');
  assert.ok(w.run('CS.games["nfl:7"]'));
});

test('Biggest win is the season record, not just the latest 150 bets', async () => {
  const recent = Array.from({ length: 160 }, (_, i) => bet(100 + i, 'lost', { id: 100 + i, placed_at: iso(now - i * 60e3), stake: 5, payout: 0 }));
  const big = bet(900, 'won', { voter: 3, stake: 5, payout: 400, price: 81, placed_at: iso(now - 30 * 86400e3) });
  const small = bet(901, 'won', { voter: 7, stake: 20, payout: 41, price: 2.05, placed_at: iso(now - 30 * 86400e3 + 1e3) });
  const w = world({ bets: [...recent, big, small] });
  w.run("CS.view = 'board'");
  await w.run('loadCasino()');
  assert.equal(w.run('CS.bets.length'), 150, 'the feed itself still holds the latest 150');
  assert.match(w.text(), /Biggest win T3 \+\$395\.00 on \$5\.00/);
});

test('a scoreboard or win read that fails leaves the casino working', async () => {
  const w = world(); w.fail.casino_games = true; w.fail.bets = false;
  await w.run('loadCasino()');
  assert.equal(w.run('CS.err'), null, 'the scoreboard is display only');
  assert.doesNotMatch(w.main.innerHTML, /tkbox/);
  assert.match(w.main.innerHTML, /3 Pick|Wager|tkttl/, 'the ticket is still there');
  const v = world(); v.fail.casino_lines = true;
  await v.run('loadCasino()');
  assert.match(v.main.innerHTML, /Couldn&#39;t reach the casino/, 'while a failed lines read is reported');
});

test('the page says how old the last sync is, and warns when it has stopped', () => {
  const w = world();
  const info = (ageMs, live = false) => {
    w.run(`CS.rules = { synced_at: ${JSON.stringify(iso(Date.now() - ageMs))} }; CS.games = ${live ? '{ a: { sport: "nfl", state: "in" } }' : '{}'};`);
    return JSON.parse(JSON.stringify(w.run('csFreshInfo()')));
  };
  assert.deepEqual(info(20e3), { txt: 'Updated just now', stale: false });
  assert.deepEqual(info(20e3, true), { txt: 'Live · Updated just now', stale: false }, 'only claims live while an NFL game is on');
  assert.deepEqual(info(3 * 60e3), { txt: 'Updated 3 min ago', stale: false });
  assert.deepEqual(info(12 * 60e3, true), { txt: 'Scores may be behind · last update 12 min ago', stale: true }, 'never "live" once it has stopped');
  assert.deepEqual(info(3 * 3600e3), { txt: 'Scores may be behind · last update 3 h ago', stale: true });
  w.run('CS.rules = {}');
  assert.equal(w.run('csFreshInfo()'), null, 'no sync stamp, no claim');
  assert.equal(w.run('csFresh()'), '');
});

test('jersey numbers load once from positions.json, and a failed fetch costs the digits and nothing else', async () => {
  const w = world();
  const urls = [];
  w.ctx.fetch = async url => { urls.push(url); return { ok: true, json: async () => ({ positions: { 11584: 'RB' }, numbers: { 11584: 7 } }) }; };
  await w.run('loadCasino()');
  await w.settle();
  assert.deepEqual(urls, ['positions.json']);
  assert.equal(w.run('csNumber("11584")'), 7);
  assert.match(w.main.innerHTML, /aria-label="TB #7 jersey"/, 'drawn again as soon as the digits arrive');
  await w.run('loadCasino()'); await w.settle();
  assert.equal(urls.length, 1, 'fetched once, not on every poll');

  const down = world();
  let tries = 0;
  down.ctx.fetch = async () => { tries++; throw new Error('offline'); };
  await down.run('loadCasino()'); await down.settle();
  assert.equal(down.run('CS.roster'), null);
  assert.match(down.main.innerHTML, /aria-label="TB jersey"/, 'the jersey is still drawn, in the right colours, with no digits');
  await down.run('loadCasino()'); await down.settle();
  assert.equal(tries, 1, 'and it does not hammer a server that is down: the next try is minutes away');
});

test('the page catches up on its own: on waking, on reconnecting, and every twenty seconds while a game is on', () => {
  assert.match(html, /document\.addEventListener\("visibilitychange", catchUp\)/);
  assert.match(html, /window\.addEventListener\("online", catchUp\)/);
  assert.match(html, /const catchUp = \(\) => \{ if\(document\.hidden\) return; refreshBallots\(\); if\(S\.tab==="casino"\) loadCasino\(\) \}/);
  assert.match(html, /setInterval\(\(\)=>\{ if\(S\.tab==="casino" && !document\.hidden && csLiveNow\(\)\) loadCasino\(\) \}, 20000\)/);
  assert.match(html, /setInterval\(tick, 30000\)/, 'the half-minute tick is still the floor');
});
