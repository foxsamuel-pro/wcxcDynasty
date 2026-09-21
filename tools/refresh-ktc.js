/*  Refresh ktc.json — KeepTradeCut dynasty superflex values, keyed by Sleeper player id.
 *
 *  Run it from the project root whenever you want fresh values:
 *      node tools/refresh-ktc.js
 *  then commit the updated ktc.json.
 *
 *  Why a build step instead of fetching KTC from the page: KTC has no public API,
 *  serves no CORS headers, and the rankings page is a 2.6MB HTML document. The
 *  browser cannot read it, and shipping the Sleeper player index (5MB) to every
 *  visitor just to map names would be worse. So the mapping is resolved here, once,
 *  and the site ships a ~10KB file keyed by Sleeper id.
 *
 *  KTC's robots.txt allows /dynasty-rankings (only /histories is disallowed).
 *
 *  Team values are rostered players only. Draft picks are excluded: Sleeper's
 *  roster.players array doesn't contain them, and reconstructing pick ownership
 *  from traded_picks is a different job.
 */
const fs = require("fs");
const path = require("path");

const KTC_URL = "https://keeptradecut.com/dynasty-rankings";
const SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl";
const OUT = path.join(__dirname, "..", "ktc.json");

const norm = s => String(s || "").toLowerCase()
  .replace(/[.'’`]/g, "")
  .replace(/\s+(jr|sr|ii|iii|iv|v)$/, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const isPick = p => !p.team || /^\d{4}|^(early|mid|late)/i.test(p.playerName);

// KTC uses three-letter codes where Sleeper uses two, and the two disagree on a few.
const TEAM_ALIAS = { TBB:"TB", KCC:"KC", GBP:"GB", SFO:"SF", NEP:"NE", NOS:"NO",
  LVR:"LV", JAC:"JAX", ARZ:"ARI", BLT:"BAL", HST:"HOU", CLV:"CLE", LAR:"LAR", LAC:"LAC", WAS:"WAS" };
const team = t => TEAM_ALIAS[String(t || "").toUpperCase()] || String(t || "").toUpperCase();

async function main() {
  process.stdout.write("fetching KeepTradeCut rankings… ");
  const html = await fetch(KTC_URL, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.text());
  const block = html.match(/id=["']ktc-players["'][^>]*>([\s\S]*?)<\/script>/);
  if (!block) throw new Error("couldn't find the #ktc-players JSON block — KTC changed their page");
  const players = JSON.parse(block[1].trim());
  console.log(players.length + " entries");

  process.stdout.write("fetching Sleeper player index… ");
  const sleeper = await fetch(SLEEPER_PLAYERS).then(r => r.json());
  console.log(Object.keys(sleeper).length + " players");

  // index Sleeper players by full name and by last name, both scoped by position
  const byFull = {}, byLast = {};
  for (const id of Object.keys(sleeper)) {
    const p = sleeper[id];
    if (!p || !p.position) continue;
    const full = norm(p.full_name || `${p.first_name || ""} ${p.last_name || ""}`);
    const last = norm(p.last_name);
    if (full) (byFull[full] = byFull[full] || []).push(id);
    if (last) (byLast[last] = byLast[last] || []).push(id);
  }

  const narrow = (cands, ktc) => {
    if (cands.length <= 1) return cands;
    const pos = cands.filter(id => sleeper[id].position === ktc.position);
    let out = pos.length ? pos : cands;
    if (out.length > 1) {
      const sameTeam = out.filter(id => team(sleeper[id].team) === team(ktc.team));
      if (sameTeam.length) out = sameTeam;
    }
    return out;
  };

  const values = {};
  let exact = 0, viaLast = 0;
  const unmatched = [];

  for (const p of players) {
    const v = p.superflexValues && p.superflexValues.value;
    if (typeof v !== "number" || isPick(p)) continue;

    let hit = narrow(byFull[norm(p.playerName)] || [], p);
    if (hit.length) { exact++; }
    else {
      // nickname mismatches: KTC "Kenneth Gainwell" vs Sleeper "Kenny Gainwell",
      // "Bam Knight" vs "Zonovan Knight", "Chigoziem" vs "Chig".
      const last = norm(String(p.playerName).split(" ").slice(1).join(" ")) || norm(p.playerName);
      const pool = (byLast[last] || []).filter(id => sleeper[id].position === p.position);
      // prefer same team; otherwise accept only if exactly one active player fits,
      // since KTC's team field lags trades and free agency
      const sameTeam = pool.filter(id => team(sleeper[id].team) === team(p.team));
      const active = pool.filter(id => sleeper[id].team);
      hit = sameTeam.length ? sameTeam : (active.length === 1 ? active : []);
      if (hit.length) viaLast++;
    }
    if (!hit.length) { unmatched.push(`${p.playerName} (${p.position} ${p.team})`); continue; }
    values[hit[0]] = v;
  }

  console.log(`matched ${exact} by name, ${viaLast} by last name + position + team`);
  if (unmatched.length) console.log(`unmatched (${unmatched.length}): ${unmatched.slice(0, 10).join(", ")}`);

  const out = {
    generated: new Date().toISOString(),
    format: "dynasty superflex",
    source: "keeptradecut.com/dynasty-rankings",
    note: "Keyed by Sleeper player_id. Rostered players only; draft picks are not included.",
    count: Object.keys(values).length,
    values
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${out.count} players, ${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`);
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
