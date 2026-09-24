import { readFile } from 'node:fs/promises';
import { normalizeGames, weekFor } from './schedule.mjs';

const API = 'https://api.sleeper.app';
export async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.json();
}

export async function siteConfig() {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const value = name => {
    const match = html.match(new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`));
    if (!match) throw new Error(`Missing site config: ${name}`);
    return match[1];
  };
  const managerBlock = html.match(/const MANAGERS = \{([\s\S]*?)\};/);
  if (!managerBlock) throw new Error('Missing manager names');
  const managers = Object.fromEntries([...managerBlock[1].matchAll(/(\d+):"([^"]+)"/g)].map(m => [m[1], m[2]]));
  // How the league actually refers to each team in prose. Not derivable from the
  // full name, so it is configured beside the managers.
  const shortBlock = html.match(/const SHORT_NAMES = \{([\s\S]*?)\};/);
  if (!shortBlock) throw new Error('Missing team short names');
  const shortNames = Object.fromEntries([...shortBlock[1].matchAll(/(\d+):"([^"]+)"/g)].map(m => [m[1], m[2]]));
  return { leagueId: value('LEAGUE_ID'), supabaseUrl: value('SUPABASE_URL'),
    supabaseKey: value('SUPABASE_KEY'), managers, shortNames };
}

export function validBallots(rows, rosterIds) {
  const ids = new Set(rosterIds), latest = new Map();
  for (const row of rows) {
    if (!ids.has(row.voter) || !Array.isArray(row.ranking) || row.ranking.length !== ids.size ||
        new Set(row.ranking).size !== ids.size || row.ranking.some(id => !ids.has(id))) continue;
    if (!latest.has(row.voter) || row.updated_at > latest.get(row.voter).updated_at) latest.set(row.voter, row);
  }
  return [...latest.values()];
}

export function pollTable(ballots, teams) {
  if (!ballots.length) return [];
  return teams.map(t => {
    const places = ballots.map(b => b.ranking.indexOf(t.id) + 1);
    return { team: t.id, name: t.name, points: places.reduce((sum, p) => sum + teams.length + 1 - p, 0),
      firstPlaceVotes: places.filter(p => p === 1).length, average: places.reduce((a, b) => a + b, 0) / places.length,
      highest: Math.min(...places), lowest: Math.max(...places), officialPF: t.officialPF };
  }).sort((a, b) => b.points - a.points || b.firstPlaceVotes - a.firstPlaceVotes || b.officialPF - a.officialPF || a.team - b.team)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

export async function loadSnapshot(now, request = jsonRequest) {
  const config = await siteConfig(), base = `${API}/v1/league/${config.leagueId}`;
  const [league, state, rosters, users] = await Promise.all([
    request(base), request(`${API}/v1/state/nfl`), request(`${base}/rosters`), request(`${base}/users`)
  ]);
  const season = Number(league.season);
  if (String(state.season) !== String(season) || state.season_type !== 'regular') return null;
  const week = weekFor(now, state.season_start_date);
  const teams = rosters.map(r => {
    const u = users.find(u => u.user_id === r.owner_id), s = r.settings || {};
    return { id: r.roster_id, name: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
      manager: config.managers[r.roster_id] || 'Manager',
      officialRecord: { wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0 },
      officialPF: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      officialPA: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      roster: r.players || [] };
  }).sort((a, b) => a.id - b.id);
  if (teams.length !== 12) throw new Error('Expected all 12 league rosters');
  const ballotRows = await request(`${config.supabaseUrl}/rest/v1/ballots?select=season,week,voter,ranking,updated_at&season=eq.${season}`,
    { headers: { apikey: config.supabaseKey } });
  if (!Array.isArray(ballotRows)) throw new Error('Ballots unavailable; cannot choose poll versus satire');
  const ballotsByWeek = {};
  for (const w of new Set(ballotRows.map(b => b.week))) {
    ballotsByWeek[w] = validBallots(ballotRows.filter(b => b.week === w), teams.map(t => t.id));
  }
  const weeks = [...new Set([Math.max(1, week - 1), week])];
  const games = (await Promise.all(weeks.map(async w => normalizeGames(await request(`${API}/scores/nfl/regular/${season}/${w}`), w)))).flat();
  if (!games.some(g => g.week === week)) throw new Error('Current NFL schedule unavailable');

  // The scheduler needs to know a trade happened before it can decide to cover
  // one. Sleeper files a transaction under the week it was made, so a Tuesday
  // deal still lands in the previous week's bucket — read both.
  const [txWeeks, nflPlayers, lineups] = await Promise.all([
    Promise.all(weeks.map(w => request(`${base}/transactions/${w}`).catch(() => []))),
    request(`${API}/v1/players/nfl`),
    request(`${base}/matchups/${week}`).catch(() => [])
  ]);
  /* Sleeper's roster totals only move at its own weekly rollover, around Tuesday
     midday — but every game is final at Tuesday 00:00, and articles publish from
     17:00. Writing "2-0" about a team that is 4-0 is exactly the sort of error
     nobody can catch by reading. So compute the record the same way the site
     does: head-to-head plus the league median, for every completed week. */
  const perWeek = league.settings?.league_average_match ? 2 : 1;
  const record = Object.fromEntries(teams.map(t => [t.id,
    { wins: t.officialRecord.wins, losses: t.officialRecord.losses, ties: t.officialRecord.ties,
      pf: t.officialPF, pa: t.officialPA }]));
  const banked = Math.floor((teams[0].officialRecord.wins + teams[0].officialRecord.losses +
    teams[0].officialRecord.ties) / perWeek);
  const caughtUp = [];
  for (let w = banked + 1; w < week; w++) {
    const wk = games.filter(g => g.week === w);
    if (!wk.length || !wk.every(g => g.complete)) break;
    const rows = await request(`${base}/matchups/${w}`).catch(() => []);
    const points = Object.fromEntries((rows || []).map(m => [m.roster_id, m.points]));
    if (Object.keys(points).length !== teams.length) break;
    const pairs = Object.values((rows || []).reduce((acc, m) => {
      if (m.matchup_id != null) (acc[m.matchup_id] ||= []).push(m); return acc; }, {}))
      .filter(p => p.length === 2);
    if (pairs.length !== teams.length / 2) break;
    for (const [a, b] of pairs) {
      record[a.roster_id].pf += a.points; record[a.roster_id].pa += b.points;
      record[b.roster_id].pf += b.points; record[b.roster_id].pa += a.points;
      if (a.points > b.points) { record[a.roster_id].wins++; record[b.roster_id].losses++; }
      else if (b.points > a.points) { record[b.roster_id].wins++; record[a.roster_id].losses++; }
      else { record[a.roster_id].ties++; record[b.roster_id].ties++; }
    }
    if (perWeek === 2) {
      const sorted = Object.values(points).sort((x, y) => x - y), n = sorted.length;
      const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      for (const t of teams) {
        if (points[t.id] > median) record[t.id].wins++;
        else if (points[t.id] < median) record[t.id].losses++;
        else record[t.id].ties++;
      }
    }
    caughtUp.push(w);
  }
  for (const t of teams) {
    t.shortName = config.shortNames[t.id] || t.name;
    t.record = record[t.id];
    t.pointsFor = round(record[t.id].pf);
    t.pointsAgainst = round(record[t.id].pa);
  }

  /* Draft order runs on total max points — optimal-lineup points, not results —
     so the weakest roster picks first and a bad team's pick is the valuable one.
     Projecting this season's pace over the full regular season gives the order
     for NEXT year's draft, which is the only one currently knowable: the 2028
     order is set by a season that has not started. */
  const lastRegularWeek = (league.settings?.playoff_week_start || 15) - 1;
  const weeksPlayed = (teams[0].officialRecord.wins + teams[0].officialRecord.losses +
    teams[0].officialRecord.ties) / perWeek;
  for (const t of teams) {
    const r = rosters.find(x => x.roster_id === t.id)?.settings || {};
    t.maxPoints = round((r.ppts || 0) + (r.ppts_decimal || 0) / 100);
    t.projectedMaxPoints = weeksPlayed > 0 ? round(t.maxPoints / weeksPlayed * lastRegularWeek) : null;
  }
  const order = teams.filter(t => t.projectedMaxPoints != null)
    .sort((a, b) => a.projectedMaxPoints - b.projectedMaxPoints);
  order.forEach((t, i) => { t.projectedPickSlot = i + 1; });
  const draftableSeason = String(season + 1);

  const trades = txWeeks.flat()
    .filter(t => t.type === 'trade' && t.status === 'complete')
    .map(t => ({ id: String(t.transaction_id), at: t.status_updated, teams: t.roster_ids || [] }))
    .sort((a, b) => b.at - a.at);
  // An injury is news when it takes out someone a manager is actually starting.
  // Every roster carries long-term IR stashes; listing those is not a story.
  const OUT = ['Out', 'IR', 'PUP', 'Suspended'];
  const starting = new Map();
  for (const m of Array.isArray(lineups) ? lineups : []) {
    for (const id of m.starters || []) starting.set(String(id), m.roster_id);
  }
  const injuries = [...starting.entries()]
    .filter(([id]) => OUT.includes(nflPlayers?.[id]?.injury_status))
    .map(([id, team]) => ({ key: `${id}:${nflPlayers[id].injury_status}`, playerId: id, team,
      name: nflPlayers[id].full_name || id, pos: nflPlayers[id].position,
      nfl: nflPlayers[id].team || null, status: nflPlayers[id].injury_status }));
  return { config, league, season, week, teams, ballotsByWeek, games, draftableSeason, moves: { trades, injuries } };
}

export function fantasyPoints(stats, scoring) {
  if (!stats || typeof stats !== 'object') return null;
  return Object.entries(scoring).reduce((sum, [key, factor]) => sum + (typeof stats[key] === 'number' ? stats[key] * factor : 0), 0);
}
const round = n => Math.round(n * 100) / 100;
function positionRanks(values, players, scoring) {
  const groups = {};
  for (const [id, stats] of Object.entries(values)) {
    const pos = players[id]?.position;
    if (pos) (groups[pos] ||= []).push({ id, score: fantasyPoints(stats, scoring) });
  }
  return Object.fromEntries(Object.entries(groups).flatMap(([pos, entries]) =>
    entries.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((p, i) => [p.id, `${pos}${i + 1}`])));
}

export async function loadFacts(snapshot, job, request = jsonRequest) {
  const { season, config, league, teams, ballotsByWeek } = snapshot, week = job.week;
  const base = `${API}/v1/league/${config.leagueId}`;
  const [matchups, players, projections, stats, transactions] = await Promise.all([
    request(`${base}/matchups/${week}`), request(`${API}/v1/players/nfl`),
    request(`${API}/v1/projections/nfl/regular/${season}/${week}`),
    request(`${API}/v1/stats/nfl/regular/${season}/${week}`),
    // Sleeper files a transaction under the week it was made, so a Tuesday trade
    // sits in the previous week's bucket. Read both or the story has no facts.
    Promise.all([...new Set([Math.max(1, week - 1), week])].map(w =>
      request(`${base}/transactions/${w}`).catch(() => []))).then(rows => rows.flat())
  ]);
  if (!Array.isArray(matchups) || matchups.length !== teams.length || new Set(matchups.map(m => m.roster_id)).size !== teams.length ||
      matchups.some(m => !teams.some(t => t.id === m.roster_id) || !Number.isFinite(m.points))) {
    throw new Error('Incomplete matchup data; refusing to write a story');
  }
  const games = snapshot.games.filter(g => g.week === week);
  const projectedRanks = positionRanks(projections, players, league.scoring_settings);
  const actualRanks = positionRanks(stats, players, league.scoring_settings);
  const ballots = ballotsByWeek[week] || [], poll = pollTable(ballots, teams);
  const previousPoll = pollTable(ballotsByWeek[week - 1] || [], teams);
  const playerRows = [];
  const sides = matchups.map(m => {
    const team = teams.find(t => t.id === m.roster_id);
    let remaining = 0, variance = 0, remainingKnown = true;
    const starters = (m.starters || []).filter(id => id && id !== '0').map(id => {
      const p = players[id];
      if (!p) throw new Error(`Missing starter metadata: ${id}`);
      const game = games.find(g => g.home === p.team || g.away === p.team);
      const projection = fantasyPoints(projections[id], league.scoring_settings);
      const scored = m.players_points?.[id] ?? 0;
      const left = !game || game.complete ? 0 : projection === null ? null : Math.max(0, projection - scored);
      if (left === null) remainingKnown = false;
      else {
        remaining += left;
        const factor = ({ QB: 0.55, RB: 0.75, WR: 0.85, TE: 0.80 })[p.position] || 0.75;
        variance += (factor * left) ** 2;
      }
      const row = { id, team: m.roster_id, name: p.full_name || `${p.first_name} ${p.last_name}`, pos: p.position,
        nfl: p.team || '', score: round(scored), projection: projection === null ? null : round(projection),
        actualRank: actualRanks[id] || null, projectedRank: projectedRanks[id] || null,
        gameId: game?.id || null, gameComplete: !!game?.complete, gameStatus: game?.status || 'bye / no game',
        remaining: left === null ? null : round(left), injuryStatus: p.injury_status || null };
      playerRows.push(row);
      return row;
    });
    // Only the ids: every one of these rows is already in facts.players, and
    // writing them twice doubled the assignment the writer has to read.
    return { team: m.roster_id, name: team.name, pollRank: poll.find(t => t.team === m.roster_id)?.rank || null,
      matchupId: m.matchup_id, score: m.points, projection: remainingKnown ? round(m.points + remaining) : null,
      variance: remainingKnown ? variance : null, final: starters.every(p => !p.gameId || p.gameComplete),
      starters: starters.map(p => p.id) };
  });
  const pairs = Object.values(Object.groupBy(sides.filter(s => s.matchupId != null), s => s.matchupId))
    .filter(pair => pair.length === 2).map(([a, b]) => {
      const margin = round(a.score - b.score);
      const favorite = a.pollRank && b.pollRank ? (a.pollRank < b.pollRank ? a : b) : null;
      const underdog = favorite === a ? b : a;
      const upset = favorite ? underdog.score > favorite.score : false;
      return { teams: [a.team, b.team], sides: [a, b], margin, upset,
        drama: round((upset ? 30 : 0) + 100 / (1 + Math.abs(margin)) + (a.score + b.score) / 30),
        final: a.final && b.final };
    }).sort((a, b) => b.drama - a.drama);
  const scores = sides.map(s => s.score).sort((a, b) => a - b);
  const median = round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2);
  const trades = transactions.filter(t => t.type === 'trade' && t.status === 'complete').map(t => ({
    id: t.transaction_id, completedAt: t.status_updated, teams: t.roster_ids,
    adds: Object.entries(t.adds || {}).map(([id, team]) => ({ team, player: players[id]?.full_name || id })),
    draftPicks: t.draft_picks || [], waiverBudget: t.waiver_budget || []
  }));
  const injuries = playerRows.filter(p => ['Out', 'IR', 'Doubtful', 'PUP', 'Suspended'].includes(p.injuryStatus));
  return { season, week, slot: job.slot, brief: job.brief, games, focusGameIds: job.gameIds || [],
    draftableSeason: snapshot.draftableSeason,
    teams: teams.map(({ roster, ...team }) => team), ballotCount: ballots.length, poll, previousPoll,
    ballots: ballots.map(b => ({ manager: teams.find(t => t.id === b.voter)?.manager, voter: b.voter, ranking: b.ranking })),
    matchups: pairs, players: playerRows, median, medianMatch: !!league.settings?.league_average_match,
    trades, injuries, recordsNote: 'Official roster totals can lag final games. Do not describe them as updated standings. Matchup scores are current.' };
}
