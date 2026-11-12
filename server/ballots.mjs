/* Poll ballots on Cloudflare D1. The Worker in server/worker.mjs is a thin
   wrapper around these, so the rules can be tested under plain Node.

   Same rules the old Supabase submit_ballot() had: one ballot per team per
   week, resubmitting replaces it, and a team's first-ever ballot sets the
   team's password. Passwords are PBKDF2-SHA256 through WebCrypto (bcrypt is not
   native to Workers, and Workers cap PBKDF2 at 100,000 iterations).          */

const ET = 'America/New_York';
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Tue 00:00 -> Thu 20:00 ET, the same rule as windowOpen() in index.html
export function windowOpen(now = new Date()) {
  const p = etFmt.formatToParts(now), g = t => p.find(x => x.type === t)?.value;
  const dow = DOW[g('weekday')] ?? 0, hour = +g('hour');
  return dow === 2 || dow === 3 || (dow === 4 && hour < 20);
}

export class BallotError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function checkBallot(body) {
  const b = body && typeof body === 'object' ? body : {};
  const season = b.season, week = b.week, voter = b.voter, ranking = b.ranking;
  const password = typeof b.password === 'string' ? b.password.trim() : '';
  if (!Number.isInteger(voter) || voter < 1 || voter > 12) throw new BallotError('Pick your team first.');
  if (!Number.isInteger(season) || season < 2020 || season > 2100) throw new BallotError('That season doesn\'t exist.');
  if (!Number.isInteger(week) || week < 1 || week > 18) throw new BallotError('That week doesn\'t exist.');
  if (!Array.isArray(ranking) || ranking.length !== 12 ||
      new Set(ranking.filter(x => Number.isInteger(x) && x >= 1 && x <= 12)).size !== 12) {
    throw new BallotError('Rank all 12 teams exactly once.');
  }
  if (password.length < 4) throw new BallotError('Your password needs at least 4 characters.');
  if (password.length > 200) throw new BallotError('That password is too long.');
  return { season, week, voter, ranking, password };
}

const ITERATIONS = 100000;
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

// stored as pbkdf2$<iterations>$<salt>$<hash>, so the cost can rise later
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2' || !hash) return false;
  const want = unb64(hash), got = await derive(password, unb64(salt), +iter);
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  return diff === 0;
}

// The rows the page and the news script read, in the shape Supabase returned
export async function listBallots(db, season) {
  const sql = 'select season, week, voter, ranking, updated_at from ballots' +
    (season ? ' where season = ?' : '') + ' order by season, week, voter';
  const stmt = season ? db.prepare(sql).bind(season) : db.prepare(sql);
  const { results } = await stmt.all();
  return results.map(r => ({ ...r, ranking: JSON.parse(r.ranking) }));
}

export async function submitBallot(db, body, now = new Date()) {
  if (!windowOpen(now)) throw new BallotError('Voting is closed. Ballots open Tuesday 12:00 AM and close Thursday 8:00 PM, Eastern.', 403);
  const b = checkBallot(body);
  let created = false;
  const existing = await db.prepare('select pw_hash from team_passwords where voter = ?').bind(b.voter).first('pw_hash');
  if (existing == null) {
    // First ballot for this team: the password they enter becomes the team's
    // password. If two first ballots race, the loser is checked like any other.
    const res = await db.prepare('insert into team_passwords (voter, pw_hash) values (?, ?) on conflict (voter) do nothing')
      .bind(b.voter, await hashPassword(b.password)).run();
    created = res.meta.changes === 1;
  }
  if (!created) {
    const stored = existing ?? await db.prepare('select pw_hash from team_passwords where voter = ?').bind(b.voter).first('pw_hash');
    if (!(await checkPassword(b.password, stored))) throw new BallotError('Wrong password for this team.', 403);
  }
  await db.prepare(`insert into ballots (season, week, voter, ranking, updated_at) values (?, ?, ?, ?, ?)
    on conflict (season, week, voter) do update set ranking = excluded.ranking, updated_at = excluded.updated_at`)
    .bind(b.season, b.week, b.voter, JSON.stringify(b.ranking), now.toISOString()).run();
  return created ? 'created' : 'saved';
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
