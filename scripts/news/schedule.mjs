export const TIME_ZONE = 'America/New_York';
export const POLL_THRESHOLD = 8;
const DAY = 86400000;
const format = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function eastern(value) {
  const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, day: new Date(`${date}T12:00:00Z`).getUTCDay(),
    minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function weekFor(now, seasonStart) {
  const start = Date.parse(`${seasonStart}T00:00:00Z`);
  if (!Number.isFinite(start)) throw new Error('Missing valid season start date');
  const anchor = start - ((new Date(start).getUTCDay() - 2 + 7) % 7) * DAY;
  return Math.min(18, Math.max(1, Math.floor((Date.parse(`${eastern(now).date}T00:00:00Z`) - anchor) / (7 * DAY)) + 1));
}

export function normalizeGames(raw, week) {
  const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
  return rows.filter(g => !g.metadata?.canceled).map(g => {
    const start = Number(g.start_time) || Date.parse(g.metadata?.date_time);
    if (!Number.isFinite(start)) throw new Error('NFL game has no valid kickoff time');
    return { id: String(g.game_id ?? g.provider_id), week, start,
      ...eastern(start), home: g.metadata?.home_team, away: g.metadata?.away_team,
      complete: g.status === 'complete' || g.metadata?.is_over === true,
      started: g.metadata?.has_started === true || g.metadata?.is_in_progress === true,
      status: g.status, event: g.metadata?.event_name || '' };
  });
}

// Pure scheduling: writing and network calls happen only after a slot is due.
// Article IDs are stable across retries; publication, not generation, fills a slot.
// Why nothing is due, in one line. A silent "no editions" is indistinguishable
// from a broken scheduler, which is how a hand-written article quietly taking
// today's slot looked like an outage.
export function explainIdle({ now, week, games, articles, ballotCount }) {
  const today = eastern(new Date(now).getTime());
  const todayGames = games.filter(g => g.date === today.date);
  const dated = articles.filter(a => (a.editorialDate || a.date?.slice(0, 10)) === today.date);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.day];
  const clock = `${String(Math.floor(today.minute / 60)).padStart(2, '0')}:${String(today.minute % 60).padStart(2, '0')} ET`;
  const where = `${day} ${today.date} ${clock}, week ${week}`;
  if (dated.length && !todayGames.length) {
    return `${where}: today's slot is already filled by ${dated.map(a => a.id).join(', ')} — no second article on a day without games.`;
  }
  if (today.minute < 17 * 60 && !todayGames.length) {
    return `${where}: the daily edition is written at 17:00 ET; ${Math.ceil((17 * 60 - today.minute) / 60)}h to go.`;
  }
  if (!games.filter(g => g.week === week).length) {
    return `${where}: no regular-season schedule loaded for this week.`;
  }
  return `${where}: ${todayGames.length} game(s) today, ${ballotCount} ballot(s) in, ${dated.length} article(s) already dated today — no slot open.`;
}

export function planPosts({ now, season, week, games, articles, ballotCount, moves = {} }) {
  const time = new Date(now).getTime(), today = eastern(time);
  const yesterday = new Date(Date.parse(`${today.date}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  const published = new Set(articles.map(a => a.id));
  const jobs = [];
  const add = (date, slot, kind, storyWeek, extra = {}) => {
    const id = `${season}-w${storyWeek}-${date}-${slot}`;
    if (!published.has(id)) jobs.push({ id, date, slot, kind, week: storyWeek, season, ...extra });
  };
  const currentGames = games.filter(g => g.week === week);
  if (!currentGames.length) return jobs; // No regular-season schedule, no invented game day.

  // Roster moves are their own edition. A trade is not the weekly recap and
  // should not have to queue behind it, or wait for a day with nothing else on:
  // the Jameis Winston deal landed on a Tuesday and went unwritten because the
  // recap had already taken the day's only slot.
  // A deal is news for two days. Without this the first run would try to write
  // up every trade of the season at once, none of which is still news.
  // Sleeper sends epoch milliseconds; accept a timestamp string too rather than
  // silently treating an unparsable value as ancient and dropping the story.
  const FRESH = 48 * 3600000;
  const when = v => { const n = Number(v); return Number.isFinite(n) ? n : Date.parse(v); };
  const seenTx = new Set(articles.flatMap(a => a.txIds || []));
  const seenInj = new Set(articles.flatMap(a => a.injIds || []));
  const freshTrades = (moves.trades || []).filter(t => {
    const at = when(t.at);
    return !seenTx.has(t.id) && (!Number.isFinite(at) || time - at <= FRESH);
  });
  const freshInjuries = (moves.injuries || []).filter(i => !seenInj.has(i.key));
  if (freshTrades.length || freshInjuries.length) {
    const what = freshTrades.length
      ? (freshInjuries.length ? 'the completed trade(s) and any newly ruled-out starter' : 'the completed trade(s)')
      : 'the newly ruled-out starter(s)';
    add(today.date, 'moves', freshTrades.length ? 'trade' : 'injury', week, {
      txIds: freshTrades.map(t => t.id), injIds: freshInjuries.map(i => i.key),
      brief: `Roster-move story: cover ${what}. Say who gave up what, and what it means for the lineup. ` +
        `Do not re-report anything already covered in a previous story.` });
  }
  const todayGames = games.filter(g => g.date === today.date);
  const hasDaily = articles.some(a => (a.editorialDate || a.date?.slice(0, 10)) === today.date &&
    (a.slot === undefined || a.slot === 'daily'));
  const pollPublished = articles.some(a => a.kind === 'poll' && a.week === week &&
    (a.season === season || Number(a.date?.slice(0, 4)) === season));

  // Wednesday/Thursday are explicit editions. Crossing eight votes earlier does
  // not trigger a post; Thursday satire cannot become a second rankings release.
  if (today.minute >= 17 * 60 && (!hasDaily || todayGames.length)) {
    if (today.day === 3 || today.day === 4) {
      const poll = !pollPublished && (today.day === 4 || ballotCount >= POLL_THRESHOLD);
      add(today.date, 'daily', poll ? 'poll' : 'satire', week,
        { brief: poll ? 'Weekly power rankings; report the ballot count at publication.'
          : today.day === 4 ? 'Fantasy-team satire, optionally tied to tonight’s game. The poll already ran if supplied.'
            : 'Fantasy-team satire while the poll waits for Thursday; do not publish rankings.' });
    } else if (today.day === 2) {
      const previous = games.filter(g => g.week === week - 1);
      if (previous.length && previous.every(g => g.complete)) {
        add(today.date, 'daily', 'recap', week - 1, { brief: 'Full weekly recap, including Monday. Compare all six fantasy matchups.' });
      } else if (week === 1) {
        add(today.date, 'daily', 'daily', week, { brief: 'Opening-week league story, or satire if there is no substantive news.' });
      }
    } else if (!todayGames.length) {
      add(today.date, 'daily', 'satire', week,
        { brief: 'Fantasy-team satire. Trades and injuries have their own edition; do not duplicate one here.' });
    }
  }

  if (today.day === 0 && todayGames.length) {
    const early = todayGames.filter(g => g.minute >= 12 * 60 && g.minute < 16 * 60);
    const late = todayGames.filter(g => g.minute >= 16 * 60 && g.minute < 19 * 60);
    for (const [slot, minute, slate] of [['early-preview', 12 * 60, early], ['late-preview', 16 * 60, late]]) {
      // Never backfill a preview after the whole slate has kicked off.
      if (slate.length && today.minute >= minute && time < Math.max(...slate.map(g => g.start))) {
        add(today.date, slot, 'matchup', week, { gameIds: slate.map(g => g.id), expiresAt: Math.max(...slate.map(g => g.start)),
          brief: `${slot === 'early-preview' ? 'Sunday noon early' : 'Sunday 4 PM late'} slate preview. Acknowledge any games already underway.` });
      }
    }
  }

  for (const date of [yesterday, today.date]) {
    const dayGames = games.filter(g => g.date === date);
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const label = ({ 0: 'SNF', 1: 'MNF', 4: 'TNF' })[day];
    if (!label) continue;
    const primetime = dayGames.filter(g => g.minute >= (day === 0 ? 19 : 17) * 60);
    if (!primetime.length) continue;
    const firstKickoff = Math.min(...primetime.map(g => g.start));
    const storyWeek = primetime[0].week;
    const weeklyRecapped = articles.some(a => a.kind === 'recap' && a.week === storyWeek &&
      (a.season === season || Number(a.date?.slice(0, 4)) === season) &&
      (a.slot === 'daily' || a.id === `${season}-w${storyWeek}-recap`));
    if (time >= firstKickoff - 3600000 && time < firstKickoff && primetime.every(g => !g.started && !g.complete)) {
      add(date, `${label.toLowerCase()}-preview`, 'matchup', storyWeek,
        { gameIds: primetime.map(g => g.id), expiresAt: firstKickoff, brief: `${label} pregame preview; cover the whole primetime slate if it is a doubleheader.` });
    }
    // SNF's postgame edition is also the entire Sunday recap: never two copies.
    const recapGames = day === 0 ? dayGames : primetime;
    if (!weeklyRecapped && time >= firstKickoff && recapGames.every(g => g.complete)) {
      add(date, `${label.toLowerCase()}-recap`, 'recap', storyWeek,
        { gameIds: recapGames.map(g => g.id), brief: day === 0
          ? 'Recap the entire Sunday, early and late slates plus SNF. Distinguish settled matchups from those still awaiting Monday.'
          : `${label} postgame recap, after all games in this primetime slate are final.` });
    }
  }
  return jobs;
}
