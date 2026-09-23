import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { jsonRequest, siteConfig } from '../news/data.mjs';
import { addWeek, scoreStats, mean, variance, fitAlpha, rankingLoss, MODEL_VERSION } from './model.mjs';

const API = 'https://api.sleeper.app';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get = path => jsonRequest(`${API}${path}`);
export async function mapLimit(items, task, count = 4) {
  const out = new Array(items.length); let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await task(items[i], i); }
  }));
  const failed = workers.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;
  return out;
}
const positions = ['QB', 'RB', 'WR', 'TE'];
const depth = { QB: 48, RB: 100, WR: 140, TE: 80 };
const complete = g => g.status === 'complete' || g.metadata?.is_over === true;
const gameTeams = games => games.flatMap(g => [g.metadata?.home_team, g.metadata?.away_team]).filter(Boolean);
export function pairsFor(rows, count) {
  const groups = {};
  for (const r of rows) if (r.matchup_id != null) (groups[r.matchup_id] ||= []).push(r.roster_id);
  const pairs = Object.values(groups);
  if (pairs.length !== count / 2 || pairs.some(p => p.length !== 2) || new Set(pairs.flat()).size !== count)
    throw new Error('Incomplete fantasy matchup schedule');
  return pairs;
}

export async function loadHistory(season, scoring, players) {
  const years = [season - 3, season - 2, season - 1];
  const key = hash({ years, scoring, version: MODEL_VERSION });
  const file = new URL(`../../.odds-cache/history-${key}.json`, import.meta.url);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    for (const h of Object.values(cached.positions)) h.validation = validateRanking(h.seasons);
    return cached;
  } catch { /* build once */ }
  const cohorts = Object.fromEntries(positions.map(p => [p, []]));
  for (const year of years) {
    console.log(`Loading historical player scoring: ${year}`);
    const [projection, stats] = await Promise.all([
      get(`/v1/projections/nfl/regular/${year}`),
      mapLimit(Array.from({ length: 18 }, (_, i) => i + 1), w => get(`/v1/stats/nfl/regular/${year}/${w}`))
    ]);
    if (stats.some(s => Object.keys(s || {}).length < 100)) throw new Error(`Missing historical stats: ${year}`);
    for (const pos of positions) {
      const ranked = Object.keys(projection).filter(id => players[id]?.position === pos && scoreStats(projection[id], scoring) > 0)
        .sort((a, b) => scoreStats(projection[b], scoring) - scoreStats(projection[a], scoring)).slice(0, depth[pos]);
      const rows = ranked.map((id, i) => {
        // Games with offensive snaps include low-scoring appearances, never byes.
        const points = stats.filter(s => s[id]?.off_snp > 0).map(s => scoreStats(s[id], scoring));
        return { rank: i + 1, games: points.length, mu: mean(points), v: variance(points) };
      }).filter(p => p.games >= 4);
      if (rows.length < (pos === 'QB' ? 20 : 30)) throw new Error(`Insufficient ${year} ${pos} history`);
      const pooled = mean(rows.map(p => p.v));
      for (const p of rows) {
        // Short samples cannot supply an implausibly certain weekly profile.
        p.sd = Math.sqrt(((p.games - 1) * p.v + 8 * pooled) / (p.games - 1 + 8));
        delete p.v;
      }
      cohorts[pos].push(rows);
    }
  }
  const result = { years, scoringHash: hash(scoring), version: MODEL_VERSION, positions: {} };
  for (const pos of positions) {
    const seasons = cohorts[pos];
    // Restrict absence estimation to established roles. Missing games include
    // injury AND benching; the raw stat feed cannot distinguish the two.
    const established = seasons.flat().filter(p => p.games >= 8 && p.rank <= ({ QB: 24, RB: 48, WR: 72, TE: 24 })[pos]);
    const missed = established.reduce((s, p) => s + Math.max(0, 17 - p.games), 0);
    const hazard = (missed + 1) / (17 * established.length + 10);
    result.positions[pos] = { seasons, alpha: fitAlpha(seasons), hazard, recovery: 1 - hazard,
      profiles: seasons.reduce((n, a) => n + a.length, 0), absencePlayerSeasons: established.length,
      validation: validateRanking(seasons) };
  }
  await mkdir(new URL('../../.odds-cache/', import.meta.url), { recursive: true });
  await writeFile(file, JSON.stringify(result));
  return result;
}

function validateRanking(seasons) {
  const alpha = fitAlpha(seasons.slice(0, -1)), heldOut = seasons.at(-1);
  return { trainingAlpha: alpha, heldOutPlayers: heldOut.length,
    heldOutLoss: rankingLoss(heldOut, alpha), uniformLoss: rankingLoss(heldOut, 0) };
}

export async function loadInput({ request = get, historyLoader = loadHistory, configLoader = siteConfig } = {}) {
  const get = request;
  const { leagueId } = await configLoader(), base = `/v1/league/${leagueId}`;
  const [league, rosters, players, bracket] = await Promise.all([
    get(base), get(`${base}/rosters`), get('/v1/players/nfl'), get(`${base}/winners_bracket`)
  ]);
  const settings = league.settings, season = Number(league.season);
  if (settings.divisions !== 3 || settings.playoff_teams !== 6 || settings.playoff_round_type !== 0 || settings.playoff_type !== 0 || settings.best_ball)
    throw new Error('League format changed; review playoff model before publishing');
  const lastRegular = settings.playoff_week_start - 1, lastWeek = lastRegular + 3;
  if (lastWeek > 18 || rosters.length !== 12) throw new Error('Unsupported season length or roster count');
  const slots = league.roster_positions.filter(p => !['BN', 'IR', 'TAXI'].includes(p));
  if (slots.some(p => !['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WR_RB_FLEX'].includes(p)))
    throw new Error('Unsupported starting position');
  const medianMatch = Boolean(settings.league_average_match), perWeek = medianMatch ? 2 : 1;
  const teams = rosters.map(r => {
    const s = r.settings;
    return { id: r.roster_id, div: s.division, players: (r.players || []).filter(id => !(r.taxi || []).includes(id)),
      record: { w: s.wins || 0, l: s.losses || 0, t: s.ties || 0,
        pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100, pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100 } };
  }).sort((a, b) => a.id - b.id);
  const played = teams.map(t => (t.record.w + t.record.l + t.record.t) / perWeek);
  if (played.some(n => !Number.isInteger(n) || n !== played[0]) || new Set(teams.map(t => t.div)).size !== 3)
    throw new Error('Inconsistent standings or divisions');
  let firstOpen = Math.min(lastRegular, played[0]) + 1;
  const weeks = {};
  await mapLimit(Array.from({ length: lastWeek - firstOpen + 1 }, (_, i) => firstOpen + i), async w => {
    const [gamesRaw, matchups] = await Promise.all([get(`/scores/nfl/regular/${season}/${w}`), get(`${base}/matchups/${w}`)]);
    const games = Object.values(gamesRaw || {}).filter(g => !g.metadata?.canceled);
    if (!games.length || gameTeams(games).length !== games.length * 2) throw new Error(`Missing NFL schedule: week ${w}`);
    if (games.some(g => g.status === 'in_progress' || g.metadata?.is_in_progress))
      throw new Error('NFL games in progress; preserve last complete snapshot and retry later');
    weeks[w] = { active: gameTeams(games), finished: gameTeams(games.filter(complete)),
      complete: games.every(complete), pairs: w <= lastRegular ? pairsFor(matchups, teams.length) : [], locked: {}, lockedSlots: {}, matchups };
  });
  while (firstOpen <= lastRegular && weeks[firstOpen].complete) {
    const wk = weeks[firstOpen], points = Object.fromEntries(wk.matchups.map(m => [m.roster_id, m.points]));
    if (teams.some(t => !Number.isFinite(points[t.id]))) throw new Error('Missing completed fantasy scores');
    addWeek(Object.fromEntries(teams.map(t => [t.id, t.record])), points, wk.pairs, medianMatch);
    delete weeks[firstOpen++];
  }
  const projectionWeeks = await mapLimit(Object.keys(weeks), async w => {
    const projection = await get(`/v1/projections/nfl/regular/${season}/${w}`);
    if (Object.keys(projection || {}).length < 100) throw new Error(`Missing projections: week ${w}`);
    return [w, projection];
  });
  const projections = Object.fromEntries(projectionWeeks);
  const candidateIds = new Set(teams.flatMap(t => t.players));
  for (const wk of Object.values(weeks)) for (const m of wk.matchups) {
    const locked = {}, lockedSlots = {};
    for (const [slot, id] of (m.starters || []).entries()) if (id !== '0' && wk.finished.includes(players[id]?.team)) {
      const points = m.players_points?.[id];
      if (!Number.isFinite(points)) throw new Error('Missing locked player score');
      locked[id] = points; lockedSlots[id] = slot; candidateIds.add(id);
    }
    wk.locked[m.roster_id] = locked;
    wk.lockedSlots[m.roster_id] = lockedSlots;
    if (wk.complete) (wk.finalPoints ||= {})[m.roster_id] = m.points;
    delete wk.matchups;
  }
  // Include free agents in the lottery, so the talent pool is independent of
  // which fantasy team happens to own a player. Taxi players never enter a lineup.
  for (const proj of Object.values(projections)) for (const id of Object.keys(proj)) if (scoreStats(proj[id], league.scoring_settings) > 0) candidateIds.add(id);
  const current = [...candidateIds].filter(id => positions.includes(players[id]?.position)).map(id => {
    const p = players[id], weekly = Object.fromEntries(Object.entries(projections).map(([w, data]) => [w, scoreStats(data[id], league.scoring_settings)]));
    return { id, pos: p.position, positions: p.fantasy_positions || [p.position], team: p.team, weekly,
      projected: mean(Object.entries(weekly).filter(([w, n]) => n > 0 && weeks[w].active.includes(p.team)).map(([, n]) => n)) };
  });
  const history = await historyLoader(season, league.scoring_settings, players);
  // A zero-forecast player still exists on the roster but cannot consume a high
  // PPG profile in the lottery. Locked historical starters remain represented.
  const lockedIds = new Set(Object.values(weeks).flatMap(w => Object.values(w.locked).flatMap(Object.keys)));
  const pool = current.filter(p => p.projected > 0 || lockedIds.has(p.id));
  return { leagueId, season, lastRegular, lastWeek, firstOpen, teams, players: pool,
    history, slots, weeks, medianMatch, reseed: settings.playoff_seed_type === 1, bracket: bracket || [] };
}
