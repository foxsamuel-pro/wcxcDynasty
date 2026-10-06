/* The casino's pricing, parsing and grading — every rule that decides money,
 * other than placing a bet, which lives in SQL (place_bet) because the browser
 * cannot be trusted with it.
 *
 * Pure functions, no imports, no I/O: the Supabase edge function (Deno) imports
 * this to sync lines and settle bets, and the Node tests import the same file,
 * so what is tested is what runs.
 *
 * Odds come from ESPN's public scoreboard and propBets feeds, which carry
 * DraftKings' lines (provider id 100). DraftKings' own API sits behind Akamai and
 * refuses scripted requests, ESPN's does not. Prices are stored as DECIMAL odds
 * (2.5 = +150) rounded to 4 places, because that is what multiplies into a
 * parlay; American odds are only ever for display.
 */

export const DK = '100';

/* Player props ESPN prices as a plain over/under on one player stat. Milestones
   ("3+ receptions"), anytime-touchdown and first-scorer markets carry a target
   but no price in the feed, and an over/under line can be priced fairly on its
   own while a milestone cannot, so those are left out rather than guessed. Each
   stat maps to the Sleeper weekly-stat keys that settle it. */
export const PROP_MARKETS = {
  'Total Passing Yards (incl. overtime)':               { key: 'pass_yd',     name: 'Passing yards',      stats: ['pass_yd'] },
  'Total Pass Completions (incl. overtime)':            { key: 'pass_cmp',    name: 'Completions',        stats: ['pass_cmp'] },
  'Total Passing Attempts (incl. overtime)':            { key: 'pass_att',    name: 'Pass attempts',      stats: ['pass_att'] },
  'Total Passing Touchdowns (incl. overtime)':          { key: 'pass_td',     name: 'Passing TDs',        stats: ['pass_td'] },
  'Total Passing Interceptions (incl. overtime)':       { key: 'pass_int',    name: 'Interceptions',      stats: ['pass_int'] },
  'Total Carries (incl. overtime)':                     { key: 'rush_att',    name: 'Carries',            stats: ['rush_att'] },
  'Total Rushing Yards (incl. overtime)':               { key: 'rush_yd',     name: 'Rushing yards',      stats: ['rush_yd'] },
  'Total Receptions (incl. overtime)':                  { key: 'rec',         name: 'Receptions',         stats: ['rec'] },
  'Total Receiving Yards (incl. overtime)':             { key: 'rec_yd',      name: 'Receiving yards',    stats: ['rec_yd'] },
  'Total Passing Plus Rushing Yards (incl. overtime)':  { key: 'pass_rush_yd', name: 'Pass + rush yards', stats: ['pass_yd', 'rush_yd'] },
  'Total Rushing Plus Receiving Yards (incl. overtime)':{ key: 'rush_rec_yd', name: 'Rush + rec yards',   stats: ['rush_yd', 'rec_yd'] },
};
export const PROP_BY_KEY = Object.fromEntries(Object.values(PROP_MARKETS).map(m => [m.key, m]));

// The same position-aware spread as the Pick 'em tab and the newspaper.
export const SPREAD = { QB: 0.55, RB: 0.75, WR: 0.85, TE: 0.80 };

/* ---------------- odds arithmetic ---------------- */
const r4 = x => Math.round(x * 10000) / 10000;
export const money = x => Math.round(x * 100) / 100;

export function parseAmerican(s) {
  if (s == null) return null;
  const t = String(s).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV' || t === 'PK') return 100;
  const n = Number(t.replace(/^\+/, ''));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) < 100) return null;
  return n;
}
export const americanToDecimal = a => r4(a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export function decimalToAmerican(d) {
  if (!(d > 1)) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
export const fmtAmerican = a => a == null ? '—' : a > 0 ? `+${a}` : String(a);

/* Parlay price: the legs multiply, then the cap applies. A capped parlay is the
   house limiting its exposure, which is how real books do it as well. */
/* A ceiling from casino_rules: null (or missing) means none. Number(null) is 0,
   so every ceiling goes through this — a bare Number() would cap payouts at $0. */
export const lim = v => v == null || v === '' ? Infinity : Number(v);

export function parlayPrice(prices, cap = Infinity) {
  const p = prices.reduce((a, b) => a * b, 1);
  return Math.min(r4(p), cap);
}

export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return (1 + erf) / 2;
}

/* ---------------- ESPN: game lines ---------------- */

/* One ESPN event reduced to what the casino needs. `score` is the snapshot a
   live bet is checked against: the score plus who has the ball. If either moves
   while a live bet waits out its delay, the bet is refused. */
export function parseEvent(ev) {
  const c = ev?.competitions?.[0];
  if (!c) return null;
  const home = c.competitors?.find(x => x.homeAway === 'home');
  const away = c.competitors?.find(x => x.homeAway === 'away');
  if (!home || !away) return null;
  const st = c.status?.type || ev.status?.type || {};
  const state = st.state === 'in' ? 'in' : st.state === 'post' ? 'post' : 'pre';
  const hs = Number(home.score ?? 0), as = Number(away.score ?? 0);
  const poss = c.situation?.possession || '';
  return {
    id: String(ev.id), state, completed: !!st.completed && state === 'post',
    commence: c.date || ev.date,
    home: home.team?.abbreviation, away: away.team?.abbreviation,
    homeId: String(home.team?.id ?? ''), awayId: String(away.team?.id ?? ''),
    homeScore: hs, awayScore: as,
    score: state === 'pre' ? '' : `${as}-${hs}|${poss}`,
    label: `${away.team?.abbreviation} @ ${home.team?.abbreviation}`,
    homeName: home.team?.displayName || '', awayName: away.team?.displayName || '',
    odds: (c.odds || []).find(o => String(o?.provider?.id) === DK) || null,
  };
}

/* Moneyline, spread and total for one event, as casino_lines rows. Only sides
   with a real price are produced; a market missing a side is dropped whole, so
   nobody can bet one half of a market that the book has pulled. */
export function gameLines(ev, { season, week }) {
  const e = typeof ev?.competitions === 'object' ? parseEvent(ev) : ev;
  if (!e || !e.odds) return [];
  const o = e.odds, base = { season, week, event: `nfl:${e.id}`, sport: 'nfl',
    event_label: e.label, commence_at: e.commence, state: e.state, score: e.score,
    team: null, teams: null, player: null, nfl_team: null };
  const row = (market, side, label, point, am) => {
    const american = parseAmerican(am);
    if (american == null) return null;
    return { ...base, id: `nfl:${e.id}:${market}:${side}`, market, side, label,
      point, american, price: americanToDecimal(american),
      nfl_team: side === 'home' ? e.home : side === 'away' ? e.away : null };
  };
  const cur = x => x?.close ?? x?.current ?? null;
  const num = s => { const n = Number(String(s ?? '').replace(/^[ou]/i, '')); return Number.isFinite(n) ? n : null; };
  const out = [];
  const pair = (a, b) => { if (a && b) out.push(a, b); };
  pair(row('ml', 'away', e.away, null, cur(o.moneyline?.away)?.odds),
       row('ml', 'home', e.home, null, cur(o.moneyline?.home)?.odds));
  const sa = cur(o.pointSpread?.away), sh = cur(o.pointSpread?.home);
  if (num(sa?.line) != null && num(sh?.line) != null)
    pair(row('spread', 'away', e.away, num(sa.line), sa.odds),
         row('spread', 'home', e.home, num(sh.line), sh.odds));
  const tov = cur(o.total?.over), tun = cur(o.total?.under);
  if (num(tov?.line) != null && num(tun?.line) != null)
    pair(row('total', 'over', 'Over', num(tov.line), tov.odds),
         row('total', 'under', 'Under', num(tun.line), tun.odds));
  return out;
}

/* ---------------- ESPN: player props ---------------- */

const athleteId = ref => String(ref || '').match(/athletes\/(\d+)/)?.[1] || null;

/* ESPN lists each prop twice (one row per side, same target). It gives the
   line but no price, so both sides are offered at the house price — standard
   -115 — and the page says so. Props are matched to Sleeper players by ESPN
   athlete id through espn.json, never by name; an athlete who cannot be matched
   could not be settled, so he is not offered. */
export function propLines(items, e, { season, week, espn, american = -115 }) {
  const seen = new Set(), out = [];
  const price = americanToDecimal(american);
  for (const p of items || []) {
    const m = PROP_MARKETS[p?.type?.name];
    const ath = athleteId(p?.athlete?.$ref);
    const point = Number(p?.current?.target?.value);
    if (!m || !ath || !Number.isFinite(point)) continue;
    const who = espn?.[ath];
    if (!who) continue;
    const key = `${ath}:${m.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const side of ['over', 'under']) out.push({
      id: `prop:${e.id}:${ath}:${m.key}:${side}`, season, week,
      event: `nfl:${e.id}`, sport: 'prop', market: m.key, side,
      label: who.name, event_label: e.label, point, american, price,
      team: null, teams: null, player: String(who.id), nfl_team: who.team || null,
      commence_at: e.commence, state: e.state, score: e.score,
    });
  }
  return out;
}

/* ---------------- live line status ----------------
   A live line is only as good as its freshness. If the score or possession has
   changed since the last sync and the price has not, the book has not caught up
   yet — that is precisely the moment someone watching the game could pick it
   off. So the line is suspended until the price moves. */
export function lineStatus(prev, next, { live_enabled = false } = {}) {
  if (next.state === 'post') return 'closed';
  if (next.state === 'in') {
    if (!live_enabled || next.sport !== 'nfl') return 'closed';
    if (prev && prev.score !== next.score && prev.price === next.price && prev.point === next.point) return 'suspended';
    if (prev && prev.status === 'suspended' && prev.price === next.price && prev.point === next.point) return 'suspended';
    return 'open';
  }
  return 'open';
}

/* ---------------- fantasy matchups ----------------
   Port of loadLines() in index.html: starters' projected points under the
   league's own scoring, banked points carrying no variance, and a finished NFL
   game contributing nothing further. Tests hold the two to the same answer. */
export function scorePoints(stats, scoring) {
  if (!stats) return 0;
  let total = 0;
  for (const k in scoring) if (typeof stats[k] === 'number') total += stats[k] * scoring[k];
  return total;
}

/* `scale` corrects Sleeper's projections to what this league actually scores
   (see calibrationScale). It multiplies both the projection and its spread, so
   win probabilities are unchanged and only the level, which totals depend on,
   moves. The Pick 'em page uses the default of 1. */
export function fantasyPairs({ matchups, proj, positions, teams, done = {}, scoring, scale = 1 }) {
  const sides = (matchups || []).filter(m => m && m.matchup_id != null).map(m => {
    let remaining = 0, variance = 0;
    for (const id of (m.starters || []).filter(x => x && x !== '0')) {
      const projected = scorePoints(proj?.[id], scoring) * scale;
      const scored = m.players_points?.[id] ?? 0;
      const nfl = teams?.[id];
      const left = (nfl && done[nfl]) ? 0 : Math.max(0, projected - scored);
      remaining += left;
      variance += Math.pow((SPREAD[positions?.[id]] ?? 0.75) * left, 2);
    }
    return { team: m.roster_id, matchup: m.matchup_id, score: +(m.points || 0),
      proj: (m.points || 0) + remaining, variance };
  });
  const by = {};
  for (const s of sides) (by[s.matchup] ||= []).push(s);
  return Object.values(by).filter(p => p.length === 2).map(([a, b]) => {
    const sd = Math.sqrt(a.variance + b.variance);
    const win = sd > 0 ? normalCdf((a.proj - b.proj) / sd) : a.proj === b.proj ? 0.5 : a.proj > b.proj ? 1 : 0;
    return { matchup: a.matchup, teams: [a.team, b.team],
      sides: [{ ...a, win }, { ...b, win: 1 - win }], sd, total: a.proj + b.proj };
  });
}

/* Sleeper's projections run hot in this league: it projects about one first
   down per ten receiving yards, roughly double reality, and first downs score
   here. Over weeks 1-4 of 2026 teams were projected 198.0 and scored 158.6, and
   every one of 24 totals went under. So the level is MEASURED: actual over
   projected across finished weeks (0.80 then, steady week to week), and the
   sync refreshes it daily. Null until there is enough to measure; clamped so
   one strange week cannot price the board absurdly. */
export function calibrationScale(samples, { min = 24 } = {}) {
  if (!samples || samples.length < min) return null;
  const p = samples.reduce((a, s) => a + s.proj, 0);
  const a = samples.reduce((x, s) => x + s.actual, 0);
  if (!(p > 0)) return null;
  return Math.round(Math.min(1.5, Math.max(0.5, a / p)) * 10000) / 10000;
}

/* Fair probability plus half the hold on each side, then rounded to a whole
   American price so what is shown and what is paid are the same number. A
   4.5% hold makes a coin flip -110 a side, like a real book. */
export function priceFromProb(p, hold) {
  const implied = Math.min(0.98, Math.max(0.02, p + hold / 2));
  const american = decimalToAmerican(1 / implied);
  return { american, price: americanToDecimal(american) };
}
// Half points only, so a fantasy total can never push.
const half = x => Math.floor(Math.abs(x)) + 0.5;

/* Moneyline and total only. Spreads are not offered: projected margins
   overstate the real gap between teams, and even after fitting that on weeks
   1-4, underdogs covered 16 of 24 in leave-one-week-out tests — too few games
   to price a spread fairly. Moneylines held up (Brier 0.197; refitting did not
   improve it), and totals are fair once the level is calibrated. */
export function fantasyLines(pairs, { season, week, commence, hold = 0.045 }) {
  const out = [], std = { american: -110, price: americanToDecimal(-110) };
  for (const p of pairs || []) {
    if (!(p.total > 0)) continue;              // no projections yet: nothing to price
    const [a, b] = p.sides;
    const base = { season, week, event: `fan:${season}:${week}:${p.matchup}`, sport: 'fantasy',
      event_label: '', commence_at: commence, state: 'pre', score: '',
      teams: [a.team, b.team], player: null, nfl_team: null };
    const id = (m, s) => `fan:${season}:${week}:${p.matchup}:${m}:${s}`;
    for (const s of [a, b]) {
      const pr = priceFromProb(s.win, hold);
      out.push({ ...base, id: id('ml', s.team), market: 'ml', side: String(s.team), team: s.team,
        label: '', point: null, ...pr });
    }
    const tot = half(p.total);
    for (const side of ['over', 'under'])
      out.push({ ...base, id: id('total', side), market: 'total', side, team: null,
        label: '', point: tot, ...std });
  }
  return out;
}

/* ---------------- grading ----------------
   One leg against the line's final outcome. The POINT is the leg's — the
   spread or total at the moment the bet was placed — not whatever the line had
   moved to by kickoff. Outcomes:
     nfl      {home, away}
     prop     {played, value}   a player who did not play voids, like a real book
     fantasy  {pts: {roster_id: points}} */
export function gradeLeg(line, point, outcome) {
  if (!outcome) return null;
  if (outcome.void) return 'void';
  const cmp = (a, b) => a > b ? 'win' : a < b ? 'loss' : 'push';
  const ou = (value) => line.side === 'over' ? cmp(value, point) : cmp(point, value);
  if (line.sport === 'nfl') {
    const { home, away } = outcome;
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    const mine = line.side === 'home' ? home : away, theirs = line.side === 'home' ? away : home;
    if (line.market === 'ml') return cmp(mine, theirs);
    if (line.market === 'spread') return cmp(mine + point, theirs);
    if (line.market === 'total') return ou(home + away);
    return null;
  }
  if (line.sport === 'prop') {
    if (!outcome.played) return 'void';
    if (TD_COUNT[line.market]) return outcome.tds >= TD_COUNT[line.market] ? 'win' : 'loss';
    if (TD_ORDER[line.market]) return outcome.scorer != null && outcome.scorer === line.player ? 'win' : 'loss';
    return ou(outcome.value);
  }
  if (line.sport === 'fantasy') {
    const [a, b] = line.teams || [];
    const pa = outcome.pts?.[a], pb = outcome.pts?.[b];
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
    if (line.market === 'total') return ou(pa + pb);
    const mine = line.team === a ? pa : pb, theirs = line.team === a ? pb : pa;
    if (line.market === 'ml') return cmp(mine, theirs);
    if (line.market === 'spread') return cmp(mine + point, theirs);
  }
  return null;
}

// A prop outcome from Sleeper's weekly stats. gp is games played.
/* Touchdown markets. A count market (anytime, 2+, 3+, 4+) settles from the
   player's own touchdowns in Sleeper's weekly stats: rushing, receiving and
   returns. A quarterback's passing touchdowns belong to his receivers, as at
   every book. First and last scorer settle from ESPN's scoring plays (see
   sync.mjs); a player who did not play voids, as FanDuel does. */
export const TD_COUNT = { atd: 1, td2: 2, td3: 3, td4: 4 };
export const TD_ORDER = { ftd: 'first', ltd: 'last' };
const TD_STATS = ['rush_td', 'rec_td', 'kr_td', 'pr_td', 'fum_rec_td'];

export function propOutcome(stats, market) {
  const m = PROP_BY_KEY[market];
  if (!m && !TD_COUNT[market]) return null;
  if (!stats || !(stats.gp > 0)) return { played: false };
  if (TD_COUNT[market]) return { played: true, tds: TD_STATS.reduce((a, k) => a + (Number(stats[k]) || 0), 0) };
  return { played: true, value: m.stats.reduce((a, k) => a + (Number(stats[k]) || 0), 0) };
}

/* ---------------- settlement ----------------
   A straight bet pays stake x price, pushes and voids refund. A parlay loses on
   any losing leg (as soon as one is known). Legs from the same game settle as
   one unit at the same-game price they were placed at: if they all win it
   pays, and a push or void anywhere in it takes that game out. What is left is
   repriced (the cap applies again), and if nothing is left the stake comes
   back. A payout is capped at max_payout when one is set. Returns null while undecided. */
export function settleBet(bet, legs, rules) {
  if (!legs.length) return null;
  if (legs.some(l => l.result === 'loss')) return { status: 'lost', payout: 0 };
  if (legs.some(l => !l.result)) return null;
  if (bet.kind !== 'parlay') {
    if (legs[0].result !== 'win') return { status: legs[0].result === 'push' ? 'push' : 'void', payout: money(bet.stake) };
    return { status: 'won', payout: Math.min(money(bet.stake * Number(legs[0].price)), lim(rules.max_payout)) };
  }
  const groups = new Map();
  legs.forEach((l, i) => {
    const k = l.event || l.line_id || `#${i}`;      // bets from before same-game parlays: every leg its own game
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  const won = [...groups.values()].filter(g => g.every(l => l.result === 'win'));
  if (!won.length) return { status: legs.some(l => l.result === 'push') ? 'push' : 'void', payout: money(bet.stake) };
  const prices = won.map(g => g.length > 1
    ? Number(g[0].group_price ?? g.reduce((a, l) => a * Number(l.price), 1))
    : Number(g[0].price));
  const price = parlayPrice(prices, lim(rules.parlay_max_price));
  return { status: 'won', payout: Math.min(money(bet.stake * price), lim(rules.max_payout)) };
}

/* ---------------- the live-bet delay ----------------
   A live bet waits at least live_delay_sec. It is accepted only if every leg's
   line has refreshed since the bet was placed, is still open, still shows the
   same score and possession, and its price has not moved by more than
   live_tolerance (relative). Anything else refunds it. */
export function resolvePending(bet, legs, lines, rules, now = Date.now()) {
  const placed = Date.parse(bet.placed_at);
  if (now - placed < rules.live_delay_sec * 1000) return null;
  const tooOld = now - placed > rules.pending_timeout_sec * 1000;
  for (const leg of legs) {
    const l = lines[leg.line_id];
    if (!l) return { accept: false, note: 'Line was pulled' };
    if (l.status !== 'open') return { accept: false, note: 'Line suspended during the delay' };
    if (l.score !== leg.score_at) return { accept: false, note: 'The game moved during the delay' };
    if (l.point !== leg.point && !(l.point == null && leg.point == null))
      return { accept: false, note: 'The line moved during the delay' };
    if (Math.abs(Number(l.price) - Number(leg.price)) / Number(leg.price) > Number(rules.live_tolerance))
      return { accept: false, note: 'The price moved during the delay' };
    if (!(Date.parse(l.updated_at) > placed)) {
      if (tooOld) return { accept: false, note: 'Odds did not refresh in time' };
      return null;                       // wait for the next sync
    }
  }
  return { accept: true, note: null };
}

/* ---------------- slip validation ----------------
   Mirror of place_bet's rules so the page can warn before sending. The SQL is
   the authority; tests assert the two agree. Returns a list of problems. */
export function checkSlip({ legs, stake, voter, rules, now = Date.now(), mode = 'parlay', price = null }) {
  const errs = [];
  if (!legs.length) return ['Add a selection first.'];
  const parlay = mode === 'parlay' && legs.length > 1;
  const cap = rules.parlay_max_legs;                  // null: no limit on legs
  if (parlay && (legs.length < rules.parlay_min_legs || (cap != null && legs.length > cap)))
    errs.push(cap != null ? `Parlays take ${rules.parlay_min_legs} to ${cap} legs.` : `Parlays take at least ${rules.parlay_min_legs} legs.`);
  if (parlay) errs.push(...sameGameProblems(legs, rules));
  for (const l of legs) {
    if (l.status !== 'open') errs.push(`${l.label || 'A selection'} is suspended right now.`);
    if (l.price < (rules.leg_min_price ?? 0)) errs.push(`${l.label || 'A selection'} is too short a price to bet.`);   // null: no floor
    if (l.price > lim(rules.leg_max_price)) errs.push(`${l.label || 'A selection'} is too long a price to bet.`);
    if (l.state === 'pre' && now >= Date.parse(l.commence_at)) errs.push(`${l.label || 'That game'} has already kicked off.`);
    if (l.state === 'in' && (!rules.live_enabled || l.sport !== 'nfl')) errs.push(`${l.label || 'That game'} is closed for betting.`);
    if (l.state === 'post') errs.push(`${l.label || 'That game'} is over.`);
    if (rules.block_self_bets && l.sport === 'fantasy' && voter && (l.teams || []).includes(voter)
        && ((l.market !== 'total' && l.team !== voter) || (l.market === 'total' && l.side === 'under')))
      errs.push('You can back your own team, but you can\'t bet against it.');
  }
  const s = Number(stake);
  if (!(s > 0)) return errs.concat('Enter a stake.');
  if (Math.round(s * 100) !== s * 100) errs.push('Stake must be in dollars and cents.');
  if (s < rules.min_stake) errs.push(`Minimum stake is $${rules.min_stake}.`);
  const max = lim(parlay ? rules.max_stake_parlay : rules.max_stake_straight);
  if (s > max) errs.push(`Maximum ${parlay ? 'parlay' : 'straight'} stake is $${max}.`);
  // the ticket's real price when the caller knows it (same-game groups), else the legs multiplied
  const p = price ?? (parlay ? parlayPrice(legs.map(l => l.price), lim(rules.parlay_max_price)) : Math.max(...legs.map(l => l.price)));
  const top = lim(rules.max_payout);
  if (money(s * p) > top)
    errs.push(`A ticket can pay at most $${top}, so the most you can stake at these odds is $${Math.floor(top / p * 100) / 100}.`);
  return errs;
}

/* Which same-game groups a parlay may hold: NFL games only (a WCXC matchup is
   one leg), pregame only, and at most sgp_max_legs from one game. */
export function sameGameProblems(legs, rules) {
  const by = new Map();
  for (const l of legs) { if (!by.has(l.event)) by.set(l.event, []); by.get(l.event).push(l); }
  const errs = [];
  for (const g of by.values()) {
    if (g.length < 2) continue;
    if (g.some(l => l.sport === 'fantasy')) errs.push('Only one leg per WCXC matchup.');
    else if (g.some(l => l.state === 'in')) errs.push('Same-game parlays are pregame only.');
    else if (g.some(l => TD_ORDER[l.market])) errs.push('First and last touchdown scorer bets can\'t go in a same-game parlay.');
    else if (rules.sgp_max_legs != null && g.length > rules.sgp_max_legs) errs.push(`A same-game parlay takes at most ${rules.sgp_max_legs} legs.`);
  }
  return errs;
}

/* ================= same-game parlays =================
   Legs from one game move together, so multiplying their prices overpays: DAL
   moneyline with DAL -8.5 is really just the spread bet, because a cover is a
   win. So each NFL game is simulated SIM_N times, and every line stores one bit
   per simulated game: did it win there. A same-game group's chance is how often
   ALL its legs win together, which the database counts with a bitwise AND, so
   pricing stays server-side and any combination works.

   The model is a set of shared factors, deliberately on the generous side of
   plausible because overestimating how much legs move together is the safe
   direction (see sgpGroupPrice):
     margin and total     fitted to DraftKings' own moneyline, spread and total
     team scoring         from margin and total (home = (T + M) / 2)
     team passing         0.55 team scoring + 0.45 a shared pass environment
                          (which leans on the total, so shootouts lift both QBs)
     team rushing         0.50 team scoring + 0.25 own margin (leading teams run)
     a player             loads on his team's passing or rushing by role: QB
                          passing 0.95, receivers 0.65 (TE 0.60), RB rushing
                          0.75, RB receiving 0.40
     a stat               on its player factor: yards 0.95, receptions 0.85,
                          completions 0.90, attempts 0.75, TDs 0.60, INTs 0.25
   Same seed per game and quantity, so a prop computed ten minutes ago and a
   spread computed now share the same simulated games. */
export const SIM_N = 4096;
const TEAM_ALIAS = { WAS: 'WSH', WSH: 'WAS' };       // ESPN and Sleeper disagree on Washington

function seedOf(str) {                              // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(key, n) {
  const r = mulberry32(seedOf(key)), out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const m = Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))), a = 2 * Math.PI * r();
    out[i] = m * Math.cos(a);
    if (i + 1 < n) out[i + 1] = m * Math.sin(a);
  }
  return out;
}

// Inverse normal CDF (Acklam), for turning a no-vig probability into a z-score.
export function probit(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = q => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* Margin (home minus away) and total as normals, fitted so the simulated
   chances match DraftKings' own prices with the vig taken out. Spread and
   moneyline together pin both the mean and the spread of the margin; with only
   one of them the margin's standard deviation falls back to 13.5, the NFL norm. */
export function gameParams(lines) {
  const get = (m, s) => lines.find(l => l.market === m && l.side === s);
  const nv = (x, y) => x && y ? (1 / Number(x.price)) / (1 / Number(x.price) + 1 / Number(y.price)) : null;
  const pMl = nv(get('ml', 'home'), get('ml', 'away'));
  const sh = get('spread', 'home'), pSp = nv(sh, get('spread', 'away'));
  const ov = get('total', 'over'), pOv = nv(ov, get('total', 'under'));
  let muM = 0, sdM = 13.5;
  if (sh && pSp != null) {
    const c = -Number(sh.point), zs = probit(pSp);    // home must win by more than c to cover
    if (pMl != null && Math.abs(c) >= 1) {
      const s = c / (probit(pMl) - zs);
      if (Number.isFinite(s) && s >= 8 && s <= 20) sdM = s;
    }
    muM = c + zs * sdM;
  } else if (pMl != null) muM = probit(pMl) * sdM;
  const sdT = 10;
  const muT = ov && pOv != null ? Number(ov.point) + probit(pOv) * sdT : 45;
  return { muM, sdM, muT, sdT };
}

const ROLE = {                       // [team factor, loading] for each of a player's three dimensions
  QB: { pass: ['pass', 0.95], rush: ['rush', 0.30], rec: ['pass', 0.10] },
  RB: { pass: ['pass', 0.10], rush: ['rush', 0.75], rec: ['pass', 0.40] },
  WR: { pass: ['pass', 0.10], rush: ['rush', 0.20], rec: ['pass', 0.65] },
  TE: { pass: ['pass', 0.10], rush: ['rush', 0.20], rec: ['pass', 0.60] },
};
const STAT = {                       // [player dimension, loading] per prop market
  pass_yd: [['pass', 0.95]], pass_cmp: [['pass', 0.90]], pass_att: [['pass', 0.75]],
  pass_td: [['pass', 0.60]], pass_int: [['pass', 0.25]],
  rush_yd: [['rush', 0.95]], rush_att: [['rush', 0.85]],
  rec_yd: [['rec', 0.95]], rec: [['rec', 0.85]],
  pass_rush_yd: [['pass', 0.90], ['rush', 0.30]],
};
const rushRec = role => role === 'RB' ? [['rush', 0.80], ['rec', 0.45]] : [['rec', 0.95], ['rush', 0.15]];
// a quarterback's own touchdowns are rushing ones; a back scores both ways; receivers catch them
const TD_LOAD = role => role === 'QB' ? [['rush', 0.65]] : role === 'RB' ? [['rush', 0.60], ['rec', 0.25]] : [['rec', 0.65]];

export function simulateGame({ event, lines = [], props = [], positions = {}, n = SIM_N }) {
  const P = gameParams(lines);
  const cache = new Map();
  const z = key => { let v = cache.get(key); if (!v) { v = normals(`${event}|${key}`, n); cache.set(key, v); } return v; };
  const gM = z('margin'), gT = z('total'), gW = z('pass-env');
  const home = lines.find(l => l.side === 'home')?.nfl_team ?? null;
  const away = lines.find(l => l.side === 'away')?.nfl_team ?? null;
  const k = Math.hypot(P.sdM, P.sdT);
  const passRest = Math.sqrt(Math.max(0, 1 - 0.55 ** 2 - 0.45 ** 2 - 2 * 0.55 * 0.45 * (0.5 * P.sdT / k)));
  const rushRest = Math.sqrt(Math.max(0, 1 - 0.5 ** 2 - 0.25 ** 2 - 2 * 0.5 * 0.25 * (P.sdM / k)));
  const teams = {};
  const teamOf = t => {
    const side = t && (t === home || TEAM_ALIAS[t] === home) ? 1 : t && (t === away || TEAM_ALIAS[t] === away) ? -1 : 0;
    const key = side === 1 ? 'home' : side === -1 ? 'away' : `team:${t}`;
    if (teams[key]) return teams[key];
    const ep = z(`${key}|pass`), er = z(`${key}|rush`);
    const pass = new Float64Array(n), rush = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      if (!side) { pass[s] = ep[s]; rush[s] = er[s]; continue; }    // a team we cannot place: no shared factor
      const pts = (P.sdT * gT[s] + side * P.sdM * gM[s]) / k;
      pass[s] = 0.55 * pts + 0.45 * (0.5 * gT[s] + 0.8660254 * gW[s]) + passRest * ep[s];
      rush[s] = 0.5 * pts + 0.25 * side * gM[s] + rushRest * er[s];
    }
    return (teams[key] = { pass, rush });
  };
  const bits = {};
  const pack = win => { const b = new Uint8Array(n >> 3); for (let s = 0; s < n; s++) if (win(s)) b[s >> 3] |= 1 << (s & 7); return b; };

  for (const l of lines) {
    const pt = Number(l.point);
    const M = s => P.muM + P.sdM * gM[s], T = s => P.muT + P.sdT * gT[s];
    if (l.market === 'ml') bits[l.id] = pack(l.side === 'home' ? s => M(s) > 0 : s => M(s) < 0);
    else if (l.market === 'spread') bits[l.id] = pack(l.side === 'home' ? s => M(s) + pt > 0 : s => pt - M(s) > 0);
    else if (l.market === 'total') bits[l.id] = pack(l.side === 'over' ? s => T(s) > pt : s => T(s) < pt);
  }

  const players = {};
  const playerOf = (id, team) => {
    if (players[id]) return players[id];
    const role = ROLE[positions[id]] || ROLE.WR, tf = teamOf(team), dims = {};
    for (const dim of ['pass', 'rush', 'rec']) {
      const [factor, a] = role[dim], own = z(`${id}|${dim}`), out = new Float64Array(n), rest = Math.sqrt(1 - a * a);
      for (let s = 0; s < n; s++) out[s] = a * tf[factor][s] + rest * own[s];
      dims[dim] = out;
    }
    return (players[id] = { dims, role: positions[id] || 'WR' });
  };
  /* Every line on one player stat is a threshold on the same latent, so an
     over, its under and a ladder of milestones (50+, 75+, 100+) nest exactly.
     Touchdown counts share one latent per player (anytime inside 2+ inside
     3+). First and last scorer are not simulated: only one player can score
     first, which independent latents cannot express, so they stay out of
     same-game parlays. One-way prices carry the book's margin, which makes a
     leg look likelier than it is: the safe direction for a group's price. */
  const isMs = id => /:ms\d+$/.test(id);
  const oneWay = l => Math.min(0.995, 1 / Number(l.price));
  const byStat = new Map(), byTd = new Map();
  for (const p of props) {
    if (TD_ORDER[p.market]) continue;
    const td = !!TD_COUNT[p.market], key = td ? `${p.player}|td` : `${p.player}|${p.market}`, map = td ? byTd : byStat;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const latent = (key, pl, load) => {
    const eps = z(`${key}|stat`), rest = Math.sqrt(Math.max(0.05, 1 - load.reduce((a, [, w]) => a + w * w, 0)));
    const lat = new Float64Array(n);
    for (let s = 0; s < n; s++) { let v = rest * eps[s]; for (const [dim, w] of load) v += w * pl.dims[dim][s]; lat[s] = v; }
    return { lat, norm: Math.sqrt(load.reduce((a, [, w]) => a + w * w, 0) + rest * rest) };
  };
  for (const [key, lines] of byStat) {
    const { player, market, nfl_team: team } = lines[0];
    const pl = playerOf(player, team);
    const load = market === 'rush_rec_yd' ? rushRec(pl.role) : STAT[market];
    if (!load) continue;
    const { lat, norm } = latent(key, pl, load);
    const over = lines.find(x => x.side === 'over' && !isMs(x.id)), under = lines.find(x => x.side === 'under');
    const pOver = over && under ? (1 / Number(over.price)) / (1 / Number(over.price) + 1 / Number(under.price)) : over ? oneWay(over) : 0.5;
    const cut = -probit(pOver) * norm;
    if (over) bits[over.id] = pack(s => lat[s] > cut);
    if (under) bits[under.id] = pack(s => lat[s] < cut);
    for (const ms of lines.filter(x => isMs(x.id))) {
      const c = -probit(oneWay(ms)) * norm;
      bits[ms.id] = pack(s => lat[s] > c);
    }
  }
  for (const [key, lines] of byTd) {
    const { player, nfl_team: team } = lines[0];
    const pl = playerOf(player, team);
    const { lat, norm } = latent(key, pl, TD_LOAD(pl.role));
    for (const l of lines) {
      const c = -probit(oneWay(l)) * norm;
      bits[l.id] = pack(s => lat[s] > c);
    }
  }
  return { bits, params: P };
}

// Bytea transport: PostgREST reads and writes bytea as "\\x" + hex.
export const simHex = b => b ? '\\x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('') : null;
export function simBytes(hex) {
  if (!hex) return null;
  const h = String(hex).replace(/^\\x/, '');
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
const POP = Uint8Array.from({ length: 256 }, (_, i) => { let c = 0; for (let x = i; x; x >>= 1) c += x & 1; return c; });
export function jointHits(arrays) {
  let hits = 0;
  for (let i = 0; i < arrays[0].length; i++) { let b = 255; for (const a of arrays) b &= a[i]; hits += POP[b]; }
  return hits;
}

/* A same-game group's price: the simulated chance that every leg wins, less
   the same-game hold, and NEVER more than the legs multiplied. That cap is what
   makes the correlation guesses fail safe: it removes any boost a too-high
   correlation could hand to a bettor mixing overs and unders, so a guess can
   only hurt the bettor, never the bank, unless it is too LOW for legs that
   move together. place_bet in supabase-setup.sql does the same arithmetic. */
export function sgpGroupPrice(legs, sims, rules) {
  const bad = sameGameProblems(legs, rules);
  if (bad.length) return { err: bad[0] };
  if (sims.some(s => !s)) return { err: "That game isn't priced for same-game parlays yet." };
  const n = sims[0].length * 8, hits = jointHits(sims);
  if (!hits) return { err: "Those legs can't all win together." };
  if (hits < Number(rules.sgp_min_hits)) return { err: 'That same-game combination is too unlikely to price.' };
  const naive = r4(legs.reduce((a, l) => a * Number(l.price), 1));
  const price = Math.min(naive, r4((1 - Number(rules.sgp_hold)) * n / hits));
  if (price <= 1.01) return { err: 'That same-game combination is too likely to price.' };
  return { price, hits, n };
}

// A whole ticket: same-game groups at their own price, every other leg as is.
export function ticketPrice(legs, simOf, rules) {
  const groups = new Map();
  for (const l of legs) { if (!groups.has(l.event)) groups.set(l.event, []); groups.get(l.event).push(l); }
  let price = 1;
  const sgp = [];
  for (const g of groups.values()) {
    if (g.length === 1) { price *= Number(g[0].price); continue; }
    const r = sgpGroupPrice(g, g.map(l => simOf(l.id)), rules);
    if (r.err) return { err: r.err };
    sgp.push({ event: g[0].event, legs: g.length, price: r.price });
    price *= r.price;
  }
  return { price: Math.min(r4(price), lim(rules.parlay_max_price)), sgp };
}

/* ================= FanDuel player props =================
   ESPN publishes DraftKings' prop LINES but not their prices, and DraftKings
   refuses scripted requests. FanDuel's own site reads a public JSON API (its
   app key is in every page it serves), cached on CloudFront and answering
   plain requests, with real prices on everything: over/unders, milestone
   ladders, anytime / first / last / 2+ touchdown scorers. So props come from
   FanDuel when it has the game, and fall back to ESPN's lines at the house
   price when it does not. Players are matched to Sleeper by name within the
   two teams playing, the same rule as espn.json, never league-wide. */
export const FD_BASE = 'https://sbapi.nj.sportsbook.fanduel.com/api';
export const FD_AK = 'FhMFpcPWXMeyZxOx';
export const FD_TABS = ['td-scorer-props', 'passing-props', 'receiving-props', 'rushing-props'];
export const fdPageUrl = () => `${FD_BASE}/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=${FD_AK}&timezone=America%2FNew_York`;
export const fdTabUrl = (id, tab) => `${FD_BASE}/event-page?_ak=${FD_AK}&eventId=${id}&tab=${tab}&timezone=America%2FNew_York`;

// Same normalisation as scripts/picks/build.mjs: case, accents, punctuation and suffixes.
export const normName = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

// FanDuel's games ("Away @ Home"), and which one an ESPN event is.
export function fdGames(page) {
  return Object.values(page?.attachments?.events || {}).map(e => {
    const m = String(e.name || '').match(/^(.+?) @ (.+)$/);
    return m ? { id: String(e.eventId), away: m[1].trim(), home: m[2].trim(), start: e.openDate } : null;
  }).filter(Boolean);
}
export function fdMatch(games, e) {
  const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return games.find(g => n(g.home) === n(e.homeName) && n(g.away) === n(e.awayName)
    && Math.abs(Date.parse(g.start) - Date.parse(e.commence)) < 6 * 3600000) || null;
}

// name|team -> Sleeper player, from espn.json. Two players sharing a name on one team: neither.
export function playerIndex(espnPlayers) {
  const idx = new Map();
  for (const p of Object.values(espnPlayers || {})) {
    if (!p?.team || !p?.name) continue;
    const k = `${normName(p.name)}|${p.team}`;
    idx.set(k, idx.has(k) && idx.get(k)?.id !== p.id ? null : p);
  }
  return idx;
}
const TEAM_ALIASES = { WAS: ['WSH'], WSH: ['WAS'], LAR: ['LA'], LA: ['LAR'], JAX: ['JAC'], JAC: ['JAX'] };
export function findPlayer(idx, name, teams) {
  const nm = normName(name), hits = new Map();
  for (const t of teams) for (const tt of [t, ...(TEAM_ALIASES[t] || [])]) {
    const p = idx.get(`${nm}|${tt}`);
    if (p) hits.set(p.id, p);
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

const FD_STAT = [
  [/PASSING_\+_RUSHING_YARDS|PASSING_AND_RUSHING_YARDS/, 'pass_rush_yd'],
  [/RUSHING_\+_RECEIVING_YARDS|RUSHING_AND_RECEIVING_YARDS/, 'rush_rec_yd'],
  [/PASSING_YARDS/, 'pass_yd'], [/PASSING_TOUCHDOWNS|PASSING_TDS/, 'pass_td'],
  [/PASS(ING)?_COMPLETIONS/, 'pass_cmp'], [/PASS(ING)?_ATTEMPTS/, 'pass_att'], [/INTERCEPTIONS/, 'pass_int'],
  [/RECEIVING_YARDS/, 'rec_yd'], [/RECEPTIONS/, 'rec'], [/RUSHING_YARDS/, 'rush_yd'], [/RUSHING_ATTEMPTS|CARRIES/, 'rush_att'],
];
const FD_TD = { ANY_TIME_TOUCHDOWN_SCORER: 'atd', FIRST_TOUCHDOWN_SCORER: 'ftd', LAST_TOUCHDOWN_SCORER: 'ltd',
  'TO_SCORE_2+_TOUCHDOWNS': 'td2', 'TO_SCORE_3+_TOUCHDOWNS': 'td3', 'TO_SCORE_4+_TOUCHDOWNS': 'td4' };

/* FanDuel's markets for one game, as casino_lines rows. Ids carry the Sleeper
   id: prop:<espn event>:s<sleeper>:<market>:<over|under|ms50|yes>. A milestone
   ("50+ Yards") is an over at 49.5 with its own price; an over/under is only
   offered when both sides are there. */
export function fdPropLines(markets, e, { season, week, idx }) {
  const teams = [e.home, e.away].filter(Boolean), out = new Map();
  const base = { season, week, event: `nfl:${e.id}`, sport: 'prop', event_label: e.label, commence_at: e.commence,
    state: e.state, score: e.score, team: null, teams: null };
  const add = (who, market, side, suffix, point, odds) => {
    const american = Number(odds?.americanDisplayOdds?.americanOdds ?? odds?.americanDisplayOdds?.americanOddsInt);
    if (!Number.isFinite(american) || Math.abs(american) < 100) return;
    const id = `prop:${e.id}:s${who.id}:${market}:${suffix}`;
    if (!out.has(id)) out.set(id, { ...base, id, market, side, point, label: who.name, player: String(who.id),
      nfl_team: who.team || null, american, price: americanToDecimal(american) });
  };
  for (const m of Object.values(markets || {})) {
    if (m.marketStatus && m.marketStatus !== 'OPEN') continue;
    const type = String(m.marketType || '');
    const runners = (m.runners || []).filter(r => !r.runnerStatus || r.runnerStatus === 'ACTIVE');
    if (FD_TD[type]) {
      for (const r of runners) { const who = findPlayer(idx, r.runnerName, teams); if (who) add(who, FD_TD[type], 'yes', 'yes', null, r.winRunnerOdds); }
      continue;
    }
    if (!/^PLAYER_X_/.test(type)) continue;
    const stat = FD_STAT.find(([re]) => re.test(type))?.[1];
    const who = stat && findPlayer(idx, String(m.marketName || '').split(' - ')[0], teams);
    if (!who) continue;
    if (/^PLAYER_X_ALT_/.test(type)) {
      for (const r of runners) {
        const k = Number(String(r.runnerName).match(/(\d+)\+/)?.[1]);
        if (k > 0) add(who, stat, 'over', `ms${k}`, k - 0.5, r.winRunnerOdds);
      }
    } else {
      for (const r of runners) {
        const side = r.result?.type === 'OVER' || / over$/i.test(r.runnerName) ? 'over'
          : r.result?.type === 'UNDER' || / under$/i.test(r.runnerName) ? 'under' : null;
        if (side && Number.isFinite(Number(r.handicap))) add(who, stat, side, side, Number(r.handicap), r.winRunnerOdds);
      }
    }
  }
  const rows = [...out.values()];
  const ids = new Set(rows.map(l => l.id));
  return rows.filter(l => (l.side !== 'over' && l.side !== 'under') || /:ms\d+$/.test(l.id)
    || ids.has(l.id.replace(/:(over|under)$/, l.side === 'over' ? ':under' : ':over')));
}

/* First and last touchdown scorer: ESPN's scoring plays in order, then the
   play itself for the scorer's ESPN id (no name guessing). Returns the plays
   to fetch for a summary; the sync resolves them. */
export function tdPlays(summary) {
  const tds = (summary?.scoringPlays || []).filter(p => p?.scoringType?.name === 'touchdown');
  return { first: tds[0]?.id ?? null, last: tds.at(-1)?.id ?? null, any: tds.length > 0 };
}
export const scorerOf = play => {
  const p = (play?.participants || []).find(x => x?.type === 'scorer');
  return String(p?.athlete?.$ref || '').match(/athletes\/(\d+)/)?.[1] ?? null;
};
