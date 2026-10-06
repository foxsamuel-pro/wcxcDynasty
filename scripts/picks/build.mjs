/* Build positions.json — every fantasy-relevant player's position, nothing else.
 *
 *   node scripts/picks/build.mjs
 *
 * The Pick 'em tab shows each matchup's projected points and win probability,
 * and the win probability is position-aware: a quarterback's remaining points
 * are far more predictable than a receiver's, and CLAUDE.md records that a flat
 * factor gave 13% where Sleeper said 16%. So the browser needs each starter's
 * position.
 *
 * Sleeper's only source for that is /v1/players/nfl, which is about 5 MB — far
 * too much to pull into a page just to read 120 positions off it. The projection
 * feed the page already needs carries no position. So the positions are reduced
 * to a flat id -> position map here, at build time, and committed: around 50 KB,
 * cached like any other asset, and no change to the CSP.
 *
 * Positions essentially never change, so a daily rebuild is plenty. A player
 * missing from the file (signed since the last build) falls back to the same
 * default factor the news model uses, rather than breaking the page.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { jsonRequest } from '../news/data.mjs';

const API = 'https://api.sleeper.app';
// Positions that can occupy a lineup slot in this league. IDP and offensive
// line players are on nobody's roster and would double the file for nothing.
export const FANTASY = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/* Position and NFL team per player. The team is needed as well as the position:
   a win probability has to know whether a player's real game has finished,
   because otherwise somebody who underperformed and is already showered keeps
   being credited with points he can never earn. */
export function positionMap(players, keep = FANTASY) {
  const positions = {}, teams = {};
  for (const [id, p] of Object.entries(players || {})) {
    if (!p || !keep.includes(p.position)) continue;
    positions[id] = p.position;
    if (p.team) teams[id] = p.team;
  }
  return { positions, teams };
}

/* ESPN athlete id -> Sleeper player, for the Casino tab's player props. ESPN's
   prop feed identifies a player only by its own athlete id. Props settle from
   Sleeper's weekly stats, so each one needs the Sleeper id.

   Sleeper's espn_id is used where it exists, but it is blank for most players
   who arrived after about 2021 (George Pickens, Jake Ferguson, Emeka Egbuka), so
   the rest are matched from ESPN's own team rosters on name WITHIN THE SAME NFL
   TEAM. That is not the league-wide name matching that sank the KTC attempt:
   two fantasy-position players sharing a normalised name on one roster is
   essentially unheard of, and when it does happen the player is skipped rather
   than guessed — an unmatched player is simply not offered. */
export const ESPN_TEAM = { WSH: 'WAS' };     // ESPN abbreviation -> Sleeper's, where they differ
export const normName = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

export function espnMap(players, rosters = [], keep = ['QB', 'RB', 'WR', 'TE']) {
  const out = {}, byKey = {};
  const nameOf = p => p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
  for (const [id, p] of Object.entries(players || {})) {
    if (!p || !keep.includes(p.position) || !nameOf(p)) continue;
    if (p.espn_id) out[String(p.espn_id)] = { id, name: nameOf(p), team: p.team || null };
    if (p.team) (byKey[`${normName(nameOf(p))}|${p.team}`] ||= []).push(id);
  }
  for (const { team, athletes } of rosters) {
    const t = ESPN_TEAM[team] || team;
    for (const a of athletes || []) {
      if (!a?.id || out[a.id]) continue;
      const hits = byKey[`${normName(a.name)}|${t}`] || [];
      if (hits.length !== 1) continue;                  // none, or ambiguous: not offered
      const p = players[hits[0]];
      out[String(a.id)] = { id: hits[0], name: nameOf(p), team: p.team };
    }
  }
  return out;
}

// Every NFL team's current roster from ESPN, reduced to id and name.
async function espnRosters() {
  const teams = (await jsonRequest('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams'))
    ?.sports?.[0]?.leagues?.[0]?.teams?.map(x => x.team) || [];
  const out = [];
  for (const t of teams) {
    const r = await jsonRequest(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.id}/roster`).catch(() => null);
    const athletes = (r?.athletes || []).flatMap(g => g.items || []).map(a => ({ id: String(a.id), name: a.fullName || a.displayName }));
    out.push({ team: t.abbreviation, athletes });
  }
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
  const players = await jsonRequest(`${API}/v1/players/nfl`);
  const { positions, teams } = positionMap(players);
  const count = Object.keys(positions).length;
  if (count < 1000) throw new Error(`Only ${count} positions resolved; refusing to publish a broken file`);
  if (Object.keys(teams).length < 500) throw new Error('Almost no NFL teams resolved; refusing to publish');

  const file = new URL('../../positions.json', import.meta.url);
  const body = { built: new Date().toISOString().slice(0, 10), count, positions, teams };
  // Don't rewrite an identical file: it would show up as a change every single
  // day and the odds workflow publishes on any diff.
  const previous = await readFile(file, 'utf8').catch(() => null);
  const same = previous && (() => { const p = JSON.parse(previous);
    return JSON.stringify(p.positions) === JSON.stringify(positions)
      && JSON.stringify(p.teams) === JSON.stringify(teams); })();
  if (same) console.log(`positions.json unchanged (${count} players)`);
  else {
    const next = JSON.stringify(body);
    await writeFile(file, next);
    console.log(`wrote positions.json (${count} players, ${Object.keys(teams).length} on a team, `
      + `${Math.round(next.length / 1024)} KB)`);
  }

  const rosters = await espnRosters();
  if (rosters.length < 30) throw new Error(`Only ${rosters.length} ESPN rosters loaded; refusing to publish espn.json`);
  const espn = espnMap(players, rosters);
  if (Object.keys(espn).length < 500) throw new Error('Almost no ESPN ids resolved; refusing to publish espn.json');
  await writeIfChanged(new URL('../../espn.json', import.meta.url),
    { built: new Date().toISOString().slice(0, 10), players: espn },
    p => JSON.stringify(p.players) === JSON.stringify(espn), `espn.json (${Object.keys(espn).length} players)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build.mjs')) {
  await main();
}
