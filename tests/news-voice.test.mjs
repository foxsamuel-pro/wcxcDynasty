/* The editorial rules the writer prompt has to carry, and the facts behind them.
   Each of these corresponds to something that went wrong in print, so a prompt
   edit that quietly drops one should fail here rather than in an article. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { siteConfig } from '../scripts/news/data.mjs';

const writer = await readFile(new URL('../scripts/news/writer.mjs', import.meta.url), 'utf8');
const SYSTEM = writer.slice(writer.indexOf('Satire is fiction'), writer.indexOf('One limit,'));
// the prompt is hard-wrapped, so a phrase can straddle a newline
const FLAT = SYSTEM.replace(/\s+/g, ' ');

/* Which lineup slot a player occupies is bookkeeping. It is not how a manager
   sees a player, and Sleeper's starters array being ordered by slot is not a
   fact about the team — it is how the array happens to be stored. */
test('the prompt forbids naming lineup slots', () => {
  assert.match(FLAT, /Never name a lineup slot/);
  for (const dead of ['a zero in the flex spot', 'Started him in the flex', 'stuck in the superflex']) {
    assert.ok(FLAT.includes(dead), `the prompt should name "${dead}" as a phrase to avoid`);
  }
  assert.match(FLAT, /order starters are listed in is not a fact/,
    'the prompt must say the array order is not a fact');
  // but eligibility still has to be known, or jokes rest on invented rules
  assert.match(FLAT, /Four spots here accept a tight end and two quarterbacks can start/);
  assert.match(FLAT, /Know the rule; never recite it/);
  // and the old slot-order recital must be gone
  assert.ok(!/QB\/RB\/RB\/WR\/WR\/WR\/TE\/FLEX\/FLEX\/SUPER_FLEX/.test(writer),
    'reciting the slot order is what taught it to write "the flex spot"');
});

/* "Parkers Dead Sons with a 0 in the flex spot" was false: the starter was
   questionable and was substituted. The league allows three subs, so any
   pre-kickoff claim about an empty spot is a guess. */
test('the prompt forbids predicting an empty lineup spot', () => {
  assert.match(FLAT, /Do not predict an empty lineup spot/);
  assert.match(FLAT, /allows substitutions/);
  assert.match(FLAT, /take a zero there/, 'the exact wrong phrasing is worth naming');
  // once the games are played it is a fact again, and that must stay sayable
  assert.match(FLAT, /Once the games are played the lineup is settled/);
});

test('satire is allowed events, not only quotes', () => {
  assert.match(FLAT, /Let things actually happen/);
  assert.match(FLAT, /break into a rival team's facility/);
  assert.match(FLAT, /The invention is in the events; the record and the scores stay real/);
});

/* Most teams keep a retired player as coaching staff. It cannot be derived from
   Sleeper: Nick Chubb played fifteen games in 2025 and is Beasty Boys' head
   coach, while Tyreek Hill is equally teamless and is just a stashed player.
   Roles also vary — Tyler Lockett is a player development coach, not a head
   coach — so both the name and the title are declared. */
test('coaching staff is declared with roles, optional, and never invented', async () => {
  const config = await siteConfig();
  const ids = Object.keys(config.coaches);
  assert.ok(ids.length >= 6, 'most teams have staff');
  assert.ok(ids.length < 12, 'but not all of them — that is the point');
  assert.deepEqual(config.coaches['10'], [{ name: 'Nick Chubb', role: 'head coach' }],
    'the undetectable case must be declared');
  assert.deepEqual(config.coaches['3'], [{ name: 'Tyler Lockett', role: 'player development coach' }],
    'a role that is not head coach must survive parsing');
  for (const [id, people] of Object.entries(config.coaches)) {
    assert.ok(Number(id) >= 1 && Number(id) <= 12, `roster ${id} is not in this league`);
    for (const { name, role } of people) {
      assert.ok(/^[A-Z][a-zA-Z'.\- ]+$/.test(name), `${name} does not read as a person's name`);
      assert.ok(role && !/,/.test(role), `${name} has a malformed role: ${role}`);
    }
  }
  assert.match(FLAT, /Use the role exactly as given/);
  assert.match(FLAT, /never promote or reassign anyone/);
  assert.match(FLAT, /A team with no "staff" entry has none/);
  assert.match(FLAT, /never describe an active player as staff/);
});

/* A manager is named by real first name, never a Sleeper handle, and an article
   names the TEAM for anything the team did. Both have been corrected in print. */
test('the long-standing naming rules survive prompt edits', async () => {
  const config = await siteConfig();
  assert.equal(config.managers['10'], 'Chip', 'real first names, never the handle');
  assert.equal(config.shortNames['5'], 'Dead Sons', 'second reference is configured, not guessed');
  assert.ok(!/Chipster04/.test(writer), 'no handles anywhere near the prompt');
});
