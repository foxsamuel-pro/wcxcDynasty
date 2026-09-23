/* Build projections.json — each team's projected lineup points for every
 * remaining regular-season week.
 *
 *   node scripts/projections.mjs
 *
 * Playoff odds are a forecast, so they must be built from what a roster is
 * projected to score, not from what it happened to score. Two unlucky weeks had
 * Parkers Dead Sons rated eighth in the league when their roster projects third.
 *
 * Done here rather than in the browser because it needs a week of projections
 * for every remaining week plus Sleeper's 5MB player index. The page reads a
 * few KB instead.
 */
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.sleeper.app';
const get = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};
const FLEX = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'] };

export function lineupPoints(playerIds, position, points, slots) {
  const pool = playerIds.map(id => ({ id, pos: position(id), pts: points(id) || 0 }))
    .filter(p => p.pos).sort((a, b) => b.pts - a.pts);
  const used = new Set();
  let total = 0;
  const fill = eligible => {
    const p = pool.find(x => !used.has(x.id) && eligible.includes(x.pos));
    if (p) { used.add(p.id); total += p.pts; }
  };
  for (const s of slots) if (!FLEX[s]) fill([s]);   // strict slots take their best first
  for (const s of slots) if (FLEX[s]) fill(FLEX[s]); // flex takes whoever is left
  return Math.round(total * 100) / 100;
}

/* The publisher runs every 15 minutes; projections do not move nearly that fast,
 * and rewriting the file each time would mean a commit and a site rebuild every
 * quarter hour. Skip unless the file is actually old. */
async function isFresh(hours) {
  try {
    const cur = JSON.parse(await readFile(new URL('../projections.json', import.meta.url), 'utf8'));
    const age = (Date.now() - Date.parse(cur.generated)) / 3600000;
    return Number.isFinite(age) && age >= 0 && age < hours;
  } catch { return false; }
}

async function main() {
  const stale = process.argv.indexOf('--if-older-than');
  if (stale > -1 && await isFresh(Number(process.argv[stale + 1]) || 6)) {
    console.log('projections.json is still fresh; nothing to do');
    return;
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const leagueId = html.match(/const LEAGUE_ID\s*=\s*"([^"]+)"/)?.[1];
  if (!leagueId) throw new Error('Missing LEAGUE_ID');

  const [league, state, rosters, players] = await Promise.all([
    get(`${API}/v1/league/${leagueId}`), get(`${API}/v1/state/nfl`),
    get(`${API}/v1/league/${leagueId}/rosters`), get(`${API}/v1/players/nfl`)
  ]);
  const season = Number(league.season);
  const lastWeek = (league.settings?.playoff_week_start || 15) - 1;
  const slots = (league.roster_positions || []).filter(p => !['BN', 'IR', 'TAXI'].includes(p));
  const scoring = league.scoring_settings;
  const score = s => { if (!s) return 0; let t = 0; for (const k in scoring)
    if (typeof s[k] === 'number') t += s[k] * scoring[k]; return t; };
  const position = id => players[id]?.position;

  /* Taxi players cannot be started without being promoted, and nothing in the
     weekly data ever says whether that happened — so they are dropped.
     IR is deliberately NOT dropped. Sleeper's per-week projections already
     carry the injury timeline: a player who is out projects 0 for the weeks he
     misses and his normal number for the weeks he is back, and a season-ending
     injury projects 0 throughout. Excluding him outright would dock a team for
     every remaining week over an injury lasting two, which is the whole reason
     this model is built per week rather than per season. */
  const bench = Object.fromEntries(rosters.map(r =>
    [r.roster_id, new Set(r.taxi || [])]));
  const startable = (rosterId, ids) =>
    (ids || []).filter(id => !bench[rosterId]?.has(id));

  const firstOpen = state.season_type === 'regular' ? Math.max(1, Number(state.week) || 1) : 1;
  const weeks = [];
  for (let w = firstOpen; w <= lastWeek; w++) weeks.push(w);
  if (!weeks.length) throw new Error('No remaining regular-season weeks');

  /* Sleeper's projections sit well above what teams really score: measured over
     the completed weeks of this league, a full lineup returns about 79% of what
     it was projected for. Most of that is the projections themselves — the same
     ratio against the lineups managers actually started is ~0.80 — because a
     projection is a healthy-player number and real weeks contain duds and
     inactives. Rescale so the simulation runs on the points scale the league
     really plays at; otherwise team separation is overstated against the weekly
     noise, and the odds come out harder than the evidence supports.
     Measured against the lineups managers actually started the ratio is about
     the same, so this is the projections being optimistic, not bad start/sit. */
  let actual = 0, projected = 0;
  const raw = {};
  for (let w = 1; w < firstOpen; w++) {
    const [rows, proj] = await Promise.all([
      get(`${API}/v1/league/${leagueId}/matchups/${w}`).catch(() => []),
      get(`${API}/v1/projections/nfl/regular/${season}/${w}`).catch(() => ({}))
    ]);
    if (!rows?.length) continue;
    raw[w] = {};
    for (const m of rows) {
      const p = lineupPoints(startable(m.roster_id, m.players), position, id => score(proj[id]), slots);
      actual += m.points || 0;
      projected += p;
      raw[w][m.roster_id] = { actual: m.points || 0, proj: p };
    }
  }
  const scale = projected > 0 ? actual / projected : 1;

  // Completed weeks, projection put on the same scale as the result. The page
  // uses the spread of these residuals to decide how far to trust a projection:
  // if nobody beats their number repeatably, the misses are weekly bounce.
  const history = {};
  for (const w of Object.keys(raw)) {
    history[w] = Object.fromEntries(Object.entries(raw[w]).map(([id, v]) =>
      [id, { actual: Math.round(v.actual * 100) / 100, proj: Math.round(v.proj * scale * 100) / 100 }]));
  }

  const byWeek = {};
  for (const w of weeks) {
    const proj = await get(`${API}/v1/projections/nfl/regular/${season}/${w}`).catch(() => ({}));
    byWeek[w] = Object.fromEntries(rosters.map(r =>
      [r.roster_id, Math.round(lineupPoints(startable(r.roster_id, r.players), position,
        id => score(proj[id]), slots) * scale * 100) / 100]));
  }

  const out = { generated: new Date().toISOString(), season, firstOpen, lastWeek,
    scale: Math.round(scale * 1e4) / 1e4,
    note: 'Projected lineup points per team per remaining week, league scoring, ' +
          'best legal lineup, rescaled to the league\'s observed scoring level.',
    weeks: byWeek, history };
  await writeFile(new URL('../projections.json', import.meta.url), `${JSON.stringify(out)}\n`);
  const avg = id => weeks.reduce((a, w) => a + byWeek[w][id], 0) / weeks.length;
  console.log(`weeks ${weeks[0]}-${lastWeek}, scale ${out.scale}`);
  for (const r of [...rosters].sort((a, b) => avg(b.roster_id) - avg(a.roster_id))) {
    console.log(`  roster ${String(r.roster_id).padStart(2)}  ${avg(r.roster_id).toFixed(1)}/wk`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('projections.mjs')) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
