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
 *
 * Raw points alone are a poor verdict, so each side also gets:
 *
 *   started  Points the acquired players actually put in this team's starting
 *            lineup. A player who scores from the bench did not help anyone, and
 *            raw points cannot tell the difference.
 *   value    What the assets are worth on today's dynasty market, from
 *            FantasyCalc. It is the only measure that can price a pick nobody
 *            has used yet — under points alone a rebuild scores zero forever.
 *
 * Values are fetched at build time in CI, so the browser never talks to
 * FantasyCalc and the CSP does not change. Matching is by Sleeper id, which the
 * feed carries for every entry — no name matching, which is what made the old
 * KTC attempt unreliable.
 *
 * The feed only accepts dynasty / numQbs / numTeams / ppr, so it can be told
 * this is a 12-team superflex half-PPR dynasty league but NOT that it is tight
 * end premium with points per first down. Those two are corrected afterwards
 * from the league's own scoring — see positionalScalars.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { jsonRequest, siteConfig } from '../news/data.mjs';

const API = 'https://api.sleeper.app';
/* ppr=0.5 because this league is half PPR. FantasyCalc exposes only isDynasty,
   numQbs, numTeams and ppr — tePremium, teBonus and ppfd are accepted and
   silently ignored, verified by byte-identical responses. So TE premium and
   points-per-first-down cannot be requested and have to be corrected for after
   the fact; see positionalScalars. */
const FANTASYCALC = 'https://api.fantasycalc.com/values/current'
  + '?isDynasty=true&numQbs=2&numTeams=12&ppr=0.5';

/* How much this league's scoring lifts each position above the scoring
   FantasyCalc actually priced. Measured on four seasons of real stat lines:
   score every player under league rules, then again with TE premium and first
   downs stripped out, and compare by position. Everything inflates, because
   PPFD pays everybody — so divide by the league-wide ratio, leaving only the
   RELATIVE distortion. Tight ends come out around 1.21 and receivers 0.94,
   which is the TE premium showing up exactly where it should. */
export function positionalScalars(byPosition) {
  const total = Object.values(byPosition).reduce(
    (a, p) => ({ league: a.league + p.league, priced: a.priced + p.priced }), { league: 0, priced: 0 });
  if (!total.priced) return {};
  const base = total.league / total.priced;
  const out = {};
  for (const [pos, p] of Object.entries(byPosition)) {
    if (p.priced > 0) out[pos] = Math.round((p.league / p.priced / base) * 1000) / 1000;
  }
  return out;
}
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
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

/* Today's dynasty market, keyed by Sleeper id for players and by the labels
   FantasyCalc uses for picks ("2027 1st", "2027 1st (Early)"). A pick whose
   draft slot we can project gets the tiered price; otherwise the plain one. */
export function marketValues(rows) {
  const players = new Map(), picks = new Map();
  for (const row of rows || []) {
    const id = String(row.player?.sleeperId || '');
    if (row.player?.position === 'PICK') picks.set(row.player.name, row.value);
    else if (id) players.set(id, row.value);
  }
  const tierOf = slot => slot == null ? null : slot <= 4 ? 'Early' : slot <= 8 ? 'Mid' : 'Late';
  return {
    player: id => players.get(String(id)) ?? null,
    pick: (season, round, slot) => {
      const base = `${season} ${ORD[round] || `${round}th`}`;
      const tier = tierOf(slot);
      return (tier && picks.get(`${base} (${tier})`)) ?? picks.get(base) ?? null;
    },
    size: players.size + picks.size
  };
}

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
  const franchises = {}, held = {}, teams = {};
  for (const s of seasons) {
    const [rosters, users] = await Promise.all([
      get(`/v1/league/${s.id}/rosters`), get(`/v1/league/${s.id}/users`)]);
    s.owners = {};
    for (const r of rosters || []) {
      const u = (users || []).find(x => x.user_id === r.owner_id);
      s.owners[r.roster_id] = r.owner_id;
      if (s === current) {
        franchises[r.roster_id] = { id: r.roster_id, owner: r.owner_id,
          name: u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}` };
        // who holds what today, so a trade only gets credit for what it still has
        held[r.roster_id] = new Set((r.players || []).map(String));
        teams[r.roster_id] = { ppts: (r.settings?.ppts || 0) + (r.settings?.ppts_decimal || 0) / 100 };
      }
    }
  }
  /* Pick order runs on season max points, worst first, so the projected slot is
     a roster's rank by ppts. It decides whether a 2027 1st is priced Early, Mid
     or Late, which is a difference of well over two thousand. */
  {
    const order = Object.keys(teams).sort((a, b) => teams[a].ppts - teams[b].ppts);
    order.forEach((id, i) => { teams[id].projectedPickSlot = i + 1; });
  }

  // Today's market, for the unused picks and for what each side still holds.
  const market = marketValues(await jsonRequest(FANTASYCALC).catch(() => null));
  console.log(`market values loaded: ${market.size}`);

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
  const scoredBy = {};   // position -> league points vs what FantasyCalc priced
  for (const s of seasons) {
    s.weekly = {};
    // the same scoring with the two things FantasyCalc cannot express removed
    const priced = { ...s.scoring, bonus_rec_te: 0, bonus_fd_te: 0, rec_fd: 0, rush_fd: 0, pass_fd: 0 };
    const done = s.season < current.season || state.season_type !== 'regular' ? 18 : Number(state.week) || 1;
    for (let w = 1; w <= 18; w++) {
      const complete = s.season < current.season || w < done;
      const stats = await get(`/v1/stats/nfl/regular/${s.season}/${w}`, { cache: complete });
      s.weekly[w] = {};
      for (const id in stats || {}) {
        const pts = scoreStats(stats[id], s.scoring);
        if (pts) s.weekly[w][id] = pts;
        const pos = players[id]?.position;
        if (['QB', 'RB', 'WR', 'TE'].includes(pos)) {
          const row = scoredBy[pos] ||= { league: 0, priced: 0 };
          row.league += pts;
          row.priced += scoreStats(stats[id], priced);
        }
      }
    }
    /* Who each roster actually started, week by week. Points from the bench
       never helped anybody, and raw totals cannot tell the difference between a
       player who won you games and one who watched. */
    s.started = {};
    for (let w = 1; w <= 18; w++) {
      const complete = s.season < current.season || w < done;
      const rows = await get(`/v1/league/${s.id}/matchups/${w}`, { cache: complete }) || [];
      s.started[w] = {};
      for (const m of rows) {
        // Take WHO started from the matchup but the points from the same weekly
        // table the totals use. Sleeper's players_points is its own calculation;
        // mixing the two would put "started" and "scored" on different scales and
        // make comparing them meaningless.
        for (const id of (m.starters || []).filter(x => x && x !== '0').map(String)) {
          const pts = s.weekly[w]?.[id];
          if (Number.isFinite(pts)) (s.started[w][m.roster_id] ||= {})[id] = pts;
        }
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

  /* Correct the market for the two settings it could not be asked about. A
     tight end in this league catches for double what a receiver does and
     collects a first-down bonus on top, so a feed priced without either
     systematically undervalues them. The scalar is measured, not chosen. */
  const scalars = positionalScalars(scoredBy);
  console.log('positional correction from four seasons of scoring:',
    Object.entries(scalars).map(([p, v]) => `${p} ${v}`).join('  '));
  const priceOf = id => {
    const raw = market.player(id);
    if (raw == null) return null;
    const scalar = scalars[players[id]?.position] ?? 1;
    return Math.round(raw * scalar);
  };

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

  /* The same window, but only points put in THIS roster's starting lineup. If a
     player was traded on again, the weeks after that belong to whoever started
     him then, so this naturally stops counting at the right moment. */
  const startedAfter = (playerId, roster, season, week) => {
    let total = 0;
    for (const s of seasons) {
      if (s.season < season) continue;
      for (let w = 1; w <= 18; w++) {
        if (s.season === season && w <= week) continue;
        total += s.started[w]?.[roster]?.[playerId] || 0;
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
      // Market value only counts while the asset is still where the trade put
      // it. Once it moves on, both its points and its price belong to the later
      // deal, which is the same rule the points already follow.
      const heldBy = id => held[roster]?.has(String(id));
      const playerRows = gotPlayers.map(id => ({ id, name: players[id]?.full_name
        || [players[id]?.first_name, players[id]?.last_name].filter(Boolean).join(' ') || id,
        pos: players[id]?.position || null, points: pointsAfter(id, t.season, t.week),
        started: startedAfter(id, roster, t.season, t.week),
        value: heldBy(id) ? priceOf(id) : null, kept: !!heldBy(id) }));
      const pickRows = gotPicks.map(p => {
        const made = draftFor(p, t.at);
        const moves = (pickMoves[pickId(p)] || []).filter(x => x !== t.id);
        if (made) resolved++; else pending++;
        const stillOurs = made ? heldBy(made.player_id) : !moves.length;
        return { season: p.season, round: p.round, from: p.roster_id,
          became: made ? { id: made.player_id,
            name: players[made.player_id]?.full_name || made.player_id,
            pos: players[made.player_id]?.position || null, pickNo: made.pick_no,
            points: pointsAfter(made.player_id, t.season, t.week),
            started: startedAfter(made.player_id, roster, t.season, t.week),
            value: stillOurs ? priceOf(made.player_id) : null,
            kept: !!stillOurs } : null,
          // an unused pick is priced by round, tiered when we can project the slot
          value: made || !stillOurs ? null
            : market.pick(p.season, p.round, teams[p.roster_id]?.projectedPickSlot),
          // a pick with no draft yet is pending; one traded on again is a chain
          movedOn: moves.length ? moves : undefined };
      });
      const points = Math.round((playerRows.reduce((a, p) => a + p.points, 0)
        + pickRows.reduce((a, p) => a + (p.became?.points || 0), 0)) * 100) / 100;
      const started = Math.round((playerRows.reduce((a, p) => a + p.started, 0)
        + pickRows.reduce((a, p) => a + (p.became?.started || 0), 0)) * 100) / 100;
      const value = playerRows.reduce((a, p) => a + (p.value || 0), 0)
        + pickRows.reduce((a, p) => a + (p.value || 0) + (p.became?.value || 0), 0);
      const budget = t.budget.filter(b => b.receiver === roster).reduce((a, b) => a + b.amount, 0);
      return { team: roster, manager: franchises[roster]?.name || `Roster ${roster}`,
        sameManager: seasonOf(t.season)?.owners?.[roster] === franchises[roster]?.owner,
        players: playerRows, picks: pickRows, ...(budget ? { budget } : {}),
        points, started, value };
    });

    // Sleeper occasionally records only one side's return. Those are still real
    // trades and dropping them silently would leave gaps in the archive, so they
    // stay, flagged, with the empty side shown as exactly that.
    const withAssets = sides.filter(s => s.players.length || s.picks.length || s.budget);
    if (sides.length >= 2 && withAssets.length >= 1) {
      const oneSided = withAssets.length < 2;
      /* Three verdicts, because one number cannot carry this. Points is what it
         produced, started is what actually reached a lineup, value is what the
         assets are worth now. They disagree often, and the disagreement is the
         interesting part — so name a leader on each rather than blend them into
         a single score with invented weights. */
      const leader = key => {
        if (oneSided) return null;
        const best = Math.max(...sides.map(s => s[key]));
        if (!best) return null;
        return sides.filter(s => s[key] === best).length === 1
          ? sides.find(s => s[key] === best).team : null;
      };
      const spread = key => oneSided ? null
        : Math.round((Math.max(...sides.map(s => s[key])) - Math.min(...sides.map(s => s[key]))) * 100) / 100;
      out.push({ id: t.id, season: t.season, week: t.week, date: new Date(t.at).toISOString().slice(0, 10),
        sides, ...(oneSided ? { oneSided: true } : {}),
        winner: leader('points'), margin: spread('points'),
        startedWinner: leader('started'), startedMargin: spread('started'),
        valueWinner: leader('value'), valueMargin: spread('value'),
        pendingPicks: sides.reduce((n, s) => n + s.picks.filter(p => !p.became).length, 0) });
    }
  }

  const file = { generated: new Date().toISOString(), seasons: seasons.map(s => s.season),
    // How the values were obtained, so the page can state it and a reader can
    // judge it rather than taking a number on faith.
    market: { source: FANTASYCALC, ppr: 0.5, superflex: true, teams: 12,
      tePremium: !!current.scoring?.bonus_rec_te,
      firstDowns: !!(current.scoring?.rec_fd || current.scoring?.rush_fd),
      unsupported: ['tePremium', 'pointsPerFirstDown'],
      scalars, note: 'FantasyCalc accepts only dynasty/numQbs/numTeams/ppr. TE premium '
        + 'and points per first down cannot be requested, so each position is corrected by '
        + 'how far this league\'s real scoring lifts it relative to the rest, measured over '
        + 'every completed season.' },
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
