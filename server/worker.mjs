// /api/* for the site. Everything else is served straight from the assets.
//   GET  /api/ballots[?season=2026]   every ballot, public
//   POST /api/ballot                  {season, week, voter, ranking, password} -> {result}
import { listBallots, submitBallot, BallotError, json } from './ballots.mjs';

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/api/ballots' && request.method === 'GET') {
      try {
        return json(await listBallots(env.DB, Number(searchParams.get('season')) || null));
      } catch (e) {
        return json({ error: 'Couldn\'t load ballots.' }, 500);
      }
    }
    if (pathname === '/api/ballot' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Couldn\'t read that ballot.' }, 400); }
      try {
        return json({ result: await submitBallot(env.DB, body) });
      } catch (e) {
        if (e instanceof BallotError) return json({ error: e.message }, e.status);
        return json({ error: 'Couldn\'t submit. Try again.' }, 500);
      }
    }
    if (pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(request);
  }
};
