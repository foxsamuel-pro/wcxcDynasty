// Pure simulation: no network, browser state, polls, or team-strength estimates.
export const MODEL_VERSION = 2;
export const SIMULATIONS = 10000;
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
export const variance = a => a.length > 1 ? a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) : 0;
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function normal(random) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}
export function scoreStats(stats, scoring) {
  return Object.entries(scoring).reduce((n, [key, value]) => n + (Number(stats?.[key]) || 0) * value, 0);
}
const FLEX = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'], WR_RB_FLEX: ['WR', 'RB'] };
export const eligible = (player, slot) => (FLEX[slot] || [slot]).some(p => player.positions.includes(p));

// Rectangular Hungarian assignment: optimal expected points, never hindsight.
// Dummies allow an empty slot; required players represent already-locked starters.
export function lineup(pool, slots, required = new Set()) {
  const n = slots.length, m = pool.length + n;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  const allowed = (i, j) => eligible(pool[j], slots[i]) && (pool[j].fixedSlot == null || pool[j].fixedSlot === i);
  const cost = (i, j) => j >= pool.length ? 0 : allowed(i, j)
    ? -pool[j].value - (required.has(pool[j].id) ? 1e6 : 0) : 1e9;
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity), used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0]);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const chosen = [];
  for (let j = 1; j <= pool.length; j++) if (p[j] && allowed(p[j] - 1, j - 1)) chosen.push(pool[j - 1]);
  if ([...required].some(id => !chosen.some(x => x.id === id))) throw new Error('Locked lineup is not legal');
  return chosen;
}

// Plackett-Luce weighted permutation, implemented by an exponential race.
export function lottery(players, profiles, alpha, random) {
  const order = players.map((p, i) => ({ p, key: -Math.log(Math.max(1e-12, random())) * (i + 1) ** alpha }))
    .sort((a, b) => a.key - b.key);
  const sorted = [...profiles].sort((a, b) => b.mu - a.mu);
  return Object.fromEntries(order.map(({ p }, i) => {
    const x = sorted[Math.min(sorted.length - 1, Math.floor((i + .5) * sorted.length / order.length))];
    return [p.id, { ...x }];
  }));
}
// Fit ranking uncertainty against historical forecast rank -> realized PPG order.
export function fitAlpha(seasons) {
  let best = { alpha: 1, loss: Infinity };
  for (let alpha = .25; alpha <= 6; alpha += .25) {
    let loss = 0;
    for (const rows of seasons) {
      const order = [...rows].sort((a, b) => b.mu - a.mu);
      const weights = order.map(x => x.rank ** -alpha);
      let remaining = weights.reduce((a, b) => a + b, 0);
      for (const weight of weights) { loss += Math.log(Math.max(weight, remaining) / weight); remaining -= weight; }
    }
    if (loss < best.loss) best = { alpha, loss };
  }
  return best.alpha;
}
export function rankingLoss(rows, alpha) {
  const weights = [...rows].sort((a, b) => b.mu - a.mu).map(p => p.rank ** -alpha);
  let remaining = weights.reduce((a, b) => a + b, 0), loss = 0;
  for (const weight of weights) { loss += Math.log(Math.max(weight, remaining) / weight); remaining -= weight; }
  return loss / rows.length;
}
export function wilson(p, n) {
  const z2 = 1.959963984540054 ** 2, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d, half = Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) * Math.sqrt(z2) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function addWeek(standings, points, pairs, medianMatch) {
  const result = (id, a, b) => standings[id][a > b ? 'w' : a < b ? 'l' : 't']++;
  for (const [a, b] of pairs) {
    standings[a].pf += points[a]; standings[b].pf += points[b];
    standings[a].pa += points[b]; standings[b].pa += points[a];
    result(a, points[a], points[b]); result(b, points[b], points[a]);
  }
  if (medianMatch) {
    const scores = Object.values(points).sort((a, b) => a - b), n = scores.length;
    const median = n % 2 ? scores[(n - 1) / 2] : (scores[n / 2 - 1] + scores[n / 2]) / 2;
    for (const id of Object.keys(points)) result(id, points[id], median);
  }
}
export function seedField(teams, standings, random) {
  const tie = Object.fromEntries(teams.map(t => [t.id, random()]));
  const pct = x => (x.w + x.t / 2) / Math.max(1, x.w + x.l + x.t);
  const cents = x => Math.round(x * 100);
  const compare = (a, b) => pct(standings[b.id]) - pct(standings[a.id]) ||
    cents(standings[b.id].pf) - cents(standings[a.id].pf) || cents(standings[b.id].pa) - cents(standings[a.id].pa) || tie[a.id] - tie[b.id];
  const winners = [...new Set(teams.map(t => t.div))].map(d => teams.filter(t => t.div === d).sort(compare)[0]).sort(compare);
  const byes = winners.slice(0, 2), winnerIds = new Set(winners.map(t => t.id));
  const wild = teams.filter(t => !winnerIds.has(t.id)).sort(compare).slice(0, 6 - winners.length);
  return { winners, byes, seeds: [...byes, ...[...winners.slice(2), ...wild].sort(compare)] };
}

// Forecasts supply the relative week-to-week matchup/role adjustment, while the
// historical lottery supplies the scoring level. Averaging across projected
// active weeks preserves that player's assigned season PPG.
export function weeklyProfile(player, talent, week) {
  const factor = player.projected > 0 ? Math.max(0, player.weekly[week] || 0) / player.projected : 0;
  return { mu: talent.mu * factor, sd: talent.sd * factor };
}

export function simulate(input, sims = SIMULATIONS, seed = 1) {
  const { teams, players, history, slots, weeks, firstOpen, lastRegular, lastWeek, medianMatch } = input;
  const random = rng(seed), ids = teams.map(t => t.id);
  const acc = Object.fromEntries(ids.map(id => [id, { id, po: 0, div: 0, bye: 0, final: 0, title: 0, projW: 0, projL: 0, projT: 0, points: 0, pointWeeks: 0 }]));
  const positions = Object.keys(history.positions);
  const ranked = Object.fromEntries(positions.map(pos => [pos, players.filter(p => p.pos === pos).sort((a, b) => b.projected - a.projected || a.id.localeCompare(b.id))]));
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  for (let s = 0; s < sims; s++) {
    const talent = {}, absent = {};
    for (const pos of positions) {
      const h = history.positions[pos], cohort = h.seasons[Math.floor(random() * h.seasons.length)];
      Object.assign(talent, lottery(ranked[pos], cohort, h.alpha, random));
    }
    const standings = Object.fromEntries(teams.map(t => [t.id, { ...t.record }]));
    const scores = {};
    for (let w = firstOpen; w <= lastWeek; w++) {
      const week = weeks[w], available = {}, profiles = {};
      for (const p of players) {
        const h = history.positions[p.pos];
        // Bye weeks do not create an injury; a prior absence can heal during one.
        absent[p.id] = absent[p.id] ? random() >= h.recovery : week.active.includes(p.team) && random() < h.hazard;
        available[p.id] = !absent[p.id] && week.active.includes(p.team) && p.weekly[w] > 0;
        profiles[p.id] = weeklyProfile(p, talent[p.id], w);
      }
      scores[w] = {};
      for (const team of teams) {
        const locked = week.locked?.[team.id] || {}, required = new Set(Object.keys(locked));
        const pool = team.players.map(id => byId[id]).filter(p => p && (required.has(p.id) || available[p.id] && !week.finished.includes(p.team)))
          .map(p => ({ ...p, value: required.has(p.id) ? locked[p.id] : profiles[p.id].mu, fixedSlot: week.lockedSlots?.[team.id]?.[p.id] }));
        // A historical starter may since have been traded/dropped.
        for (const id of required) if (!pool.some(p => p.id === id) && byId[id]) pool.push({ ...byId[id], value: locked[id], fixedSlot: week.lockedSlots?.[team.id]?.[id] });
        const chosen = lineup(pool, slots, required);
        const points = Math.round(chosen.reduce((sum, p) => sum + (required.has(p.id) ? locked[p.id] : profiles[p.id].mu + normal(random) * profiles[p.id].sd), 0) * 100) / 100;
        scores[w][team.id] = week.finalPoints?.[team.id] ?? points;
        if (w <= lastRegular) { acc[team.id].points += points; acc[team.id].pointWeeks++; }
      }
      if (w <= lastRegular) addWeek(standings, scores[w], week.pairs, medianMatch);
    }
    const field = seedField(teams, standings, random), seeds = field.seeds.map(t => t.id);
    field.winners.forEach(t => acc[t.id].div++); field.byes.forEach(t => acc[t.id].bye++);
    seeds.forEach(id => acc[id].po++);
    const beat = (a, b, w) => {
      const actual = input.bracket?.find(g => g.r === w - lastRegular && [g.t1, g.t2].includes(a) && [g.t1, g.t2].includes(b));
      if (actual?.w != null) return actual.w;
      const aScore = scores[w]?.[a], bScore = scores[w]?.[b];
      if (!Number.isFinite(aScore) || !Number.isFinite(bScore)) throw new Error(`Missing playoff score for week ${w}`);
      return aScore > bScore || aScore === bScore && seeds.indexOf(a) < seeds.indexOf(b) ? a : b;
    };
    // Actual first-round participants preserve commissioner seeding once known.
    const actualR1 = input.bracket?.filter(g => g.r === 1 && g.t1 && g.t2 && !g.p) || [];
    let r1 = actualR1.length === 2 ? actualR1.map(g => beat(g.t1, g.t2, lastRegular + 1)) :
      [beat(seeds[2], seeds[5], lastRegular + 1), beat(seeds[3], seeds[4], lastRegular + 1)];
    if (input.reseed) r1 = r1.sort((a, b) => seeds.indexOf(b) - seeds.indexOf(a));
    else r1.reverse(); // Fixed bracket: seed 1 plays winner of 4/5.
    const finalists = [beat(seeds[0], r1[0], lastRegular + 2), beat(seeds[1], r1[1], lastRegular + 2)];
    finalists.forEach(id => acc[id].final++);
    acc[beat(...finalists, lastRegular + 3)].title++;
    for (const id of ids) { acc[id].projW += standings[id].w; acc[id].projL += standings[id].l; acc[id].projT += standings[id].t; }
  }
  return Object.values(acc).map(a => {
    const row = { id: a.id, meanPoints: a.pointWeeks ? a.points / a.pointWeeks : null };
    for (const k of ['po', 'div', 'bye', 'final', 'title', 'projW', 'projL', 'projT']) row[k] = a[k] / sims;
    row.interval = Object.fromEntries(['po', 'div', 'bye', 'final', 'title'].map(k => [k, wilson(row[k], sims)]));
    return row;
  }).sort((a, b) => b.po - a.po || b.title - a.title || b.projW - a.projW);
}
