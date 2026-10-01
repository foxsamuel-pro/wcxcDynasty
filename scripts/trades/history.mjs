/* Dynasty market value as it stood on a past date.
 *
 * FantasyCalc has no public history endpoint, so "what was this worth when the
 * trade happened" cannot be asked of it. DynastyProcess publishes values.csv to
 * a public git repo and has committed it weekly since 2019, which means every
 * past version is still fetchable by commit sha. That covers every trade this
 * league has ever made.
 *
 * Its numbers are on a completely different scale from FantasyCalc's — a 2027
 * 2nd is 311 here and 1551 there — so the two must never be mixed. Both ends of
 * a then-versus-now comparison come from this file, and the result is reported
 * as a proportion so the scale cancels out.
 *
 * Matching is by name, because this feed carries no Sleeper id. Suffixes are the
 * trap: "Marvin Harrison" against "Marvin Harrison Jr." costs seven percentage
 * points of match rate on its own.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const REPO = 'https://api.github.com/repos/dynastyprocess/data';
const RAW = 'https://raw.githubusercontent.com/dynastyprocess/data';
const FILE = 'files/values.csv';

export const normalName = s => String(s || '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
const tierOf = slot => slot == null ? null : slot <= 4 ? 'Early' : slot <= 8 ? 'Mid' : 'Late';

/* One snapshot: every player and pick it priced, superflex column. */
export function parseValues(csv) {
  const lines = String(csv || '').trim().split('\n');
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map(h => h.replace(/"/g, ''));
  const iName = head.indexOf('player'), iPos = head.indexOf('pos'), iVal = head.indexOf('value_2qb');
  if (iName < 0 || iVal < 0) return null;
  const players = new Map(), picks = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.match(/("[^"]*"|[^,]+)/g);
    if (!cells) continue;
    const get = i => String(cells[i] ?? '').replace(/"/g, '').trim();
    const name = get(iName), value = Number(get(iVal));
    if (!name || !Number.isFinite(value)) continue;
    if (get(iPos) === 'PICK') picks.set(name, value);
    else players.set(normalName(name), value);
  }
  return { players, picks,
    player: name => players.get(normalName(name)) ?? null,
    // try the tiered label first, then the plain round
    pick: (season, round, slot) => {
      const ord = ORD[round] || `${round}th`, tier = tierOf(slot);
      return (tier && picks.get(`${season} ${tier} ${ord}`)) ?? picks.get(`${season} ${ord}`) ?? null;
    } };
}

/* Listing commits is a GitHub API call, which is 60 an hour from an anonymous
   shared runner IP and 5,000 with a token. CI always has GITHUB_TOKEN; locally
   there is no token and four calls is comfortably inside the anonymous limit. */
const apiHeaders = () => ({ 'User-Agent': 'wcxc-trade-archive',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });

export async function loadSnapshots({ cacheDir, request = (u => fetch(u).then(r => r.ok ? r.text() : null)),
  json = (u => fetch(u, { headers: apiHeaders() }).then(r => r.ok ? r.json() : null)) } = {}) {
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  // Every commit that touched values.csv, newest first.
  const commits = [];
  for (let page = 1; page <= 8; page++) {
    const rows = await json(`${REPO}/commits?path=${FILE}&per_page=100&page=${page}`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) commits.push({ sha: c.sha, date: c.commit.committer.date.slice(0, 10) });
    if (rows.length < 100) break;
  }
  commits.sort((a, b) => b.date.localeCompare(a.date));
  const loaded = new Map();

  const read = async sha => {
    if (loaded.has(sha)) return loaded.get(sha);
    const file = cacheDir ? new URL(`dp-${sha}.csv`, cacheDir) : null;
    let csv = null;
    if (file) { try { csv = await readFile(file, 'utf8'); } catch { /* miss */ } }
    if (csv == null) {
      csv = await request(`${RAW}/${sha}/${FILE}`);
      if (csv && file) await writeFile(file, csv);
    }
    const parsed = csv ? parseValues(csv) : null;
    loaded.set(sha, parsed);
    return parsed;
  };

  return {
    count: commits.length,
    span: commits.length ? [commits.at(-1).date, commits[0].date] : [],
    latest: () => commits.length ? read(commits[0].sha) : null,
    /* The snapshot in force on a date: the most recent commit at or before it.
       A trade older than the first commit has no "then" and is reported as such
       rather than silently compared against the earliest available. */
    asOf: async date => {
      const at = commits.find(c => c.date <= date);
      return at ? { date: at.date, values: await read(at.sha) } : null;
    }
  };
}
