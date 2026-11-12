// Builds stats.json: every season of league history in the raw shape the Stats
// tab works from. Run daily by odds.yml.
//
// It stores what Sleeper says, not conclusions. Each week is a list of
// [roster_id, matchup_id, points]; the brackets are copied as they are. The page
// turns that into records, games and leaderboards itself, so it can re-cut the
// same history by season, week, phase and median without another file. It also
// refreshes the current season live in the same raw shape, which is why the
// parsing lives in one place (index.html) and not here.
//
// Franchise identity is the roster id, as in the trade archive. Sleeper only
// keeps each user's current team name, so the page always shows today's names;
// `owner` lets it note a season played under a previous manager.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { jsonRequest, siteConfig } from '../news/data.mjs';

const API = 'https://api.sleeper.app';

export async function buildStats(get = path => jsonRequest(`${API}${path}`)) {
  const { leagueId } = await siteConfig();
  const seasons = [];
  for (let id = leagueId; id && id !== '0';) {
    const league = await get(`/v1/league/${id}`);
    if (!league) break;
    const s = league.settings || {};
    const [rosters, wb, lb] = await Promise.all([
      get(`/v1/league/${id}/rosters`), get(`/v1/league/${id}/winners_bracket`), get(`/v1/league/${id}/losers_bracket`)]);
    // Weeks past the last scored one are zeros for everyone, not results.
    const last = Math.min(s.last_scored_leg || 0, 18);
    const weeks = {};
    await Promise.all(Array.from({ length: last }, (_, i) => i + 1).map(async w => {
      const d = await get(`/v1/league/${id}/matchups/${w}`);
      if (Array.isArray(d) && d.length) weeks[w] = d.map(m => [m.roster_id, m.matchup_id ?? null, +(m.points || 0).toFixed(2)]);
    }));
    seasons.push({
      season: +league.season, leagueId: id, status: league.status,
      playoffStart: s.playoff_week_start || 15, playoffTeams: s.playoff_teams || 6,
      // 0: one week a round; 1: two-week final; 2: two weeks every round
      roundType: s.playoff_round_type || 0, median: !!s.league_average_match, lastScored: last,
      teams: Object.fromEntries((rosters || []).map(r => [r.roster_id, {
        owner: r.owner_id,
        // Sleeper's own totals, kept so the tests can prove the page counts them the same way
        rec: [r.settings?.wins || 0, r.settings?.losses || 0, r.settings?.ties || 0]
      }])),
      weeks, wb: wb || [], lb: lb || []
    });
    id = league.previous_league_id;
  }
  if (!seasons.length) throw new Error('No league seasons came back from Sleeper');
  // No timestamp: the daily job commits only when a result actually changed.
  return { seasons: seasons.reverse() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stats = await buildStats();
  await writeFile(new URL('../../stats.json', import.meta.url), JSON.stringify(stats));
  console.log('stats.json:', stats.seasons.map(s => `${s.season} (${Object.keys(s.weeks).length} weeks)`).join(', '));
}
