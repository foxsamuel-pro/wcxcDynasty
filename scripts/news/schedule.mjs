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
export function planPosts({ now, season, week, games, articles, ballotCount }) {
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
  const todayGames = games.filter(g => g.date === today.date);
  const hasDaily = articles.some(a => (a.editorialDate || a.date?.slice(0, 10)) === today.date);
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
      add(today.date, 'daily', 'daily', week,
        { brief: 'One league story: a meaningful completed trade or significant injury; otherwise fantasy-team satire.' });
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
    if (time >= firstKickoff - 3600000 && time < firstKickoff && primetime.every(g => !g.started && !g.complete)) {
      add(date, `${label.toLowerCase()}-preview`, 'matchup', storyWeek,
        { gameIds: primetime.map(g => g.id), expiresAt: firstKickoff, brief: `${label} pregame preview; cover the whole primetime slate if it is a doubleheader.` });
    }
    // SNF's postgame edition is also the entire Sunday recap: never two copies.
    const recapGames = day === 0 ? dayGames : primetime;
    if (time >= firstKickoff && recapGames.every(g => g.complete)) {
      add(date, `${label.toLowerCase()}-recap`, 'recap', storyWeek,
        { gameIds: recapGames.map(g => g.id), brief: day === 0
          ? 'Recap the entire Sunday, early and late slates plus SNF. Distinguish settled matchups from those still awaiting Monday.'
          : `${label} postgame recap, after all games in this primetime slate are final.` });
    }
  }
  return jobs;
}
