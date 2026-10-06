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

export function fantasyPairs({ matchups, proj, positions, teams, done = {}, scoring }) {
  const sides = (matchups || []).filter(m => m && m.matchup_id != null).map(m => {
    let remaining = 0, variance = 0;
    for (const id of (m.starters || []).filter(x => x && x !== '0')) {
      const projected = scorePoints(proj?.[id], scoring);
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

/* Fair probability plus half the hold on each side, then rounded to a whole
   American price so what is shown and what is paid are the same number. A
   4.5% hold makes a coin flip -110 a side, like a real book. */
export function priceFromProb(p, hold) {
  const implied = Math.min(0.98, Math.max(0.02, p + hold / 2));
  const american = decimalToAmerican(1 / implied);
  return { american, price: americanToDecimal(american) };
}
// Half points only, so a fantasy spread or total can never push.
const half = x => Math.floor(Math.abs(x)) + 0.5;

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
    const margin = a.proj - b.proj, pt = half(margin);
    out.push({ ...base, id: id('spread', a.team), market: 'spread', side: String(a.team), team: a.team,
      label: '', point: margin >= 0 ? -pt : pt, ...std });
    out.push({ ...base, id: id('spread', b.team), market: 'spread', side: String(b.team), team: b.team,
      label: '', point: margin >= 0 ? pt : -pt, ...std });
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
export function propOutcome(stats, market) {
  const m = PROP_BY_KEY[market];
  if (!m) return null;
  if (!stats || !(stats.gp > 0)) return { played: false };
  return { played: true, value: m.stats.reduce((a, k) => a + (Number(stats[k]) || 0), 0) };
}

/* ---------------- settlement ----------------
   A straight bet pays stake x price, pushes and voids refund. A parlay loses on
   any losing leg (as soon as one is known), drops pushed and voided legs and is
   repriced on what is left — the cap applies again — and refunds if nothing is
   left. Every payout is capped at max_payout. Returns null while undecided. */
export function settleBet(bet, legs, rules) {
  if (!legs.length) return null;
  if (legs.some(l => l.result === 'loss')) return { status: 'lost', payout: 0 };
  if (legs.some(l => !l.result)) return null;
  const wins = legs.filter(l => l.result === 'win');
  if (!wins.length) return { status: legs.some(l => l.result === 'push') ? 'push' : 'void', payout: money(bet.stake) };
  const price = bet.kind === 'parlay'
    ? parlayPrice(wins.map(l => Number(l.price)), Number(rules.parlay_max_price))
    : Number(legs[0].price);
  return { status: 'won', payout: Math.min(money(bet.stake * price), Number(rules.max_payout)) };
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
export function checkSlip({ legs, stake, voter, rules, now = Date.now(), mode = 'parlay' }) {
  const errs = [];
  if (!legs.length) return ['Add a selection first.'];
  const parlay = mode === 'parlay' && legs.length > 1;
  if (parlay && (legs.length < rules.parlay_min_legs || legs.length > rules.parlay_max_legs))
    errs.push(`Parlays take ${rules.parlay_min_legs} to ${rules.parlay_max_legs} legs.`);
  if (parlay) {
    const ev = legs.map(l => l.event);
    if (new Set(ev).size !== ev.length) errs.push('Only one leg per game. Same-game parlays aren\'t allowed.');
  }
  for (const l of legs) {
    if (l.status !== 'open') errs.push(`${l.label || 'A selection'} is suspended right now.`);
    if (l.price < rules.leg_min_price) errs.push(`${l.label || 'A selection'} is too short a price to bet.`);
    if (l.price > rules.leg_max_price) errs.push(`${l.label || 'A selection'} is too long a price to bet.`);
    if (l.state === 'pre' && now >= Date.parse(l.commence_at)) errs.push(`${l.label || 'That game'} has already kicked off.`);
    if (l.state === 'in' && (!rules.live_enabled || l.sport !== 'nfl')) errs.push(`${l.label || 'That game'} is closed for betting.`);
    if (l.state === 'post') errs.push(`${l.label || 'That game'} is over.`);
    if (l.sport === 'fantasy' && voter && (l.teams || []).includes(voter)
        && ((l.market !== 'total' && l.team !== voter) || (l.market === 'total' && l.side === 'under')))
      errs.push('You can back your own team, but you can\'t bet against it.');
  }
  const s = Number(stake);
  if (!(s > 0)) return errs.concat('Enter a stake.');
  if (Math.round(s * 100) !== s * 100) errs.push('Stake must be in dollars and cents.');
  if (s < rules.min_stake) errs.push(`Minimum stake is $${rules.min_stake}.`);
  const max = parlay ? rules.max_stake_parlay : rules.max_stake_straight;
  if (s > max) errs.push(`Maximum ${parlay ? 'parlay' : 'straight'} stake is $${max}.`);
  const price = parlay ? parlayPrice(legs.map(l => l.price), rules.parlay_max_price) : Math.max(...legs.map(l => l.price));
  if (money(s * price) > rules.max_payout)
    errs.push(`A ticket can pay at most $${rules.max_payout}, so the most you can stake at these odds is $${Math.floor(rules.max_payout / price * 100) / 100}.`);
  return errs;
}
