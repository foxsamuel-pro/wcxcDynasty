import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadInput, hash } from './data.mjs';
import { simulate, MODEL_VERSION, SIMULATIONS } from './model.mjs';

export function dueToday(old, now = new Date()) {
  const eastern = { timeZone: 'America/New_York' };
  const hour = Number(now.toLocaleString('en-US', { ...eastern, hour: '2-digit', hourCycle: 'h23' }));
  if (hour < 6) return false;
  const today = now.toLocaleDateString('en-CA', eastern);
  const previous = new Date(old?.generated).toLocaleDateString('en-CA', eastern);
  return today !== previous || old?.modelVersion !== MODEL_VERSION;
}
export async function main() {
  const file = new URL('../../odds.json', import.meta.url);
  if (process.argv.includes('--daily')) {
    let old;
    try { old = JSON.parse(await readFile(file, 'utf8')); } catch { /* first publication */ }
    if (!dueToday(old)) { console.log('No daily update due yet.'); return; }
  }
  const input = await loadInput(), inputHash = hash(input), seed = parseInt(inputHash.slice(0, 8), 16), sims = SIMULATIONS;
  console.log(`Simulating ${sims} seasons, ${input.players.length} players, weeks ${input.firstOpen}–${input.lastWeek}`);
  const rows = simulate(input, sims, seed);
  for (const [key, expected] of Object.entries({ po: 6, div: 3, bye: 2, final: 2, title: 1 })) {
    if (Math.abs(rows.reduce((sum, r) => sum + r[key], 0) - expected) > 1e-8) throw new Error(`Invalid probability totals: ${key}`);
  }
  if (rows.some(r => Object.entries(r).some(([k, v]) => k !== 'interval' && v !== null && !Number.isFinite(v)))) throw new Error('Non-finite odds');
  if (rows.some(r => r.title > r.final || r.final > r.po || r.bye > r.div || r.div > r.po))
    throw new Error('Inconsistent qualification probabilities');
  if (rows.some(r => Math.abs(r.projW + r.projL + r.projT - input.lastRegular * (input.medianMatch ? 2 : 1)) > 1e-8))
    throw new Error('Projected records do not cover exactly the regular season');
  const output = { modelVersion: MODEL_VERSION, generated: new Date().toISOString(), leagueId: input.leagueId,
    season: input.season, sims, inputHash, firstOpen: input.firstOpen, lastRegular: input.lastRegular,
    lastWeek: input.lastWeek, medianMatch: input.medianMatch, reseed: input.reseed,
    historicalSeasons: input.history.years,
    calibration: Object.fromEntries(Object.entries(input.history.positions).map(([p, h]) => [p,
      { alpha: h.alpha, profiles: h.profiles, absenceRate: h.hazard, absencePlayerSeasons: h.absencePlayerSeasons, validation: h.validation }])),
    records: Object.fromEntries(input.teams.map(t => [t.id, t.record])), rows };
  // Only replace the last good forecast after every fetch and validation succeeds.
  const temporary = new URL('../../odds.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify(output, null, 2) + '\n');
  await rename(temporary, file);
  console.log(JSON.stringify(rows.map(r => ({ id: r.id, playoffs: r.po, title: r.title, points: r.meanPoints })), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.error(e); process.exitCode = 1; });
