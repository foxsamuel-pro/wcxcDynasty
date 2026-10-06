/* The casino's money rules, run against real Postgres.
 *
 * supabase-setup.sql is executed as shipped inside PGlite (Postgres compiled to
 * WebAssembly), so place_bet, the reward triggers and settlement are exercised
 * for real — not read. PGlite is not a dependency of the site; point PGLITE at an
 * install to run these, e.g.
 *
 *   npm i --prefix /tmp/pg @electric-sql/pglite
 *   PGLITE=/tmp/pg/node_modules/@electric-sql/pglite node --test tests/casino-sql.test.mjs
 *
 * Without it, only the static contract checks at the bottom run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const sql = readFileSync(new URL('../supabase-setup.sql', import.meta.url), 'utf8');

let PGlite = null, pgcrypto = null;
try {
  const base = process.env.PGLITE;
  const load = p => import(base ? pathToFileURL(path.join(base, p)).href : `@electric-sql/pglite${p === 'dist/index.js' ? '' : '/contrib/pgcrypto'}`);
  ({ PGlite } = await load('dist/index.js'));
  ({ pgcrypto } = await load('dist/contrib/pgcrypto.js'));
} catch { PGlite = null; }

const TUE = '2026-10-06T16:00:00Z';         // Tuesday noon ET, week 5's window
const FRI = '2026-10-09T16:00:00Z';         // Friday: window shut

async function fresh() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create schema if not exists extensions;
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create publication supabase_realtime;`);
  await db.exec(sql);
  await db.exec(`insert into team_passwords (voter, pw_hash)
    select v, extensions.crypt('pw' || v, extensions.gen_salt('bf', 4)) from generate_series(1, 12) v;`);
  return db;
}
const clock = (db, iso) => db.exec(`create or replace function casino_clock() returns timestamptz
  language sql stable as $$ select '${iso}'::timestamptz $$;`);
const balance = async (db, v) => Number((await db.query(
  'select coalesce(sum(amount),0) as b from casino_ledger where voter = $1', [v])).rows[0].b);
const give = (db, v, amt, ref = `seed-${v}-${amt}`) => db.query(
  `insert into casino_ledger (voter, amount, kind, ref) values ($1, $2, 'adjust', $3)`, [v, amt, ref]);

async function line(db, o) {
  const d = { season: 2026, week: 5, sport: 'nfl', market: 'ml', side: 'home', label: 'DAL',
    event_label: 'TB @ DAL', point: null, price: 1.9091, american: -110, team: null, teams: null,
    commence_at: '2026-10-09T00:15:00Z', state: 'pre', score: '', status: 'open',
    updated_at: TUE, ...o };
  d.event ??= `nfl:${d.id.split(':')[1]}`;
  await db.query(`insert into casino_lines (id, season, week, event, sport, market, side, label, event_label,
      point, price, american, team, teams, commence_at, state, score, status, updated_at, sim)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, decode($20, 'hex'))`,
    [d.id, d.season, d.week, d.event, d.sport, d.market, d.side, d.label, d.event_label,
     d.point, d.price, d.american, d.team, d.teams, d.commence_at, d.state, d.score, d.status, d.updated_at, d.sim ?? null]);
  return d;
}
const bet = (db, voter, legs, stake, pw = `pw${voter}`, price = null) => db.query(
  'select place_bet($1, $2, $3::jsonb, $4, $5) as r', [voter, pw, JSON.stringify(legs), stake, price])
  .then(x => x.rows[0].r);
// a simulation: 512 bytes = 4096 simulated games, built byte by byte
const simOf = fn => Buffer.from(Array.from({ length: 512 }, (_, i) => fn(i))).toString('hex');
const leg = l => ({ line: l.id, price: l.price, point: l.point });
const rejects = (p, re) => assert.rejects(p, e => re.test(e.message), `expected ${re}`);

const t = PGlite ? test : test.skip;

t('a complete ballot in the window pays $100 once; backfills, partial and late ones pay nothing', async () => {
  const db = await fresh();
  await clock(db, TUE);
  const rank = '{1,2,3,4,5,6,7,8,9,10,11,12}';
  await db.exec(`insert into ballots (season, week, voter, ranking) values (2026, 5, 3, '${rank}')`);
  assert.equal(await balance(db, 3), 100);
  await db.exec(`update ballots set ranking = '{12,11,10,9,8,7,6,5,4,3,2,1}' where voter = 3`);
  assert.equal(await balance(db, 3), 100, 'resubmitting never pays twice');
  await db.exec(`insert into ballots (season, week, voter, ranking) values (2026, 4, 3, '${rank}')`);
  assert.equal(await balance(db, 3), 100, 'a backfilled week mints nothing');
  await db.exec(`insert into ballots (season, week, voter, ranking) values (2026, 5, 4, '{1,2,3}')`);
  assert.equal(await balance(db, 4), 0, 'an incomplete ballot is not a completed ballot');
  assert.equal((await db.query("select to_regclass('public.picks') as t")).rows[0].t, null, 'pick em is no longer created');
  await clock(db, FRI);
  await db.exec(`insert into ballots (season, week, voter, ranking) values (2026, 5, 6, '${rank}')`);
  assert.equal(await balance(db, 6), 0, 'outside the window pays nothing');
});

t('a straight bet debits the stake, stores the price it was placed at, and can be settled once', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 2, 100);
  const l = await line(db, { id: 'nfl:1:ml:home', price: 1.2128, american: -470 });
  const r = await bet(db, 2, [leg(l)], 40);
  assert.equal(r.status, 'open');
  assert.equal(await balance(db, 2), 60);
  const legs = (await db.query('select * from bet_legs where bet_id = $1', [r.id])).rows;
  assert.equal(Number(legs[0].price), 1.2128);
  await db.query(`select casino_settle($1, 'won', 999999)`, [r.id]);
  assert.equal(await balance(db, 2), 108.51, 'payout capped at stake x price whatever the caller asks');
  assert.equal((await db.query(`select casino_settle($1, 'won', 48.51) as ok`, [r.id])).rows[0].ok, false);
  assert.equal(await balance(db, 2), 108.51, 'settling twice pays once');
});

t('every ceiling the commissioner sets, and every rule, is enforced in the database', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 1, 500);
  // none of these exist by default; set, they hold
  await db.exec(`update casino_rules set max_stake_straight = 100, max_stake_parlay = 25, max_payout = 1000,
    parlay_max_price = 21, leg_max_price = 11, leg_min_price = 1.2, max_open = 10`);
  const a = await line(db, { id: 'nfl:1:ml:home' });
  const a2 = await line(db, { id: 'nfl:1:total:over', market: 'total', side: 'over', point: 47.5 });
  const b = await line(db, { id: 'nfl:2:ml:away', price: 3.6, american: 260 });
  const c = await line(db, { id: 'nfl:3:ml:away', price: 6, american: 500 });
  const d = await line(db, { id: 'nfl:4:ml:away', price: 6, american: 500 });
  const fav = await line(db, { id: 'nfl:5:ml:home', price: 1.1, american: -1000 });
  const long = await line(db, { id: 'nfl:10:ml:away', price: 11, american: 1000 });
  const sus = await line(db, { id: 'nfl:6:ml:home', status: 'suspended' });
  const gone = await line(db, { id: 'nfl:7:ml:home', commence_at: '2026-10-06T15:00:00Z' });
  const stale = await line(db, { id: 'nfl:8:ml:home', updated_at: '2026-10-06T14:00:00Z' });
  const live = await line(db, { id: 'nfl:9:ml:home', state: 'in', score: '7-0|DAL' });

  await rejects(bet(db, 1, [leg(a)], 10, 'nope'), /Wrong password/);
  await rejects(bet(db, 1, [{ ...leg(a), price: 2.5 }], 10), /Odds changed/);
  await rejects(bet(db, 1, [{ ...leg(a2), point: 44.5 }], 10), /Odds changed/);
  await rejects(bet(db, 1, [leg(a), leg(a2)], 10), /isn't priced for same-game/, 'same game without a simulation');
  await rejects(bet(db, 1, [leg(a), leg(a)], 10), /twice/);
  await rejects(bet(db, 1, [leg(fav)], 10), /too short/);
  await rejects(bet(db, 1, [leg(sus)], 10), /suspended/);
  await rejects(bet(db, 1, [leg(gone)], 10), /kicked off/);
  await rejects(bet(db, 1, [leg(stale)], 10), /out of date/);
  await rejects(bet(db, 1, [leg(live)], 10), /closed for betting/);
  await rejects(bet(db, 1, [leg(a)], 100.5), /Maximum straight/);
  await rejects(bet(db, 1, [leg(a)], 10.555), /dollars and cents/);
  await rejects(bet(db, 1, [leg(a)], 0.5), /Minimum/);
  await rejects(bet(db, 1, [leg(a), leg(b)], 26), /Maximum parlay/);
  await rejects(bet(db, 1, [], 10), /selection/);
  await rejects(bet(db, 1, [{ line: 'nope', price: 2, point: null }], 10), /no longer offered/);
  await rejects(bet(db, 2, [leg(a)], 10), /You have \$0.00/);

  // +2000 cap: 3.6 x 6 x 6 = 129.6 becomes 21, so $25 would pay $525 — fine;
  // the payout cap bites on a straight at long odds instead.
  const p = await bet(db, 1, [leg(b), leg(c), leg(d)], 25);
  assert.equal(Number(p.price), 21);
  await rejects(bet(db, 1, [leg(long)], 100), /at most \$1000.*\$90\.9/);
  assert.equal(await balance(db, 1), 475);

  // live bets wait out the delay once live betting is switched on
  await db.exec('update casino_rules set live_enabled = true');
  const lb = await bet(db, 1, [leg(live)], 10);
  assert.equal(lb.status, 'pending');
  await db.query(`select casino_resolve($1, false, 'The game moved during the delay')`, [lb.id]);
  assert.equal(await balance(db, 1), 475, 'a refused live bet is refunded in full');
  await db.query(`select casino_resolve($1, false, 'again')`, [lb.id]);
  assert.equal(await balance(db, 1), 475, 'and only once');
});

t('betting against your own WCXC team is refused by default, and allowed only if switched off', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 5, 100);
  const f = o => line(db, { sport: 'fantasy', event: 'fan:2026:5:3', teams: [5, 6],
    commence_at: '2026-10-09T00:15:00Z', ...o });
  const mine = await f({ id: 'fan:2026:5:3:ml:5', side: '5', team: 5 });
  const theirs = await f({ id: 'fan:2026:5:3:ml:6', side: '6', team: 6 });
  const under = await f({ id: 'fan:2026:5:3:total:under', market: 'total', side: 'under', point: 240.5 });
  const over = await f({ id: 'fan:2026:5:3:total:over', market: 'total', side: 'over', point: 240.5 });
  await rejects(bet(db, 5, [leg(theirs)], 10), /against it/);
  await rejects(bet(db, 5, [leg(under)], 10), /against it/);
  assert.equal((await bet(db, 5, [leg(mine)], 10)).status, 'open');
  assert.equal((await bet(db, 5, [leg(over)], 10)).status, 'open');
  await db.exec('update casino_rules set block_self_bets = false');
  assert.equal((await bet(db, 5, [leg(theirs)], 10)).status, 'open', 'only when the commissioner turns it off');
  // anyone else can take either side
  await give(db, 7, 100);
  assert.equal((await bet(db, 7, [leg(theirs)], 10)).status, 'open');
});

t('open tickets are capped so a bankroll cannot be spread without limit', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 9, 1000);
  await db.exec('update casino_rules set max_open = 2');
  const l = await line(db, { id: 'nfl:1:ml:home' });
  await bet(db, 9, [leg(l)], 5);
  await bet(db, 9, [leg(l)], 5);
  await rejects(bet(db, 9, [leg(l)], 5), /2 bets open/);
});

/* ---------- static contract checks: always run ---------- */
test('only place_bet is open to the public; settlement is service-role only', () => {
  assert.match(sql, /grant execute on function public\.place_bet\(int, text, jsonb, numeric, numeric\) to anon, authenticated/);
  for (const f of ['casino_set_outcomes\\(jsonb\\)', 'casino_grade_legs\\(jsonb\\)',
    'casino_settle\\(bigint, text, numeric\\)', 'casino_resolve\\(bigint, boolean, text\\)'])
    assert.match(sql, new RegExp(`revoke all on function public\\.${f}\\s+from public, anon, authenticated`));
  assert.match(sql, /unique \(kind, ref\)/, 'the ledger must refuse a duplicate reward, stake or payout');
  assert.doesNotMatch(sql, /create policy[^;]*casino[^;]*for (insert|update|delete)/i, 'no direct writes');
});

t('the setup script is still safe to re-run: bankrolls, bets and rules survive', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 4, 80);
  await db.exec('update casino_rules set max_payout = 500');
  const l = await line(db, { id: 'nfl:1:ml:home' });
  await bet(db, 4, [leg(l)], 10);
  await db.exec(sql);
  assert.equal(await balance(db, 4), 70);
  assert.equal(Number((await db.query('select max_payout from casino_rules')).rows[0].max_payout), 500);
  assert.equal((await db.query('select count(*)::int as n from bets')).rows[0].n, 1);
});

t('running the setup pays ballots cast this week before the casino existed, and nothing earlier', async () => {
  const db = await fresh();
  // rows that landed before the reward trigger was installed
  await db.exec(`alter table ballots disable trigger casino_reward_ballot;`);
  const rank = '{1,2,3,4,5,6,7,8,9,10,11,12}';
  await db.exec(`
    insert into ballots (season, week, voter, ranking, updated_at) values
      (2026, 5, 11, '${rank}', '2026-10-06T04:09:34Z'),            -- just after midnight ET Tuesday: pays
      (2026, 5, 2,  '${rank}', '2026-10-08T23:59:00Z'),            -- Thursday 7:59 PM ET: pays
      (2026, 5, 6,  '${rank}', '2026-10-09T00:01:00Z'),            -- Thursday 8:01 PM ET, window shut: no
      (2026, 5, 9,  '{1,2,3}', '2026-10-06T05:00:00Z'),            -- incomplete: no
      (2026, 4, 3,  '${rank}', '2026-09-29T05:00:00Z');            -- week 4, before the casino opened: no`);
  await db.exec(`alter table ballots enable trigger casino_reward_ballot;`);
  await db.exec(sql);
  for (const [v, want] of [[11, 100], [2, 100], [6, 0], [9, 0], [3, 0]])
    assert.equal(await balance(db, v), want, `team ${v}`);
  await db.exec(sql);
  assert.equal(await balance(db, 11), 100, 'running the setup again pays nothing twice');
});

t('same-game parlays: priced from the simulation, capped at multiplied, refused when impossible or unpriceable', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 3, 200);
  const half = simOf(i => i < 256 ? 0xff : 0);                                 // wins in 2048 of 4096 games
  const a = await line(db, { id: 'nfl:1:spread:home', market: 'spread', side: 'home', point: -3.5, sim: half });
  const b = await line(db, { id: 'prop:1:9:rec_yd:over', event: 'nfl:1', sport: 'prop', market: 'rec_yd', side: 'over',
    point: 60.5, price: 1.8696, american: -115, sim: simOf(i => (i < 128 || (i >= 256 && i < 384)) ? 0xff : 0) });
  const c = await line(db, { id: 'nfl:1:spread:away', market: 'spread', side: 'away', point: 3.5, sim: simOf(i => i < 256 ? 0 : 0xff) });
  const e = await line(db, { id: 'prop:1:9:rec:over', event: 'nfl:1', sport: 'prop', market: 'rec', side: 'over',
    point: 4.5, price: 1.8696, american: -115, sim: simOf(i => i < 64 ? 0xff : 0) });
  const f = await line(db, { id: 'prop:1:8:rush_yd:over', event: 'nfl:1', sport: 'prop', market: 'rush_yd', side: 'over',
    point: 50.5, price: 1.8696, american: -115, sim: simOf(i => i < 2 ? 0xff : 0) });
  const bare = await line(db, { id: 'nfl:1:total:over', market: 'total', side: 'over', point: 44.5 });

  // a and b both win in 1024 games: 0.85 x 4096 / 1024 = 3.4, under the 3.5693 multiplied
  const r = await bet(db, 3, [leg(a), leg(b)], 10);
  assert.equal(Number(r.price), 3.4);
  const rows = (await db.query('select event, group_price from bet_legs where bet_id = $1', [r.id])).rows;
  assert.ok(rows.every(x => x.event === 'nfl:1' && Number(x.group_price) === 3.4), 'legs remember their group and its price');

  // a and e share only 512 games: the simulation says 6.8, the cap says the legs multiplied
  assert.equal(Number((await bet(db, 3, [leg(a), leg(e)], 10)).price), 3.5693);

  await rejects(bet(db, 3, [leg(a), leg(c)], 10), /can't all win together/);
  await rejects(bet(db, 3, [leg(a), leg(f)], 10), /too unlikely to price/);
  await rejects(bet(db, 3, [leg(a), leg(bare)], 10), /isn't priced for same-game/);
  await rejects(bet(db, 3, [leg(a), leg(b)], 10, 'pw3', 3.0), /Odds changed/, 'the page showed a different price');
  assert.equal(Number((await bet(db, 3, [leg(a), leg(b)], 10, 'pw3', 3.4)).price), 3.4, 'the price the page showed is accepted');

  // no limit on legs from one game unless one is set
  const more = [];
  for (let k = 0; k < 5; k++) more.push(await line(db, { id: `prop:1:${20 + k}:rec:over`, event: 'nfl:1', sport: 'prop',
    market: 'rec', side: 'over', point: 3.5, price: 1.8696, american: -115, sim: half }));
  assert.equal(Number((await bet(db, 3, more.map(leg), 5)).price), 1.7, 'five legs that win together price as one');
  await db.exec('update casino_rules set sgp_max_legs = 4');
  await rejects(bet(db, 3, more.map(leg), 5), /at most 4 legs/);
  await db.exec('update casino_rules set sgp_max_legs = null');
  // first and last scorer can't join a same-game group
  const ftd = await line(db, { id: 'prop:1:s9:ftd:yes', event: 'nfl:1', sport: 'prop', market: 'ftd', side: 'yes', price: 8, american: 700 });
  await rejects(bet(db, 3, [leg(a), leg(ftd)], 5), /First and last touchdown scorer/);

  // a near-certain combination would pay less than the stake back
  const sure = simOf(() => 0xff);
  const s1 = await line(db, { id: 'nfl:2:ml:home', price: 1.25, american: -400, sim: sure });
  const s2 = await line(db, { id: 'nfl:2:total:under', market: 'total', side: 'under', point: 60.5, price: 1.25, american: -400, sim: sure });
  await rejects(bet(db, 3, [leg(s1), leg(s2)], 10), /too likely to price/);

  // WCXC matchups stay one leg each; live same-game parlays are refused
  const f1 = await line(db, { id: 'fan:2026:5:3:ml:5', event: 'fan:2026:5:3', sport: 'fantasy', side: '5', team: 5, teams: [5, 6] });
  const f2 = await line(db, { id: 'fan:2026:5:3:total:over', event: 'fan:2026:5:3', sport: 'fantasy', market: 'total', side: 'over', point: 300.5, teams: [5, 6] });
  await rejects(bet(db, 3, [leg(f1), leg(f2)], 10), /one leg per WCXC matchup/);
  await db.exec('update casino_rules set live_enabled = true');
  const l1 = await line(db, { id: 'nfl:3:ml:home', state: 'in', score: '7-0|DAL', sim: half });
  const l2 = await line(db, { id: 'nfl:3:total:over', market: 'total', side: 'over', point: 44.5, state: 'in', score: '7-0|DAL', sim: half });
  await rejects(bet(db, 3, [leg(l1), leg(l2)], 10), /pregame only/);
});

t('no bet ceilings or floors by default: any stake the bankroll covers, any price, any legs, paid in full', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 4, 2000);
  // a long single at +6000 with most of the bankroll on it
  const far = await line(db, { id: 'prop:201:s9:td4:yes', event: 'nfl:201', sport: 'prop', market: 'td4', side: 'yes', price: 61, american: 6000 });
  const big = await bet(db, 4, [leg(far)], 400);
  assert.equal(Number(big.payout), 24400);
  // twenty legs at even money: over a million to one, no parlay cap
  const legs = [];
  for (let k = 1; k <= 20; k++) legs.push(await line(db, { id: `nfl:${100 + k}:ml:home`, price: 2, american: 100 }));
  const r = await bet(db, 4, legs.map(leg), 100);
  assert.equal(Number(r.price), 1048576);
  assert.equal(Number(r.payout), 104857600, 'the widened columns hold a nine-figure payout');
  await db.query(`select casino_settle($1, 'won', 104857600)`, [r.id]);
  assert.equal(await balance(db, 4), 2000 - 400 - 100 + 104857600, 'and settlement pays every cent');
  // as many open tickets as the bankroll allows
  const one = await line(db, { id: 'nfl:300:ml:home' });
  for (let k = 0; k < 15; k++) await bet(db, 4, [leg(one)], 1);
  // no shortest price either: a -1000 line is bettable; only the $1 minimum stays
  await rejects(bet(db, 4, [leg(one)], 0.5), /Minimum/);
  const fav = await line(db, { id: 'nfl:301:ml:home', price: 1.1, american: -1000 });
  assert.equal((await bet(db, 4, [leg(fav)], 10)).status, 'open');
  await db.exec('update casino_rules set leg_min_price = 1.2');
  await rejects(bet(db, 4, [leg(fav)], 10), /too short/, 'and a floor, once set, holds');
  // and a ceiling, once set, holds
  await db.exec('update casino_rules set parlay_max_legs = 6, leg_max_price = 51');
  await rejects(bet(db, 4, legs.map(leg), 10), /Parlays take 2 to 6 legs/);
  await rejects(bet(db, 4, [leg(far)], 5), /too long a price/);
});

t('an existing database with pick em data: the table and rows stay, the reward and write path go', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create schema if not exists extensions;
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create publication supabase_realtime;
    create table public.picks (season int, week int, voter int, picks int[], updated_at timestamptz default now());
    insert into public.picks values (2026, 4, 7, '{1,3,5,7,9,11}', now());
    alter publication supabase_realtime add table public.picks;
    create function public.submit_picks(int, int, int, int[], text) returns text language sql as $$ select 'old' $$;`);
  await db.exec(sql);
  assert.equal((await db.query('select count(*)::int as n from picks')).rows[0].n, 1, 'history kept');
  assert.equal((await db.query("select to_regprocedure('public.submit_picks(int,int,int,int[],text)') as f")).rows[0].f, null, 'no write path');
  assert.equal((await db.query("select count(*)::int as n from pg_trigger where tgname = 'casino_reward_picks'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from pg_publication_tables where tablename = 'picks'")).rows[0].n, 0, 'off realtime');
  await db.exec(sql);                                         // and the setup still runs again cleanly
});

/* The scoreboard behind a ticket. It is display only: a game row moving must
   never touch a price, an outcome or a balance, and the page must be able to
   read it while being unable to write it. */
t('casino_games is readable by everyone, writable only by the sync, and never touches money', async () => {
  const db = await fresh();
  await clock(db, TUE);
  await give(db, 4, 100);
  const l = await line(db, { id: 'nfl:1:ml:home' });
  const b = await bet(db, 4, [leg(l)], 10);

  const games = p => db.query('select casino_set_games($1::jsonb) as n', [JSON.stringify(p)]).then(r => r.rows[0].n);
  const row = { event: 'nfl:1', sport: 'nfl', season: 2026, week: 5, commence_at: '2026-10-09T00:15:00Z',
    state: 'in', detail: 'Q3 3:22', situation: '1st & 10 at DET 27', possession: 'home',
    away: 'CAR', home: 'DET', away_score: 16, home_score: 27, away_periods: [7, 9, 0], home_periods: [3, 13, 3] };
  assert.equal(await games([row]), 1);
  const got = (await db.query('select * from casino_games where event = $1', ['nfl:1'])).rows[0];
  assert.equal(got.detail, 'Q3 3:22');
  assert.equal(got.possession, 'home');
  assert.deepEqual(got.away_periods, [7, 9, 0]);
  assert.equal(Number(got.home_score), 27);

  // the same event again replaces the row rather than adding one
  assert.equal(await games([{ ...row, detail: 'Final', state: 'post', possession: null, home_score: 30 }]), 1);
  assert.equal((await db.query('select count(*)::int as n from casino_games')).rows[0].n, 1);
  const fin = (await db.query('select * from casino_games where event = $1', ['nfl:1'])).rows[0];
  assert.equal(fin.detail, 'Final');
  assert.equal(fin.possession, null);

  // a WCXC matchup keeps roster ids as text and carries no quarters
  await games([{ event: 'fan:2026:5:3', sport: 'fantasy', season: 2026, week: 5, commence_at: '2026-10-09T00:15:00Z',
    state: 'in', detail: 'Live', situation: '', possession: null, away: '5', home: '6',
    away_score: 88.4, home_score: 102.1, away_periods: null, home_periods: null }]);
  const fan = (await db.query('select * from casino_games where event = $1', ['fan:2026:5:3'])).rows[0];
  assert.equal(Number(fan.away_score), 88.4);
  assert.equal(fan.away_periods, null);

  // none of that moved the bet, its price, or the bankroll
  const after = (await db.query('select status, price, payout from bets where id = $1', [b.id])).rows[0];
  assert.equal(after.status, 'open');
  assert.equal(after.payout, null);
  assert.equal(await balance(db, 4), 90);
  assert.equal((await db.query('select outcome from casino_lines where id = $1', ['nfl:1:ml:home'])).rows[0].outcome, null);

  // the public can read it and cannot write it
  await db.exec('set role anon');
  assert.equal((await db.query('select count(*)::int as n from casino_games')).rows[0].n, 2);
  await assert.rejects(db.query("update casino_games set home_score = 99 where event = 'nfl:1'"));
  await assert.rejects(db.query("select casino_set_games('[]'::jsonb)"), /permission denied/);
  await db.exec('reset role');
});

t("a prop's running number is display only, and survives a re-run of the setup", async () => {
  const db = await fresh();
  await clock(db, TUE);
  const p = await line(db, { id: 'prop:1:s1:rec_yd:over', sport: 'prop', market: 'rec_yd', side: 'over', point: 24.5 });
  const live = v => db.query('select casino_set_live($1::jsonb) as n', [JSON.stringify([{ id: p.id, live: v }])])
    .then(r => r.rows[0].n);
  assert.equal(await live(18), 1);
  assert.equal(Number((await db.query('select live from casino_lines where id = $1', [p.id])).rows[0].live), 18);
  assert.equal(await live(18), 0, 'an unchanged number is not rewritten');
  assert.equal(await live(25.5), 1);
  // it is not an outcome: the leg stays ungraded until settlement sets one
  assert.equal((await db.query('select outcome from casino_lines where id = $1', [p.id])).rows[0].outcome, null);
  await db.exec(sql);
  assert.equal(Number((await db.query('select live from casino_lines where id = $1', [p.id])).rows[0].live), 25.5);
});

test('the scoreboard writers are service-role only, like every other sync function', () => {
  for (const f of ['casino_set_games\\(jsonb\\)', 'casino_set_live\\(jsonb\\)'])
    assert.match(sql, new RegExp(`revoke all on function public\\.${f}\\s+from public, anon, authenticated`));
  assert.match(sql, /grant execute on function public\.casino_set_games\(jsonb\)\s+to service_role/);
  assert.match(sql, /grant execute on function public\.casino_set_live\(jsonb\)\s+to service_role/);
  assert.match(sql, /add table public\.casino_games/, 'scores reach an open page over realtime');
});
