/* Weekly pick 'em: the position map the page depends on, and the contract
   between the page, the schema and the window. The interactive side is covered
   by the jsdom harness; these are the parts that can be checked offline. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { positionMap, FANTASY } from '../scripts/picks/build.mjs';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sql = await readFile(new URL('../supabase-setup.sql', import.meta.url), 'utf8');

/* The win probability is position-aware, so the page needs each starter's
   position and NFL team. Sleeper's only source for that is a ~5MB player file,
   which is far too much to pull into a page to read 120 positions off it. */
test('the position map keeps what the page needs and nothing else', () => {
  const players = {
    '1': { position: 'QB', team: 'BUF' },
    '2': { position: 'WR', team: null },      // unsigned: position but no game
    '3': { position: 'OL', team: 'KC' },      // nobody's lineup slot
    '4': { position: 'TE', team: 'LV' },
    '5': null,
    '6': { position: 'DEF', team: 'SF' }
  };
  const { positions, teams } = positionMap(players);
  assert.deepEqual(positions, { '1': 'QB', '2': 'WR', '4': 'TE', '6': 'DEF' });
  assert.deepEqual(teams, { '1': 'BUF', '4': 'LV', '6': 'SF' },
    'a player with no NFL team has no game to finish, so he is left out');
  assert.ok(!('3' in positions), 'offensive line would double the file for nothing');
  assert.ok(!('5' in positions), 'a null player must not throw or appear');
  assert.deepEqual(positionMap({}), { positions: {}, teams: {} });
  assert.ok(FANTASY.includes('QB') && FANTASY.includes('TE') && !FANTASY.includes('LB'));
});

test('the published position file is present and plausible', async () => {
  const file = JSON.parse(await readFile(new URL('../positions.json', import.meta.url), 'utf8'));
  assert.match(file.built, /^\d{4}-\d{2}-\d{2}$/, 'the file must say when it was built');
  assert.ok(file.count > 1000, `only ${file.count} players`);
  assert.equal(Object.keys(file.positions).length, file.count);
  assert.ok(Object.keys(file.teams).length > 500, 'most active players should have an NFL team');
  for (const pos of Object.values(file.positions)) assert.ok(FANTASY.includes(pos), `stray position ${pos}`);
  // every id with a team must also have a position, or the spread lookup misses
  for (const id of Object.keys(file.teams)) assert.ok(file.positions[id], `${id} has a team but no position`);
});

/* A pick is stored as the roster_id expected to win, with no matchup id: a team
   plays exactly one opponent in a week, so the roster_id locates its own
   matchup. That also means the row cannot be misread if Sleeper ever renumbers
   its matchup ids. */
test('the schema stores picks as roster ids, guarded on both ends', () => {
  assert.match(sql, /create table if not exists public\.picks/);
  assert.match(sql, /picks\s+int\[\] not null/, 'picks are roster ids, not a json blob');
  assert.match(sql, /primary key \(season, week, voter\)/, 'one slate per team per week');
  assert.match(sql, /week\s+int\s+not null check \(week between 1 and 18\)/);
  assert.match(sql, /voter\s+int\s+not null check \(voter between 1 and 12\)/);
  assert.match(sql, /alter table public\.picks enable row level security/);
  // readable by everyone, writable only through the RPC
  assert.match(sql, /create policy "Anyone can read picks" on public\.picks/);
  const block = sql.slice(sql.indexOf('PICK \'EM'), sql.indexOf('-- Live updates'));
  assert.ok(!/for (insert|update|delete)/.test(block),
    'no direct write policy: submit_picks must be the only way in');
});

test('submit_picks validates the slate and checks the team password', () => {
  const fn = sql.slice(sql.indexOf('function public.submit_picks('), sql.indexOf('revoke all on function public.submit_picks'));
  assert.ok(fn, 'submit_picks must exist');
  assert.match(fn, /security definer/, 'it writes a table the anon role cannot touch');
  assert.match(fn, /set search_path = public, extensions/);
  assert.match(fn, /p_voter not between 1 and 12/);
  assert.match(fn, /p_week not between 1 and 18/);
  // six matchups for twelve teams, and no team may be picked twice
  assert.match(fn, /n < 1 or n > 6/);
  assert.match(fn, /count\(distinct x\).*<> n/s, 'duplicate or out-of-range picks must be refused');
  assert.match(fn, /length\(p_password\) < 4/);
  assert.match(fn, /crypt\(p_password, gen_salt\('bf'\)\)/, 'first submission sets the team password');
  assert.match(fn, /existing <> crypt\(p_password, existing\)/, 'every later one must match it');
  assert.match(fn, /on conflict \(season, week, voter\)/, 'resubmitting replaces the slate');
  assert.match(sql, /grant execute on function public\.submit_picks\(int, int, int, int\[\], text\) to anon, authenticated/);
  // realtime, so a submitted slate appears for everyone without a reload
  assert.match(sql, /alter publication supabase_realtime add table public\.picks/);
});

/* The pick window is the ballot window, deliberately: Tuesday midnight to
   Thursday 8:00 PM ET, which shuts before Thursday night kickoff. */
test('the page reuses the ballot window rather than inventing one', () => {
  assert.match(page, /const picksOpen = \(\) => windowOpen\(\) && S\.pickWeek === ballotWeek\(\);/);
  assert.match(page, /Tuesday 12:00 AM to Thursday 8:00 PM ET/);
  // submitting must re-check the window, not trust the button being on screen
  const submit = page.slice(page.indexOf('async function submitPicks()'), page.indexOf('/* ---------- pick \'em page'));
  assert.match(page, /if\(!picksOpen\(\)\)\{ renderPicks\(\); return \}/,
    'a window that shut mid-page must not accept a submission');
});

test('the page is registered as a tab and routed', () => {
  assert.match(page, /const TABS = \["vote","news","picks",/, 'Pick \'em sits beside the ballot');
  assert.match(page, /picks:renderPicks/, 'the render switch must route it');
  assert.match(page, /data-tab="picks"/, 'and a button must exist');
  // a half-filled slate must survive a background refresh
  assert.match(page, /if\(S\.tab==="picks" && Object\.keys\(S\.pick\)\.length\) return true;/);
});

/* The win probability model is the newspaper's, and it reproduces Sleeper's own
   numbers. A flat spread gave 13% where Sleeper said 16%. */
test('the win probability is position-aware and matches the newspaper', () => {
  assert.match(page, /const SPREAD = \{QB:0\.55, RB:0\.75, WR:0\.85, TE:0\.80\};/);
  assert.match(page, /SPREAD\[pos\.positions\[id\]\] \?\? 0\.75/, 'an unknown position falls back, never throws');
  // points already banked are certainty; only what is left carries variance
  assert.match(page, /const left = \(nfl && done\[nfl\]\) \? 0 : Math\.max\(0, projected - scored\);/);
  assert.match(page, /sd>0 \? normalCdf\(\(a\.proj-b\.proj\)\/sd\) : a\.proj===b\.proj \? 0\.5/,
    'a settled matchup must not divide by zero');
  // league scoring drives it, so half PPR / TE premium / PPFD are not hardcoded
  assert.match(page, /if\(league\.scoring_settings\) SCORING = league\.scoring_settings;/);
});

/* Grading only counts weeks that have been played. An unpicked or unplayed week
   is not a miss, and a tie is a push that counts for nobody. */
test('grading is confined to played weeks', () => {
  const fn = page.slice(page.indexOf('function gradePicks()'), page.indexOf('const pickPct ='));
  assert.match(fn, /SCHED\?\.byWeek \|\| \{\}/, 'byWeek holds completed weeks only');
  assert.match(fn, /if\(!wk\) continue;/, 'an unfinished week is skipped, not counted wrong');
  assert.match(fn, /if\(r\.pf === r\.pa\) push\+\+;/, 'a tie is a push');
  assert.match(fn, /tally\.made\+\+/, 'slates submitted are counted even when ungraded');
  assert.match(page, /const pickPct = t => \(t\.right\+t\.wrong\) \? t\.right\/\(t\.right\+t\.wrong\) : null;/,
    'a team with nothing graded has no accuracy, rather than zero');
});

test('the CSP already allows everything the tab talks to', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  const csp = headers.match(/Content-Security-Policy: ([^\n]+)/)[1];
  assert.match(csp, /connect-src [^;]*'self'/, 'positions.json is served from the site itself');
  assert.match(csp, /connect-src [^;]*https:\/\/api\.sleeper\.app/);
  assert.match(csp, /connect-src [^;]*https:\/\/\*\.supabase\.co/);
});
