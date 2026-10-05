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
  if (same) { console.log(`positions.json unchanged (${count} players)`); return; }
  const next = JSON.stringify(body);
  await writeFile(file, next);
  console.log(`wrote positions.json (${count} players, ${Object.keys(teams).length} on a team, `
    + `${Math.round(next.length / 1024)} KB)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build.mjs')) {
  await main();
}
