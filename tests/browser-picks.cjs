/* Pick 'em harness. Runs the real page in jsdom with Sleeper and Supabase
   stubbed, so the window logic, the pick interaction, grading and the win
   probability are all exercised against the shipped code. */
/* Not part of `node --test`: it needs jsdom, which this repo does not depend on.
   Run it by hand when the Pick 'em page changes:
     node tests/browser-picks.cjs                      # whatever the clock says
     PK_NOW=2026-10-06T14:00:00Z node tests/browser-picks.cjs   # window open
     PK_NOW=2026-10-05T16:00:00Z node tests/browser-picks.cjs   # window shut
   tests/picks-ui.test.mjs covers the same logic in a vm and does run in CI;
   this one additionally drives the real DOM, so it catches wiring the vm cannot. */
const fs = require("fs");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch {
  console.log("jsdom is not installed — skipping the browser harness.");
  console.log("  npm i -g jsdom, or run tests/picks-ui.test.mjs, which needs nothing.");
  process.exit(0);
}
const P = "c:/Users/sam/Desktop/Dynasty team/Dynasty Website/";
const html = fs.readFileSync(P + "index.html", "utf8");
const positions = JSON.parse(fs.readFileSync(P + "positions.json", "utf8"));
const news = JSON.parse(fs.readFileSync(P + "news.json", "utf8"));
const trades = JSON.parse(fs.readFileSync(P + "trades.json", "utf8"));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n + "   " + x)); };

// ---- fixtures -------------------------------------------------------------
const TEAM_IDS = [1,2,3,4,5,6,7,8,9,10,11,12];
const LEAGUE = {
  season: "2026", total_rosters: 12, previous_league_id: "0", avatar: null, metadata: {},
  settings: { divisions: 3, playoff_teams: 6, playoff_week_start: 15, league_average_match: 1, max_subs: 3 },
  scoring_settings: { pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1,
    rec_td: 6, bonus_rec_te: 0.5, rec_fd: 1, rush_fd: 1, pass_fd: 0.4 }
};
const ROSTERS = TEAM_IDS.map(id => ({ roster_id: id, owner_id: "u" + id,
  players: [], settings: { wins: 4, losses: 2, ties: 0, fpts: 500 + id, fpts_decimal: 0,
    ppts: 600, ppts_decimal: 0, fpts_against: 480, fpts_against_decimal: 0, division: ((id - 1) % 3) + 1 } }));
const USERS = TEAM_IDS.map(id => ({ user_id: "u" + id, display_name: "handle" + id,
  metadata: { team_name: "Team " + id } }));
const STATE = { season: "2026", season_type: "regular", week: 4, season_start_date: "2026-09-09" };

// Pick a handful of real player ids per position so the spread factors apply.
const byPos = {};
for (const [id, pos] of Object.entries(positions.positions)) {
  if (positions.teams[id]) (byPos[pos] ||= []).push(id);
}
const SLOTS = ["QB","RB","RB","WR","WR","WR","TE","RB","WR","QB"];
let cursor = {};
const nextId = pos => { cursor[pos] = (cursor[pos] || 0) + 1; return byPos[pos][cursor[pos] % byPos[pos].length]; };
function makeMatchups(week, { points = 0 } = {}) {
  cursor = {};
  return TEAM_IDS.map(id => ({ roster_id: id, matchup_id: Math.ceil(id / 2),
    points, starters: SLOTS.map(nextId), players_points: {} }));
}
// week 3 is finished with known scores so grading has something to chew on
const W3 = TEAM_IDS.map(id => ({ roster_id: id, matchup_id: Math.ceil(id / 2),
  points: id % 2 === 1 ? 120 + id : 100 + id, starters: [], players_points: {} }));
const PROJ = {};
for (const pos of ["QB","RB","WR","TE"]) for (const id of byPos[pos].slice(0, 400)) {
  PROJ[id] = pos === "QB" ? { pass_yd: 250, pass_td: 2, pass_fd: 18 }
    : pos === "RB" ? { rush_yd: 70, rush_td: 0.5, rec: 3, rec_yd: 25, rush_fd: 4 }
    : pos === "WR" ? { rec: 5, rec_yd: 65, rec_td: 0.4, rec_fd: 4 }
    : { rec: 4, rec_yd: 45, rec_td: 0.3, rec_fd: 3 };
}
const SCORES = w => Array.from({ length: 14 }, (_, i) => ({
  status: w < 4 ? "complete" : "pre_game", week: w,
  metadata: { home_team: "HOME" + i, away_team: "AWAY" + i, is_over: w < 4 } }));

let PICK_ROWS = [];
let rpcCalls = [];

// ---- stubs ----------------------------------------------------------------
const real = global.fetch;
function route(url) {
  const s = String(url);
  const j = d => Promise.resolve({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
  if (s.endsWith("/v1/league/1312128506452283392")) return j(LEAGUE);
  if (s.endsWith("/rosters")) return j(ROSTERS);
  if (s.endsWith("/users")) return j(USERS);
  if (s.endsWith("/v1/state/nfl")) return j(STATE);
  let m = s.match(/\/matchups\/(\d+)$/);
  if (m) { const w = +m[1]; return j(w === 3 ? W3 : w <= 3 ? makeMatchups(w, { points: 110 }) : makeMatchups(w)); }
  if (/\/v1\/projections\/nfl\/regular\/2026\/\d+/.test(s)) return j(PROJ);
  m = s.match(/\/scores\/nfl\/regular\/2026\/(\d+)/);
  if (m) return j(SCORES(+m[1]));
  if (s === "positions.json") return j(positions);
  if (s === "news.json") return j(news);
  if (s === "trades.json") return j(trades);
  if (s === "odds.json") return j({ generated: "2026-10-01", sims: 10000, teams: {} });
  return real(s);
}

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(w) {
    w.fetch = route;
    /* Freeze the clock when asked, so the Tue 00:00 -> Thu 20:00 window can be
       tested on both sides of the boundary rather than whenever the suite runs. */
    if (process.env.PK_NOW) {
      const fixed = new Date(process.env.PK_NOW).getTime();
      const Real = w.Date;
      class Frozen extends Real {
        constructor(...a) { super(...(a.length ? a : [fixed])); }
        static now() { return fixed; }
      }
      Frozen.parse = Real.parse; Frozen.UTC = Real.UTC;
      w.Date = Frozen;
    }
    // Minimal Supabase client: ballots empty, picks from PICK_ROWS, rpc recorded.
    w.supabase = { createClient: () => ({
      from: table => ({ select: () => ({ eq: async () => ({
        data: table === "picks" ? PICK_ROWS.map(r => ({ ...r, season: 2026 })) : [], error: null }) }) }),
      channel: () => ({ on() { return this }, subscribe() { return this } }),
      rpc: async (name, args) => { rpcCalls.push({ name, args });
        if (name !== "submit_picks") return { data: null, error: null };
        if (args.p_password === "wrongpw") return { data: null, error: { message: "Wrong password for this team." } };
        PICK_ROWS = PICK_ROWS.filter(r => !(r.week === args.p_week && r.voter === args.p_voter));
        PICK_ROWS.push({ week: args.p_week, voter: args.p_voter, picks: args.p_picks,
          updated_at: new Date().toISOString() });
        return { data: "saved", error: null }; }
    }) };
  } });

setTimeout(async () => {
  const { window } = dom, doc = window.document;
  const s = doc.createElement("script");
  s.textContent = `window.__p = { S, render, TABS, renderPicks, loadPicks, loadLines, loadSchedule,
    picksOpen, windowOpen, ballotWeek, pollWeekFor, gradePicks, pickPct, matchupOf, submitPicks,
    preloadPicks, normalCdf, SPREAD, LINES: () => LINES, SCORING: () => SCORING,
    setLines: v => { LINES = v }, SCHED: () => SCHED };`;
  doc.body.appendChild(s);
  const t = window.__p, main = doc.getElementById("main");

  console.log("=== the tab exists and is reachable ===");
  ok("picks is a registered tab", t.TABS.includes("picks"));
  const btn = doc.querySelector('.tab[data-tab="picks"]');
  ok("a Pick 'em tab button is rendered", !!btn, btn && btn.textContent);
  ok("it sits next to the ballot, not at the end", t.TABS.indexOf("picks") < t.TABS.indexOf("poll"));

  console.log("\n=== the window matches the ballot's ===");
  const at = (d, h, mi = 0) => new Date(Date.UTC(2026, 9, 4 + d, h + 4, mi)); // ET -> UTC
  // Sun=0 Mon=1 Tue=2 ... 2026-10-04 is a Sunday
  ok("shut on Monday", !t.windowOpen(at(1, 12)));
  ok("open Tuesday 00:01", t.windowOpen(at(2, 0, 1)));
  ok("open all Wednesday", t.windowOpen(at(3, 12)));
  ok("open Thursday 19:59", t.windowOpen(at(4, 19, 59)));
  ok("shut Thursday 20:01", !t.windowOpen(at(4, 20, 1)));
  ok("shut on Saturday", !t.windowOpen(at(6, 12)));

  console.log("\n=== Sleeper lines: projections and win probability ===");
  const lines = await t.loadLines(4);
  ok("six matchups for the week", lines.pairs.length === 6, lines.pairs.length);
  ok("every matchup has two sides", lines.pairs.every(p => p.sides.length === 2));
  ok("projections are real positive numbers",
     lines.pairs.every(p => p.sides.every(s => Number.isFinite(s.proj) && s.proj > 0)),
     lines.pairs[0].sides.map(s => s.proj.toFixed(1)).join(" vs "));
  ok("league scoring is applied, not a default", Math.abs(t.SCORING().bonus_rec_te - 0.5) < 1e-9);
  ok("win probabilities sum to 1 in every matchup",
     lines.pairs.every(p => Math.abs(p.sides[0].win + p.sides[1].win - 1) < 1e-9));
  ok("every win probability is a real fraction",
     lines.pairs.every(p => p.sides.every(s => s.win >= 0 && s.win <= 1)));
  // the favourite must be the higher projection
  ok("the higher projection is the favourite",
     lines.pairs.every(p => { const [a, b] = p.sides;
       return a.proj === b.proj || ((a.proj > b.proj) === (a.win > b.win)); }));
  ok("position spread is applied, not a flat factor",
     t.SPREAD.QB === 0.55 && t.SPREAD.WR === 0.85 && t.SPREAD.RB === 0.75 && t.SPREAD.TE === 0.80);
  // the normal CDF has to actually be a CDF
  ok("normalCdf(0) is a coin flip", Math.abs(t.normalCdf(0) - 0.5) < 1e-9);
  ok("normalCdf is monotonic and bounded",
     t.normalCdf(-5) < 0.001 && t.normalCdf(5) > 0.999 && t.normalCdf(-1) < t.normalCdf(1));
  ok("a 1-sigma edge lands near 84%", Math.abs(t.normalCdf(1) - 0.8413) < 0.002, t.normalCdf(1).toFixed(4));

  console.log("\n=== a finished game stops carrying points it cannot earn ===");
  // week 3 is complete in the stub, so nothing is left to play and it is settled
  const w3 = await t.loadLines(3);
  ok("a completed week has no variance left", w3.pairs.every(p => p.settled), JSON.stringify(w3.pairs[0]?.sides.map(x => x.variance)));
  ok("a settled matchup reads 100/0, never a divide-by-zero",
     w3.pairs.every(p => p.sides.some(s => s.win === 1) && p.sides.some(s => s.win === 0)),
     w3.pairs[0]?.sides.map(s => s.win).join("/"));
  ok("no NaN anywhere in a settled week",
     w3.pairs.every(p => p.sides.every(s => Number.isFinite(s.win) && Number.isFinite(s.proj))));

  console.log("\n=== rendering the page ===");
  t.S.tab = "picks"; t.S.pickWeek = 4; t.S.voter = 5;
  await t.loadSchedule();
  t.render();
  await new Promise(r => setTimeout(r, 60));
  t.render();
  let txt = main.textContent;
  ok("the heading is present", /Weekly pick 'em/.test(txt));
  ok("a card per matchup", doc.querySelectorAll(".pkbox").length === 6, doc.querySelectorAll(".pkbox").length);
  ok("both teams named on each card",
     [...doc.querySelectorAll(".pkbox .boxhd")].every(h => /vs/.test(h.textContent)));
  ok("projections are shown", /Projected/.test(txt));
  ok("win chance is shown", /Win chance/.test(txt));
  ok("a win bar per side", doc.querySelectorAll(".pkbox .winbar").length === 12,
     doc.querySelectorAll(".pkbox .winbar").length);
  ok("the window and the deadline are stated", /Thursday 8:00 PM ET/.test(txt));
  ok("a week selector exists", !!doc.getElementById("pkweek"));
  ok("methodology explains the position spread", /every position carries its own spread/.test(txt));
  ok("methodology admits what accuracy excludes", /not the league median game/.test(txt));

  console.log("\n=== picking ===");
  const open = t.picksOpen();
  console.log("     (window currently " + (open ? "open" : "shut") + " — real clock)");
  // Force the open path regardless of when the suite runs.
  t.S.pickWeek = t.ballotWeek();
  await t.loadLines(t.S.pickWeek);
  t.render(); await new Promise(r => setTimeout(r, 60)); t.render();
  const buttons = [...doc.querySelectorAll("[data-pick]")];
  if (t.picksOpen()) {
    ok("each side is a button while open", buttons.length === 12, buttons.length);
    buttons[0].click();
    ok("clicking records one pick", Object.keys(t.S.pick).length === 1, JSON.stringify(t.S.pick));
    const first = +buttons[0].dataset.pick;
    const pair = t.matchupOf(t.LINES()[t.S.pickWeek], first);
    const other = pair.teams.find(x => x !== first);
    [...doc.querySelectorAll("[data-pick]")].find(b => +b.dataset.pick === other).click();
    ok("picking the other side replaces it, never both",
       Object.keys(t.S.pick).length === 1 && t.S.pick[other] === other, JSON.stringify(t.S.pick));
    ok("submit is disabled until every matchup is picked",
       doc.getElementById("pksubmit").disabled === true);
    // fill the slate
    for (const p of t.LINES()[t.S.pickWeek].pairs) {
      [...doc.querySelectorAll("[data-pick]")].find(b => +b.dataset.pick === p.teams[0]).click();
    }
    ok("a full slate enables submit", doc.getElementById("pksubmit").disabled === false,
       Object.keys(t.S.pick).length + " picks");
    ok("a full slate is one winner per matchup", Object.keys(t.S.pick).length === 6);

    console.log("\n=== submitting ===");
    rpcCalls = [];
    doc.getElementById("pkpw").value = "abc";
    await t.submitPicks();
    ok("a short password is refused locally, no RPC", rpcCalls.length === 0 && t.S.pickMsg?.err === true,
       JSON.stringify(t.S.pickMsg));
    doc.getElementById("pkpw").value = "wrongpw";
    await t.submitPicks();
    ok("a wrong password surfaces the server's message",
       /Wrong password/.test(t.S.pickMsg?.text || ""), JSON.stringify(t.S.pickMsg));
    doc.getElementById("pkpw").value = "goodpassword";
    await t.submitPicks();
    const call = rpcCalls.filter(c => c.name === "submit_picks").pop();
    ok("the RPC is submit_picks with season, week, voter, picks, password",
       call && call.args.p_season === 2026 && call.args.p_week === t.S.pickWeek
       && call.args.p_voter === 5 && Array.isArray(call.args.p_picks) && call.args.p_picks.length === 6
       && call.args.p_password === "goodpassword", JSON.stringify(call?.args));
    ok("picks are integers, all distinct",
       new Set(call.args.p_picks).size === 6 && call.args.p_picks.every(Number.isInteger));
    ok("saving reports success", t.S.pickMsg?.err === false, JSON.stringify(t.S.pickMsg));
    ok("the saved slate is read back", t.S.picks.some(p => p.voter === 5 && p.week === t.S.pickWeek));
    t.preloadPicks(true);
    ok("reopening preloads what was saved", Object.keys(t.S.pick).length === 6);

    /* Clear has to stick. Preloading on every render would put the saved slate
       straight back and make the button look broken. */
    t.render(); await new Promise(r => setTimeout(r, 30));
    doc.getElementById("pkreset").click();
    ok("Clear empties the slate", Object.keys(t.S.pick).length === 0, JSON.stringify(t.S.pick));
    t.render();
    ok("Clear survives a re-render", Object.keys(t.S.pick).length === 0, JSON.stringify(t.S.pick));
    t.render(); t.render();
    ok("and keeps surviving repeated renders", Object.keys(t.S.pick).length === 0);
    ok("submit is disabled again after clearing", doc.getElementById("pksubmit").disabled === true);
  } else {
    ok("outside the window the sides are not buttons", buttons.length === 0);
    ok("no submit control outside the window", !doc.getElementById("pksubmit"));
    ok("the closed page still renders every matchup", doc.querySelectorAll(".pkbox").length === 6);
    // exercise the submit guard anyway
    t.S.pick = {}; rpcCalls = [];
    await t.submitPicks();
    ok("submitting while shut does nothing", rpcCalls.length === 0);
  }

  console.log("\n=== who picked what ===");
  PICK_ROWS = [
    { week: 3, voter: 1, picks: [1, 3, 5, 7, 9, 11], updated_at: "2026-09-22T01:00:00Z" },
    { week: 3, voter: 2, picks: [2, 4, 6, 8, 10, 12], updated_at: "2026-09-22T02:00:00Z" },
    { week: 3, voter: 3, picks: [1, 4, 5, 8, 9, 12], updated_at: "2026-09-22T03:00:00Z" }
  ];
  await t.loadPicks();
  t.S.pickWeek = 3; t.preloadPicks(); t.render();
  await new Promise(r => setTimeout(r, 60)); t.render();
  txt = main.textContent;
  ok("a who-picked row per card", doc.querySelectorAll(".pkrow").length === 6,
     doc.querySelectorAll(".pkrow").length);
  ok("voter names are listed", doc.querySelectorAll(".pkwho").length >= 6,
     doc.querySelectorAll(".pkwho").length);
  ok("a side nobody picked says so", /nobody/.test(txt));
  ok("pick counts are shown", /Picked by/.test(txt));
  ok("the submitted count is reported", /3 of 12 teams have picked/.test(txt), txt.match(/\d+ of 12 teams[^.]*/)?.[0]);

  console.log("\n=== grading ===");
  // week 3 stub: odd rosters score 120+id, even 100+id, paired (1,2) (3,4) ...
  // so the odd id wins every matchup. voter 1 picked all odds => 6 right.
  const g = t.gradePicks();
  ok("a perfect slate grades 6 right, 0 wrong",
     g[1].right === 6 && g[1].wrong === 0, JSON.stringify(g[1]));
  ok("the opposite slate grades 0 right, 6 wrong",
     g[2].right === 0 && g[2].wrong === 6, JSON.stringify(g[2]));
  ok("a mixed slate grades in between", g[3].right === 3 && g[3].wrong === 3, JSON.stringify(g[3]));
  ok("accuracy is right over graded", Math.abs(t.pickPct(g[1]) - 1) < 1e-9 && t.pickPct(g[2]) === 0);
  ok("a team that never picked has no accuracy", t.pickPct(g[7]) === null, JSON.stringify(g[7]));
  ok("slates submitted are counted separately from grading", g[1].made === 1, g[1].made);

  console.log("\n=== an unplayed week is not a miss ===");
  PICK_ROWS.push({ week: 9, voter: 1, picks: [1, 3, 5, 7, 9, 11], updated_at: "2026-10-01T00:00:00Z" });
  await t.loadPicks();
  const g2 = t.gradePicks();
  ok("picks for a future week are not graded",
     g2[1].right === 6 && g2[1].wrong === 0, JSON.stringify(g2[1]));
  ok("but the slate still counts as submitted", g2[1].made === 2, g2[1].made);
  ok("weeks graded does not include the future week", g2[1].weeks === 1, g2[1].weeks);

  console.log("\n=== the accuracy board ===");
  t.render(); await new Promise(r => setTimeout(r, 60)); t.render();
  txt = main.textContent;
  ok("the board renders", /Accuracy/.test(txt));
  ok("most accurate is called out", /Most accurate/.test(txt));
  ok("least accurate is called out", /Least accurate/.test(txt));
  const tiles = [...doc.querySelectorAll(".tile b")].map(b => b.textContent);
  // SHORT_NAMES is the league's own shorthand and is used verbatim, never guessed
  ok("the best picker is named first", tiles[0] === "Ripple Effect", tiles.join(" | "));
  ok("the worst picker is named second", tiles[1] === "The Tax", tiles.join(" | "));
  const boardRows = [...doc.querySelectorAll("table.cards tbody tr")];
  ok("a row per team that picked", boardRows.length === 3, boardRows.length);
  const accs = boardRows.map(r => r.querySelector('[data-l="Accuracy"]').textContent.trim());
  ok("accuracy is sorted high to low", accs.join(",") === "100.0%,50.0%,0.0%", accs.join(","));
  ok("pushes have their own column", /Push/.test(txt));
  ok("graded-weeks wording is accurate", /over 1 played week\b/.test(txt), txt.match(/over \d+ played week[s]?/)?.[0]);

  console.log("\n=== a dropped request neither loops nor strands the page ===");
  {
    let calls = 0;
    const prev = window.fetch;
    window.fetch = u => { const str = String(u);
      if (/\/matchups\/13$/.test(str)) { calls++; return Promise.resolve({ ok: false, status: 503, json: async () => null }); }
      return route(u); };
    t.S.pickWeek = 13; t.setLines({}); t.preloadPicks(true);
    t.render(); await new Promise(r => setTimeout(r, 90));
    const afterFirst = calls;
    ok("the failing week was asked for at least once", afterFirst >= 1, afterFirst);
    t.render(); t.render(); t.render();
    await new Promise(r => setTimeout(r, 90));
    ok("a failed week is not re-fetched on every render", calls === afterFirst,
       `asked ${calls} times, was ${afterFirst}`);
    ok("the page says it could not load rather than hanging on 'Loading'",
       /Couldn't reach Sleeper for the Week 13 matchups/.test(main.textContent),
       main.textContent.slice(main.textContent.indexOf("Week 13"), 120));
    ok("it promises a retry", /retries on its own/.test(main.textContent));
    window.fetch = prev;
    t.S.pickWeek = t.ballotWeek(); t.setLines({}); t.preloadPicks(true);
    t.render(); await new Promise(r => setTimeout(r, 90)); t.render();
    ok("recovering restores the real matchups", doc.querySelectorAll(".pkbox").length === 6,
       doc.querySelectorAll(".pkbox").length);
  }

  console.log("\n=== safety ===");
  ok("nothing from the data became markup", doc.querySelectorAll("#main script").length === 0);
  ok("no NaN rendered on the page", !/NaN/.test(main.textContent),
     (main.textContent.match(/.{0,40}NaN.{0,40}/) || [])[0] || "");
  ok("no undefined rendered on the page", !/undefined/.test(main.textContent),
     (main.textContent.match(/.{0,40}undefined.{0,40}/) || [])[0] || "");

  console.log("\n=== the other tabs still work ===");
  for (const [tab, re] of [["vote", /ballot|Voting|Week/i], ["poll", /WCXC Power Poll/],
       ["grid", /Ballot grid/], ["trades", /Trade archive/], ["news", /News|Loading/i]]) {
    t.S.tab = tab; t.render();
    ok(`${tab} renders`, re.test(main.textContent), main.textContent.slice(0, 50));
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, 4000);
