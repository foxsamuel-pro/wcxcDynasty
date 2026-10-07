/* Build cfb.json and cfb-players.json: what the casino needs to know about
 * college football that a college line doesn't carry.
 *
 *   node scripts/cfb/build.mjs
 *
 * cfb.json is for the page. A college line carries only ESPN's team id, so this
 * is every team that has appeared on an FBS scoreboard this season: its
 * abbreviation, school, full name, colours and conference, plus this week's AP
 * Top 25 and the conferences' names. That is what draws a college game (school
 * names, logos, rankings), its players' jerseys (the team's own colours), and
 * the board's Top 25 and conference filter. About 15 KB.
 *
 * cfb-players.json is for the sync. FanDuel names a college prop's player and
 * nothing else; Sleeper doesn't know college players at all. So each roster on
 * this week's and next week's slate is reduced to normalised name -> [ESPN
 * athlete id, jersey], skill positions only, and the sync finds a player here
 * WITHIN THE TWO TEAMS PLAYING, then settles his prop from ESPN's box score by
 * that id. A name two players on one roster share is stored as 0 and skipped:
 * a prop nobody can be sure of settling is not offered. ESPN's rosters are
 * ~440 KB each, far too much to read on every refresh, hence once a day here.
 *
 * Rebuilt daily by the odds workflow. If ESPN can't be read the previous files
 * stand; a roster that fails keeps its previous entry.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { jsonRequest } from '../news/data.mjs';
import { normName } from '../../supabase/functions/_shared/casino.mjs';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
// the positions FanDuel posts college props for; ATH is ESPN's tag for a player listed at several
export const SKILL = ['QB', 'RB', 'WR', 'TE', 'FB', 'ATH'];
// conferences with no conference games of their own never get a name from a scoreboard
const CONF_FALLBACK = { 18: 'Independents' };

const hex = s => /^[0-9a-f]{6}$/i.test(String(s || '')) ? String(s).toLowerCase() : '';

/* Every team on this season's FBS scoreboards, and the conferences they are in.
   A competitor names its conference by id; a conference game names it in words. */
export function slateTeams(scoreboards) {
  const teams = {}, conferences = {};
  for (const sb of scoreboards || []) for (const ev of sb?.events || []) {
    const c = ev?.competitions?.[0];
    const g = c?.groups;
    if (g?.isConference && g.id != null && g.shortName) conferences[String(g.id)] = g.shortName;
    for (const x of c?.competitors || []) {
      const t = x?.team;
      if (!t?.id) continue;
      teams[String(t.id)] = { conf: t.conferenceId != null ? String(t.conferenceId) : null };
    }
  }
  for (const [id, name] of Object.entries(CONF_FALLBACK)) if (!conferences[id] && Object.values(teams).some(t => t.conf === id)) conferences[id] = name;
  return { teams, conferences };
}

// ESPN's team list reduced to what the page draws: [abbreviation, school, full name, colour, alternate, conference]
export function teamRows(espnTeams, slate) {
  const out = {};
  for (const t of espnTeams || []) {
    const id = String(t?.id ?? '');
    if (!id || !slate.teams[id]) continue;
    out[id] = [t.abbreviation || '', t.shortDisplayName || t.location || t.displayName || '', t.displayName || '',
      hex(t.color), hex(t.alternateColor), slate.teams[id].conf];
  }
  return out;
}

// This week's AP Top 25, team id -> rank
export function apRanks(rankings) {
  const poll = (rankings?.rankings || []).find(r => /^AP\b/i.test(r?.name || '') || r?.type === 'ap');
  return Object.fromEntries((poll?.ranks || []).filter(r => r?.team?.id && Number(r.current) > 0)
    .map(r => [String(r.team.id), Number(r.current)]));
}

/* One roster, skill positions only, as normalised name -> [athlete id, jersey].
   Two players sharing a name: 0, so the sync skips that name rather than guess. */
export function rosterIndex(roster, keep = SKILL) {
  const out = {};
  for (const a of (roster?.athletes || []).flatMap(g => g?.items || [])) {
    if (!a?.id || !keep.includes(a.position?.abbreviation)) continue;
    const k = normName(a.fullName || a.displayName);
    if (!k) continue;
    const n = Number(a.jersey), jersey = String(a.jersey ?? '').trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
    out[k] = Object.prototype.hasOwnProperty.call(out, k) ? 0 : [String(a.id), jersey];
  }
  return out;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function writeIfChanged(file, body, same, label) {
  const previous = await readFile(file, 'utf8').catch(() => null);
  if (previous && same(JSON.parse(previous))) { console.log(`${label} unchanged`); return; }
  const next = JSON.stringify(body);
  await writeFile(file, next);
  console.log(`wrote ${label} (${Math.round(next.length / 1024)} KB)`);
}

async function main() {
  // the slate: this week's FBS scoreboard says which week and season it is
  const now = await jsonRequest(`${ESPN}/scoreboard?groups=80&limit=300`);
  const week = Number(now?.week?.number), season = Number(now?.season?.year);
  if (!(week > 0) || !(season > 2000)) throw new Error('ESPN has no college week; leaving the files as they are');
  const weeks = Array.from({ length: week + 1 }, (_, i) => i + 1);
  const boards = await mapLimit(weeks, 4, w => w === week ? now
    : jsonRequest(`${ESPN}/scoreboard?groups=80&limit=300&week=${w}&seasontype=2&dates=${season}`).catch(() => null));
  const slate = slateTeams(boards);
  const espnTeams = (await jsonRequest(`${ESPN}/teams?limit=1000`))?.sports?.[0]?.leagues?.[0]?.teams?.map(x => x.team) || [];
  const teams = teamRows(espnTeams, slate);
  if (Object.keys(teams).length < 100) throw new Error(`Only ${Object.keys(teams).length} college teams resolved; refusing to publish`);
  const ranks = apRanks(await jsonRequest(`${ESPN}/rankings`).catch(() => null));
  if (Object.keys(ranks).length && Object.keys(ranks).length < 25) console.warn(`AP poll has only ${Object.keys(ranks).length} teams`);

  const pageFile = new URL('../../cfb.json', import.meta.url);
  await writeIfChanged(pageFile, { built: new Date().toISOString().slice(0, 10), season, week, teams, ranks, conferences: slate.conferences },
    p => JSON.stringify([p.teams, p.ranks, p.conferences, p.week]) === JSON.stringify([teams, ranks, slate.conferences, week]),
    `cfb.json (${Object.keys(teams).length} teams, ${Object.keys(ranks).length} ranked)`);

  // rosters for everyone on this week's slate and next week's
  const playing = new Set();
  for (const sb of [boards[week - 1], boards[week]]) for (const ev of sb?.events || []) for (const x of ev?.competitions?.[0]?.competitors || []) if (x?.team?.id) playing.add(String(x.team.id));
  const playersFile = new URL('../../cfb-players.json', import.meta.url);
  const previous = await readFile(playersFile, 'utf8').then(JSON.parse).catch(() => null);
  const keep = previous?.season === season ? previous.teams || {} : {};
  const fetched = await mapLimit([...playing], 6, async id => {
    const r = await jsonRequest(`${ESPN}/teams/${id}/roster`).catch(() => null);
    const idx = r ? rosterIndex(r) : null;
    return [id, idx && Object.keys(idx).length ? idx : keep[id] || null];
  });
  const rosters = Object.fromEntries(fetched.filter(([, v]) => v));
  if (Object.keys(rosters).length < Math.min(60, playing.size * 0.6))
    throw new Error(`Only ${Object.keys(rosters).length} of ${playing.size} rosters loaded; leaving cfb-players.json as it is`);
  await writeIfChanged(playersFile, { built: new Date().toISOString().slice(0, 10), season, week, teams: rosters },
    p => p.season === season && JSON.stringify(p.teams) === JSON.stringify(rosters),
    `cfb-players.json (${Object.keys(rosters).length} rosters)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build.mjs')) {
  await main();
}
