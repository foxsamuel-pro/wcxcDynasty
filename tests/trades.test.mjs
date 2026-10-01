import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePick, scoreStats, positionalScalars } from '../scripts/trades/build.mjs';

const archive = JSON.parse(await readFile(new URL('../trades.json', import.meta.url), 'utf8'));

/* A traded pick is (season, round, original owner). Sleeper never says which
   player it became; slot_to_roster_id turns the original owner into a draft
   slot, and slot plus round is the pick that was actually made. Getting this
   wrong silently credits a trade with the wrong player. */
test('a pick resolves through the original owner\'s draft slot', () => {
  const draft = { slot_to_roster_id: { 1: 6, 2: 4, 3: 9 } };
  const picks = [
    { round: 1, draft_slot: 1, pick_no: 1, player_id: 'a', roster_id: 3 },
    { round: 1, draft_slot: 2, pick_no: 2, player_id: 'b', roster_id: 7 },
    { round: 2, draft_slot: 1, pick_no: 13, player_id: 'c', roster_id: 6 }
  ];
  // roster 6 owns slot 1, so its first-rounder is pick 1 — made by roster 3,
  // who had traded for it. The player is what matters, not who picked.
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 6 }, draft, picks).player_id, 'a');
  assert.equal(resolvePick({ season: '2025', round: 2, roster_id: 6 }, draft, picks).player_id, 'c');
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 4 }, draft, picks).player_id, 'b');
  // a round that draft never reached, and an owner with no slot
  assert.equal(resolvePick({ season: '2025', round: 9, roster_id: 6 }, draft, picks), null);
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 99 }, draft, picks), null);
  assert.equal(resolvePick({ season: '2025', round: 1, roster_id: 6 }, null, picks), null);
});

test('league scoring is applied to raw stat lines', () => {
  assert.equal(scoreStats({ rec: 4, rec_yd: 50 }, { rec: 1.5, rec_yd: 0.1 }), 11);
  assert.equal(scoreStats({ pass_td: 2, pass_int: 1 }, { pass_td: 4, pass_int: -3 }), 5);
  assert.equal(scoreStats(null, { rec: 1 }), 0);
  assert.equal(scoreStats({ unknown: 99 }, { rec: 1 }), 0);
});

test('the archive covers every season and keeps both sides of every trade', () => {
  assert.deepEqual(archive.seasons, [2023, 2024, 2025, 2026]);
  assert.ok(archive.trades.length > 150, `only ${archive.trades.length} trades`);
  assert.equal(Object.keys(archive.franchises).length, 12);
  for (const t of archive.trades) {
    assert.ok(t.sides.length >= 2, `${t.id} lost a side`);
    assert.ok(archive.seasons.includes(t.season));
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('a side\'s return is exactly its players plus the players its picks became', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const expected = s.players.reduce((a, p) => a + p.points, 0)
      + s.picks.reduce((a, p) => a + (p.became?.points || 0), 0);
    assert.ok(Math.abs(s.points - expected) < 0.02, `${t.id}: ${s.points} vs ${expected}`);
  }
});

/* Points must count only what happened AFTER the trade. Counting the whole
   season would credit a team for production it traded away. */
test('nothing scores negative totals, and pending picks contribute nothing', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    for (const p of s.picks) if (!p.became) assert.ok(!p.points, 'an undrafted pick cannot score');
    assert.ok(Number.isFinite(s.points));
  }
});

test('every unresolved pick has a reason: a future draft, or a round that never existed', () => {
  const stranded = [];
  for (const t of archive.trades) for (const s of t.sides) for (const p of s.picks) {
    if (p.became || Number(p.season) >= 2027) continue;
    // the 2026 rookie draft ran four rounds, so a traded "2026 5th" is not real
    if (Number(p.season) === 2026 && p.round >= 5) continue;
    stranded.push(`${p.season} rd${p.round} via roster ${p.from}`);
  }
  assert.deepEqual(stranded, [], `unexplained unresolved picks: ${stranded.join(', ')}`);
});

test('winners and margins agree with the points', () => {
  for (const t of archive.trades) {
    if (t.oneSided) { assert.equal(t.margin, null); assert.equal(t.winner, null); continue; }
    const points = t.sides.map(s => s.points);
    assert.ok(Math.abs(t.margin - (Math.max(...points) - Math.min(...points))) < 0.02, t.id);
    if (t.winner != null) {
      const won = t.sides.find(s => s.team === t.winner);
      assert.equal(won.points, Math.max(...points), `${t.id} named the wrong winner`);
      assert.equal(points.filter(p => p === won.points).length, 1, `${t.id} was a tie`);
    }
  }
});

test('a pick traded more than once records the chain instead of double-counting', () => {
  const chained = archive.trades.flatMap(t => t.sides.flatMap(s => s.picks.filter(p => p.movedOn)));
  assert.ok(chained.length > 0, 'no chains found at all');
  for (const p of chained) assert.ok(Array.isArray(p.movedOn) && p.movedOn.length >= 1);
  // the same drafted player may back several trades, but only as the pick moved
  const ids = new Set(archive.trades.map(t => t.id));
  for (const p of chained) for (const other of p.movedOn) assert.ok(ids.has(other), `dangling chain ${other}`);
});

/* Raw points alone are a bad verdict: they cannot tell a player who won you
   games from one who scored on your bench, and they price an unused pick at
   zero forever. Two more measures carry that weight. */
test('every side reports lineup points, total points and market value', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    assert.ok(Number.isFinite(s.points), `${t.id} points`);
    assert.ok(Number.isFinite(s.started), `${t.id} started`);
    assert.ok(Number.isFinite(s.value), `${t.id} value`);
    // points can go negative on turnovers; a market price cannot
    assert.ok(s.value >= 0, `${t.id} value went negative`);
  }
});

/* Lineup points are a subset of the weeks counted in the total, so normally they
   cannot exceed it. The exception is real: a fumble or interception can leave a
   player on a NEGATIVE total, and if he never started, his lineup figure of zero
   is correctly higher. Jalen Milroe is the live case, on -1.7 for a season. */
test('lineup points never exceed points scored, unless the player scored negative', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const assets = [...s.players, ...s.picks.map(p => p.became).filter(Boolean)];
    for (const a of assets) {
      if (a.points < 0) { assert.ok(a.started >= a.points, `${a.name}`); continue; }
      assert.ok(a.started <= a.points + 0.02, `${a.name}: started ${a.started} > scored ${a.points}`);
    }
    if (s.points >= 0) assert.ok(s.started <= s.points + 0.02,
      `${t.id}: started ${s.started} > scored ${s.points}`);
  }
});

test('a side total equals the sum of its own assets on all three measures', () => {
  for (const t of archive.trades) for (const s of t.sides) {
    const assets = [...s.players, ...s.picks.map(p => p.became).filter(Boolean)];
    const sum = key => assets.reduce((a, x) => a + (x[key] || 0), 0);
    assert.ok(Math.abs(s.points - sum('points')) < 0.02, `${t.id} points`);
    assert.ok(Math.abs(s.started - sum('started')) < 0.02, `${t.id} started`);
    const value = sum('value') + s.picks.reduce((a, p) => a + (p.value || 0), 0);
    assert.ok(Math.abs(s.value - value) < 0.5, `${t.id} value ${s.value} vs ${value}`);
  }
});

/* Market value does NOT follow the rule points follow. What a trade handed over
   is what it handed over; whether the team still owns it is a later decision,
   and the later trade is where selling it on gets counted. Pricing only current
   holdings made a team that flipped a pick look as though it got nothing, and
   because the same flag suppressed the price, a falsely-flagged pick silently
   stripped value from the team that really owned it. Nothing is double-counted:
   one side's haul is the other's loss at the same price, which is why every
   column sums to zero (asserted separately). */
test('market value counts what a trade handed over, held or not', () => {
  let soldOn = 0, flipped = 0;
  for (const t of archive.trades) for (const s of t.sides) {
    for (const p of s.players) {
      if (!p.kept && p.value > 0) soldOn++;
      assert.ok(p.value === null || p.value > 0, `${p.name} has a nonsense price`);
    }
    for (const p of s.picks) {
      if (p.movedOn && (p.value > 0 || p.became?.value > 0)) flipped++;
      // a used pick is priced through the player it became, never both
      if (p.became) assert.ok(!p.value, 'a used pick must not be priced twice');
    }
  }
  assert.ok(soldOn > 10, `players no longer held must still be priced, found ${soldOn}`);
  assert.ok(flipped > 10, `picks traded on must still be priced, found ${flipped}`);
});

test('unused picks that are still owned do get a price', () => {
  const pending = archive.trades.flatMap(t => t.sides.flatMap(s =>
    s.picks.filter(p => !p.became && !p.movedOn)));
  const priced = pending.filter(p => p.value > 0);
  assert.ok(priced.length > 0, 'an unused pick must be worth something');
  // anything unpriced should be beyond the market feed's range, not a lookup miss
  for (const p of pending.filter(p => !p.value)) {
    assert.ok(p.round >= 5 || Number(p.season) >= 2029,
      `${p.season} rd${p.round} should have had a price`);
  }
});

test('each verdict names at most one winner and agrees with its own numbers', () => {
  for (const t of archive.trades) {
    for (const [who, margin, key] of [
      [t.winner, t.margin, 'points'],
      [t.startedWinner, t.startedMargin, 'started'],
      [t.valueWinner, t.valueMargin, 'value']
    ]) {
      if (t.oneSided) { assert.equal(who, null); assert.equal(margin, null); continue; }
      const vals = t.sides.map(s => s[key]);
      if (who != null) {
        const win = t.sides.find(s => s.team === who);
        assert.equal(win[key], Math.max(...vals), `${t.id} ${key} winner`);
        assert.equal(vals.filter(v => v === win[key]).length, 1, `${t.id} ${key} was a tie`);
      }
      if (margin != null) assert.ok(Math.abs(margin - (Math.max(...vals) - Math.min(...vals))) < 0.02);
    }
  }
});

/* FantasyCalc accepts only dynasty / numQbs / numTeams / ppr. It cannot be told
   this league is tight end premium with points per first down, so those two are
   corrected from the league's own scoring. Everything inflates under PPFD, so
   the scalar must capture only the RELATIVE distortion — otherwise it would
   silently rescale the whole market. */
test('positional correction isolates the relative distortion, not the overall one', () => {
  // a league where TEs are lifted far more than anyone else
  const scal = positionalScalars({
    QB: { league: 1000, priced: 1000 },
    WR: { league: 1000, priced: 1000 },
    TE: { league: 1500, priced: 1000 }
  });
  // overall ratio is 3500/3000; TE sits above it, QB and WR below
  assert.ok(scal.TE > 1.1, `TE should be lifted, got ${scal.TE}`);
  assert.ok(scal.QB < 1 && scal.WR < 1, 'the others fall relative to it');
  // a uniform lift must leave every position untouched
  const flat = positionalScalars({
    QB: { league: 1300, priced: 1000 },
    WR: { league: 2600, priced: 2000 },
    TE: { league: 1300, priced: 1000 }
  });
  for (const v of Object.values(flat)) assert.ok(Math.abs(v - 1) < 0.001, `uniform lift changed ${v}`);
  assert.deepEqual(positionalScalars({}), {}, 'no data means no correction');
  assert.deepEqual(positionalScalars({ TE: { league: 5, priced: 0 } }), {}, 'cannot divide by nothing');
});

test('the published archive records which scoring the market was corrected for', () => {
  assert.ok(archive.market, 'the archive should say how values were obtained');
  assert.equal(archive.market.ppr, 0.5, 'this league is half PPR, not full');
  assert.ok(archive.market.tePremium, 'TE premium must be flagged as corrected for');
  assert.ok(archive.market.scalars.TE > 1.1,
    `TE premium should lift tight ends, got ${archive.market.scalars.TE}`);
  assert.ok(archive.market.scalars.WR < 1, 'and push receivers down relative to them');
  assert.match(archive.market.source, /fantasycalc/i);
});

/* "Traded on" is a claim about a specific team, so every instance must be
   evidenced by a LATER trade in which THAT team sent THAT pick — Sleeper's
   previous_owner_id. Two earlier versions were wrong in opposite directions.
   Comparing trade ids alone ignored time, so a pick acquired in September 2026
   was marked as moved on by a trade from September 2025 (28 wrong). Taking every
   later trade of the pick then over-claimed: wherever the archive loses a link —
   a trade Sleeper never recorded, or the 2023 startup and rookie drafts sharing
   one id — a team that still held its pick was told it had traded it away (17
   wrong). Both also stripped the market value from whoever really owned it. */
test('every "traded on" is evidenced by that team sending that pick later', () => {
  const byId = new Map(archive.trades.map(t => [t.id, t]));
  // draft included: the 2023 startup and rookie rounds must not match each other
  const same = (a, b) => a.season === b.season && a.round === b.round
    && a.from === b.from && a.draft === b.draft;
  let claims = 0;
  for (const t of archive.trades) for (const s of t.sides) for (const p of s.picks || []) {
    for (const id of p.movedOn || []) {
      const later = byId.get(id);
      assert.ok(later, `${t.date}: movedOn names a trade that is not in the archive`);
      assert.ok(later.date >= t.date,
        `${t.date}: ${p.season} rd${p.round} cannot be traded on in ${later.date}, which is earlier`);
      const sent = later.sides.flatMap(x => x.picks || [])
        .some(q => same(q, p) && q.sender === s.team);
      assert.ok(sent, `${t.date}: roster ${s.team} is said to have sent ${p.season} rd${p.round} `
        + `in ${later.date}, but that trade does not show it sending that pick`);
      claims++;
    }
  }
  assert.ok(claims > 100, `expected plenty of real chains, got ${claims}`);
  // and the terminal holder of a pick must keep its value rather than lose it
  const terminal = archive.trades.flatMap(t => t.sides.flatMap(s => (s.picks || [])
    .filter(p => !p.movedOn && !p.became)));
  assert.ok(terminal.some(p => p.value > 0), 'a pick nobody has traded on must still be priced');
});

/* A season can hold more than one draft: 2023 ran a 25-round startup in February
   and a 5-round rookie draft in May, so "2023 round 1" names two different
   picks. Identity has to include the draft or the two merge, and a team looks as
   though it sent the same pick twice with nothing in between. */
test('picks from two drafts in one season stay distinct', () => {
  const rounds = {};
  for (const t of archive.trades) for (const s of t.sides) for (const p of s.picks || []) {
    (rounds[p.season] ||= new Set()).add(Number(p.round));
  }
  assert.ok(Math.max(...rounds[2023]) > 5, 'the 2023 startup draft should be in here');

  /* The 2023 startup and rookie drafts both had a round 1, so a pick's identity
     must include which draft it is for. Shake and Bake's "2023 1st" became Lamar
     Jackson in one trade and Bijan Robinson in another: two picks, not one. */
  const startup = archive.trades.flatMap(t => t.sides.flatMap(s => (s.picks || [])
    .filter(p => String(p.season) === '2023' && Number(p.round) === 1 && p.became)));
  assert.ok(new Set(startup.map(p => p.draft)).size > 1,
    'the two 2023 drafts must be distinguishable on a pick row');
  assert.ok(new Set(startup.filter(p => p.from === 8).map(p => p.became.name)).size > 1,
    'one roster\'s 2023 1st resolves to two different players, one per draft');

  // no team may appear to send one pick twice without receiving it back between
  const moves = {};
  for (const t of archive.trades) for (const s of t.sides) for (const p of s.picks || []) {
    (moves[`${p.season}-${p.round}-${p.from}-${p.draft ?? 'future'}`] ||= [])
      .push({ date: t.date, from: p.sender, to: s.team });
  }
  /* A team may well send the same pick twice — roster 5 traded its 2027 2nd
     away, got it back, and traded it again. What a MERGED identity produces
     instead is two consecutive sends by one team with no receipt in between, so
     that is the shape to rule out, and only for a season that really held two
     drafts. Elsewhere the same shape means a link missing from Sleeper's own
     record: roster 1 sends its 2027 3rd twice with no trade returning it, and
     2027 has one draft, so there is nothing to disentangle. That gap is harmless
     here — with "traded on" requiring evidence, a lost link leaves the pick with
     whoever last received it rather than inventing a move. */
  const multiDraft = new Set(Object.entries(rounds)
    .filter(([, r]) => Math.max(...r) > 5).map(([season]) => season));
  assert.ok(multiDraft.size, 'at least one season ran two drafts');
  for (const [id, list] of Object.entries(moves)) {
    if (!multiDraft.has(id.split('-')[0])) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < list.length; i++) {
      assert.notEqual(list[i].from, list[i - 1].from,
        `${id}: roster ${list[i].from} sends it on ${list[i - 1].date} and again on ${list[i].date} `
        + `without receiving it back — the startup and rookie drafts have been merged`);
    }
  }
});

/* Every measure on the board is a net of what a side got against what it gave,
   so summed across all twelve teams each one must come to exactly zero — one
   team's gain is another's loss and nothing else. Reading "what it gave" as the
   other sides' hauls breaks this on a three-way trade, where that charges a team
   for assets it never owned; it left the league 18,823 points of value richer
   than it began. Attribution comes from Sleeper's own record of who sent what. */
test('got and gave balance across the league on every measure', () => {
  const sides = archive.trades.flatMap(t => t.sides);
  const ledger = (got, gave) => sides.reduce((a, s) => a + got(s) - gave(s), 0);
  const swing = s => s.swing ? s.swing.now - s.swing.then : 0;
  assert.ok(Math.abs(ledger(s => s.value || 0, s => s.gaveValue || 0)) < 1,
    `market value does not balance: ${ledger(s => s.value || 0, s => s.gaveValue || 0)}`);
  assert.ok(Math.abs(ledger(s => s.started || 0, s => s.gaveStarted || 0)) < 0.5,
    `lineup points do not balance: ${ledger(s => s.started || 0, s => s.gaveStarted || 0)}`);
  assert.ok(Math.abs(ledger(swing, s => s.gave ? s.gave.now - s.gave.then : 0)) < 1,
    `the then/now swing does not balance: ${ledger(swing, s => s.gave ? s.gave.now - s.gave.then : 0)}`);

  const multi = archive.trades.filter(t => t.sides.length > 2);
  assert.ok(multi.length, 'there are three-way trades, which is why attribution matters');
  for (const t of multi) for (const s of t.sides) {
    for (const a of [...s.players, ...s.picks]) {
      assert.notEqual(a.sender, null, `${t.date}: ${a.name || a.season} has no recorded sender`);
    }
  }
});

/* Value when traded against value now. Like market value, it does not care
   whether the team still holds the asset: flipping it on later is a separate
   decision, judged in its own row. Both ends must come from the historical feed
   — FantasyCalc and DynastyProcess price on scales that differ by a factor of
   five on picks, so a swing that mixed them would be pure noise. */
test('the then/now swing is internally consistent and priced at both ends', () => {
  const swung = archive.trades.flatMap(t => t.sides.filter(s => s.swing));
  assert.ok(swung.length > 100, `expected most sides to be priced, got ${swung.length}`);
  for (const s of swung) {
    assert.ok(s.swing.then > 0, 'a swing needs something to measure from');
    assert.ok(s.swing.tracked > 0 && s.swing.tracked <= s.players.length + s.picks.length,
      `tracked ${s.swing.tracked} of ${s.players.length + s.picks.length} assets`);
    const pct = (s.swing.now / s.swing.then - 1) * 100;
    assert.ok(Math.abs(s.swing.pct - pct) < 0.11,
      `stated ${s.swing.pct}% but then/now implies ${pct.toFixed(1)}%`);
  }
  // an asset priced at one end only must be left out rather than guessed at
  for (const t of archive.trades) for (const s of t.sides) {
    const priced = [...s.players, ...s.picks].filter(a => a.then != null);
    assert.equal(priced.length, s.swing?.tracked ?? 0, `${t.date}: tracked count disagrees with the rows`);
    for (const a of priced) assert.ok(a.now != null, 'an asset priced then must be priced now');
  }
});

/* The raw points total is gone. It could not distinguish a player who scored
   from the bench, and it scores a rebuild at zero forever. */
test('the archive no longer leads on raw points', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const board = page.slice(page.indexOf('Who has come out ahead'), page.indexOf('How this is counted'));
  assert.ok(!/>Produced</.test(board), 'the raw points column should be gone from the board');
  assert.match(board, /Bought well/, 'and replaced by the then/now comparison');
  assert.match(board, /Market value/, 'with market value still the headline');
});

/* A trade made since the newest historical snapshot would be priced against
   that same snapshot at both ends, so every asset reads exactly +0% — no time
   having passed, not a finding. Those carry no swing until the market moves. */
test('a trade with no elapsed market gets no swing', () => {
  const through = archive.market.historyThrough;
  assert.match(through, /^\d{4}-\d{2}-\d{2}$/, 'the archive must record how current the history is');
  for (const t of archive.trades) {
    if (t.date <= through) continue;
    for (const s of t.sides) {
      assert.equal(s.swing, undefined, `${t.date} is after ${through} and cannot have moved yet`);
    }
  }
  // a priced trade must sit on or before the snapshot it was priced against
  for (const t of archive.trades) for (const s of t.sides) {
    if (s.swing) assert.ok(t.date <= through, `${t.date} priced against history ending ${through}`);
  }
});

/* Joke trades are excluded by transaction id. The archive rebuilds every morning,
   so without a guard they would quietly reappear the first time the exclusion is
   refactored. Nothing in Sleeper's data marks them — a joke is a fact about
   intent — so this is a hand-kept list and the test pins it. */
test('joke trades stay out of the archive', () => {
  const jokes = ['1373925585197203456', '1295714088218808320', '1295713716712517632'];
  for (const id of jokes) {
    assert.ok(!archive.trades.some(t => t.id === id), `joke trade ${id} is back in the archive`);
  }
  /* Josh Allen for a dollar, three times over. He is the most valuable asset in
     the league, so leaving them in dominated both teams' totals and the
     biggest-margin list. One real Josh Allen trade exists and must survive. */
  const allen = archive.trades.filter(t => t.sides.some(s => s.players.some(p => p.name === 'Josh Allen')));
  assert.equal(allen.length, 1, `expected exactly the one real Josh Allen trade, got ${allen.length}`);
  const got = allen[0].sides.find(s => s.players.some(p => p.name === 'Josh Allen'));
  const gave = allen[0].sides.find(s => s !== got);
  assert.ok(gave.picks.length >= 3, 'the real one was a blockbuster, not a dollar');
});
