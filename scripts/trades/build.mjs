/* Build trades.json — every trade in league history, with what each side got,
 * what the picks became, and what it has all scored since.
 *
 *   node scripts/trades/build.mjs
 *
 * ATTRIBUTION. A trade's return is the points scored, after the trade, by the
 * players received plus the players actually drafted with the picks received.
 * That is exact and it never double-counts.
 *
 * It deliberately stops there. If you trade a pick on for somebody else, those
 * points belong to the later trade, not this one — otherwise two trades claim
 * the same points and every chain eventually credits one ancient deal with the
 * whole roster. What the chain gets instead is a `trail`: each asset records
 * where it went next, so the lineage is visible without inventing a number for
 * it.
 *
 * Unplayed drafts (2027, 2028) resolve to nothing and are reported pending.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { jsonRequest, siteConfig } from '../news/data.mjs';

const API = 'https://api.sleeper.app';
const CACHE = new URL('../../.trade-cache/', import.meta.url);
const key = path => path.replace(/[^a-zA-Z0-9]+/g, '_') + '.json';

let live = 0;
async function get(path, { cache = false } = {}) {
  if (cache) {
    try { return JSON.parse(await readFile(new URL(key(path), CACHE), 'utf8')); } catch { /* miss */ }
  }
  live++;
  const value = await jsonRequest(`${API}${path}`).catch(() => null);
  if (cache && value) await writeFile(new URL(key(path), CACHE), JSON.stringify(value));
  return value;
}

export const scoreStats = (stats, scoring) => {
  if (!stats) return 0;
  let total = 0;
  for (const k in scoring) if (typeof stats[k] === 'number') total += stats[k] * scoring[k];
  return Math.round(total * 100) / 100;
};

/* A pick is (season, round, original owner). Sleeper's draft exposes
   slot_to_roster_id, so the original owner gives the draft slot, and the slot
   plus round gives the pick that was actually made. */
export function resolvePick(pick, draft, picks) {
  if (!draft?.slot_to_roster_id || !picks?.length) return null;
  const slot = Object.entries(draft.slot_to_roster_id).find(([, roster]) => roster === pick.roster_id)?.[0];
  if (!slot) return null;
  return picks.find(p => p.round === pick.round && String(p.draft_slot) === String(slot)) || null;
}

const pickId = p => `${p.season}-${p.round}-${p.roster_id}`;

async function main() {
  await mkdir(CACHE, { recursive: true });
  const { leagueId } = await siteConfig();

  // Walk the league back through every season it has existed.
  const seasons = [];
  for (let id = leagueId; id && id !== '0';) {
    const league = await get(`/v1/league/${id}`);
    if (!league) break;
    seasons.push({ season: Number(league.season), id, scoring: league.scoring_settings, teams: league.total_rosters });
    id = league.previous_league_id;
  }
  seasons.reverse();
  console.log('seasons:', seasons.map(s => `${s.season} (${s.teams} teams)`).join(', '));

  const players = await get('/v1/players/nfl', { cache: true });
  const state = await get('/v1/state/nfl');
  const current = seasons.at(-1);

  // Franchises are roster ids; they are stable here, but a manager can change
  // hands, and crediting today's manager with a predecessor's trade is wrong.
  const franchises = {};
  for (const s of seasons) {
    const [rosters, users] = await Promise.all([
      get(`/v1/league/${s.id}/rosters`), get(`/v1/league/${s.id}/users`)]);
    s.owners = {};
    for (const r of rosters || []) {
      const u = (users || []).find(x => x.user_id === r.owner_id);
      s.owners[r.roster_id] = r.owner_id;
      if (s === current) franchises[r.roster_id] = { id: r.roster_id, owner: r.owner_id,
        name: u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}` };
    }
  }

  /* A season can hold more than one draft. 2023 had a 25-round startup in
     February and a 5-round rookie draft in May, and "a 2023 3rd" meant the
     startup before February and the rookie draft after it. So keep every draft
     and pick the one that was still to come when the trade was made. */
  for (const s of seasons) {
    const list = await get(`/v1/league/${s.id}/drafts`) || [];
    s.drafts = [];
    for (const d of list) {
      const picks = await get(`/v1/draft/${d.draft_id}/picks`, { cache: true });
      if (!picks?.length) continue;
      const draft = await get(`/v1/draft/${d.draft_id}`, { cache: true });
      if (draft) s.drafts.push({ draft, picks, rounds: draft.settings?.rounds || 0,
        start: draft.start_time || 0, ended: draft.last_picked || draft.start_time || 0 });
    }
    s.drafts.sort((a, b) => a.start - b.start);
  }

  // The draft a traded pick refers to: deep enough for the round, and not
  // already finished when the trade happened.
  const draftFor = (pick, at) => {
    const s = seasons.find(x => x.season === Number(pick.season));
    if (!s) return null;
    for (const d of s.drafts) {
      if (d.rounds < pick.round || (d.ended && d.ended < at)) continue;
      const made = resolvePick(pick, d.draft, d.picks);
      if (made) return made;
    }
    return null;
  };

  // Weekly fantasy points per player, per season, under that season's scoring.
  for (const s of seasons) {
    s.weekly = {};
    const done = s.season < current.season || state.season_type !== 'regular' ? 18 : Number(state.week) || 1;
    for (let w = 1; w <= 18; w++) {
      const complete = s.season < current.season || w < done;
      const stats = await get(`/v1/stats/nfl/regular/${s.season}/${w}`, { cache: complete });
      s.weekly[w] = {};
      for (const id in stats || {}) {
        const pts = scoreStats(stats[id], s.scoring);
        if (pts) s.weekly[w][id] = pts;
      }
    }
  }

  // Every completed trade, in order.
  const trades = [];
  for (const s of seasons) {
    for (let w = 0; w <= 18; w++) {
      const rows = await get(`/v1/league/${s.id}/transactions/${w}`) || [];
      for (const t of rows) {
        if (t.type !== 'trade' || t.status !== 'complete') continue;
        trades.push({ id: String(t.transaction_id), season: s.season, week: w, at: t.created,
          rosters: t.roster_ids || [], adds: t.adds || {}, picks: t.draft_picks || [],
          budget: t.waiver_budget || [] });
      }
    }
  }
  trades.sort((a, b) => a.at - b.at);
  console.log(`trades: ${trades.length}`);

  // Points a player has scored strictly after a given trade.
  const pointsAfter = (playerId, season, week) => {
    let total = 0;
    for (const s of seasons) {
      if (s.season < season) continue;
      for (let w = 1; w <= 18; w++) {
        if (s.season === season && w <= week) continue;
        total += s.weekly[w]?.[playerId] || 0;
      }
    }
    return Math.round(total * 100) / 100;
  };

  // Where each pick went next, so a chain is visible even though it is not scored.
  const pickMoves = {};
  for (const t of trades) for (const p of t.picks) (pickMoves[pickId(p)] ||= []).push(t.id);

  const seasonOf = y => seasons.find(s => s.season === Number(y));
  const out = [];
  let resolved = 0, pending = 0;
  for (const t of trades) {
    const sides = t.rosters.map(roster => {
      const gotPlayers = Object.entries(t.adds).filter(([, r]) => r === roster).map(([id]) => id);
      const gotPicks = t.picks.filter(p => p.owner_id === roster);
      const playerRows = gotPlayers.map(id => ({ id, name: players[id]?.full_name
        || [players[id]?.first_name, players[id]?.last_name].filter(Boolean).join(' ') || id,
        pos: players[id]?.position || null, points: pointsAfter(id, t.season, t.week) }));
      const pickRows = gotPicks.map(p => {
        const made = draftFor(p, t.at);
        const moves = (pickMoves[pickId(p)] || []).filter(x => x !== t.id);
        if (made) resolved++; else pending++;
        return { season: p.season, round: p.round, from: p.roster_id,
          became: made ? { id: made.player_id,
            name: players[made.player_id]?.full_name || made.player_id,
            pos: players[made.player_id]?.position || null, pickNo: made.pick_no,
            points: pointsAfter(made.player_id, t.season, t.week) } : null,
          // a pick with no draft yet is pending; one traded on again is a chain
          movedOn: moves.length ? moves : undefined };
      });
      const points = Math.round((playerRows.reduce((a, p) => a + p.points, 0)
        + pickRows.reduce((a, p) => a + (p.became?.points || 0), 0)) * 100) / 100;
      const budget = t.budget.filter(b => b.receiver === roster).reduce((a, b) => a + b.amount, 0);
      return { team: roster, manager: franchises[roster]?.name || `Roster ${roster}`,
        sameManager: seasonOf(t.season)?.owners?.[roster] === franchises[roster]?.owner,
        players: playerRows, picks: pickRows, ...(budget ? { budget } : {}), points };
    });

    // Sleeper occasionally records only one side's return. Those are still real
    // trades and dropping them silently would leave gaps in the archive, so they
    // stay, flagged, with the empty side shown as exactly that.
    const withAssets = sides.filter(s => s.players.length || s.picks.length || s.budget);
    if (sides.length >= 2 && withAssets.length >= 1) {
      const oneSided = withAssets.length < 2;
      const best = Math.max(...sides.map(s => s.points));
      out.push({ id: t.id, season: t.season, week: t.week, date: new Date(t.at).toISOString().slice(0, 10),
        sides, ...(oneSided ? { oneSided: true } : {}),
        winner: !oneSided && sides.filter(s => s.points === best).length === 1
          ? sides.find(s => s.points === best).team : null,
        margin: oneSided ? null : Math.round((best - Math.min(...sides.map(s => s.points))) * 100) / 100,
        pendingPicks: sides.reduce((n, s) => n + s.picks.filter(p => !p.became).length, 0) });
    }
  }

  const file = { generated: new Date().toISOString(), seasons: seasons.map(s => s.season),
    franchises, trades: out.reverse(),
    note: 'Points are what each side has scored SINCE the trade: players received, plus the '
        + 'players actually drafted with picks received. Assets traded on again count toward '
        + 'that later trade, not this one.' };
  await writeFile(new URL('../../trades.json', import.meta.url), JSON.stringify(file) + '\n');
  console.log(`picks resolved to a drafted player: ${resolved}; still pending a draft: ${pending}`);
  console.log(`wrote trades.json (${Math.round(JSON.stringify(file).length / 1024)} KB), ${live} live requests`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
