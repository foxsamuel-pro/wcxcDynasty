-- WCXC Poll Tracker: run this once in Supabase > SQL Editor > New query > Run.
-- Safe to re-run; it won't clobber existing ballots.

create extension if not exists pgcrypto with schema extensions;

-- One row per team per week. Resubmitting replaces the old ballot.
create table if not exists public.ballots (
  season     int  not null,
  week       int  not null check (week between 1 and 18),
  voter      int  not null check (voter between 1 and 12),   -- Sleeper roster_id
  ranking    int[] not null,                                  -- roster_ids, best first
  updated_at timestamptz not null default now(),
  primary key (season, week, voter)
);

-- Per-team password. A team's first-ever ballot sets it; every ballot after
-- that needs the same one. Nobody can read this table from the website.
create table if not exists public.team_passwords (
  voter      int primary key check (voter between 1 and 12),
  pw_hash    text not null,
  created_at timestamptz not null default now()
);

-- Replaced by the per-team table above.
drop table if exists public.league_auth;

alter table public.ballots         enable row level security;
alter table public.team_passwords  enable row level security;

-- Anyone can read ballots. No insert/update/delete policies, so the only way
-- to write is through submit_ballot() below, which checks the team's password.
drop policy if exists "Anyone can read ballots" on public.ballots;
create policy "Anyone can read ballots" on public.ballots
  for select to anon, authenticated using (true);

-- No policies at all on team_passwords, so the hashes are invisible to the site.

-- No longer used now that passwords are per-team again.
drop function if exists public.check_password(text);
drop function if exists public.set_league_password(text);

-- The only write path. A team's first ballot sets its password; every ballot
-- after that must supply the same one.
drop function if exists public.submit_ballot(int, int, int, int[], text);

create or replace function public.submit_ballot(
  p_season int, p_week int, p_voter int, p_ranking int[], p_password text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  existing text;
begin
  if p_voter is null or p_voter not between 1 and 12 then
    raise exception 'Pick your team first.';
  end if;
  if p_week is null or p_week not between 1 and 18 then
    raise exception 'That week doesn''t exist.';
  end if;
  if coalesce(array_length(p_ranking, 1), 0) <> 12
     or (select count(distinct x) from unnest(p_ranking) as x where x between 1 and 12) <> 12 then
    raise exception 'Rank all 12 teams exactly once.';
  end if;
  if p_password is null or length(p_password) < 4 then
    raise exception 'Your password needs at least 4 characters.';
  end if;

  select pw_hash into existing from team_passwords where voter = p_voter;
  if existing is null then
    -- First ballot for this team: the password they enter becomes the team's password.
    insert into team_passwords (voter, pw_hash) values (p_voter, crypt(p_password, gen_salt('bf')));
  elsif existing <> crypt(p_password, existing) then
    raise exception 'Wrong password for this team.';
  end if;

  insert into ballots (season, week, voter, ranking, updated_at)
  values (p_season, p_week, p_voter, p_ranking, now())
  on conflict (season, week, voter)
  do update set ranking = excluded.ranking, updated_at = now();

  return case when existing is null then 'created' else 'saved' end;
end;
$$;

revoke all on function public.submit_ballot(int, int, int, int[], text) from public;
grant execute on function public.submit_ballot(int, int, int, int[], text) to anon, authenticated;

-- ============================ COMMENTS ============================
-- Comments on news articles, and thumbs up/down on those comments. Identity is
-- the same per-team password used for ballots, so nobody needs a second account.

create table if not exists public.comments (
  id         bigint generated always as identity primary key,
  article    text not null check (length(article) between 1 and 120),
  voter      int  not null check (voter between 1 and 12),
  body       text not null check (length(btrim(body)) between 1 and 1500),
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);
create index if not exists comments_article_idx on public.comments (article, created_at);

create table if not exists public.comment_votes (
  comment_id bigint not null references public.comments(id) on delete cascade,
  voter      int    not null check (voter between 1 and 12),
  val        smallint not null check (val in (-1, 1)),
  primary key (comment_id, voter)
);

alter table public.comments      enable row level security;
alter table public.comment_votes enable row level security;

-- Anyone can read both. Writes only through the RPCs below, which check the
-- team password, so a comment can never be posted or voted under someone else.
drop policy if exists "Anyone can read comments" on public.comments;
create policy "Anyone can read comments" on public.comments
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read comment votes" on public.comment_votes;
create policy "Anyone can read comment votes" on public.comment_votes
  for select to anon, authenticated using (true);

-- Shared password check. A team must already have a password (i.e. have voted)
-- before it can comment — that keeps commenting tied to a real league member.
create or replace function public.check_team_password(p_voter int, p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare h text;
begin
  if p_voter is null or p_voter not between 1 and 12 then
    raise exception 'Pick your team first.';
  end if;
  select pw_hash into h from team_passwords where voter = p_voter;
  if h is null then
    raise exception 'Set your team password by casting a ballot first.';
  end if;
  if p_password is null or h <> crypt(p_password, h) then
    raise exception 'Wrong password for this team.';
  end if;
end;
$$;
revoke all on function public.check_team_password(int, text) from public, anon, authenticated;

create or replace function public.post_comment(
  p_article text, p_voter int, p_password text, p_body text
) returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare new_id bigint;
begin
  perform check_team_password(p_voter, p_password);
  if p_article is null or length(p_article) = 0 then
    raise exception 'Missing article.';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'Write something first.';
  end if;
  if length(btrim(p_body)) > 1500 then
    raise exception 'Keep it under 1500 characters.';
  end if;
  -- light rate limit: no more than 1 comment per team per 10 seconds
  if exists (select 1 from comments
             where voter = p_voter and created_at > now() - interval '10 seconds') then
    raise exception 'Slow down a moment.';
  end if;
  insert into comments (article, voter, body)
  values (p_article, p_voter, btrim(p_body))
  returning id into new_id;
  return new_id;
end;
$$;
revoke all on function public.post_comment(text, int, text, text) from public;
grant execute on function public.post_comment(text, int, text, text) to anon, authenticated;

-- val of 1 or -1 sets the vote; 0 clears it. One vote per team per comment.
create or replace function public.vote_comment(
  p_comment bigint, p_voter int, p_password text, p_val int
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform check_team_password(p_voter, p_password);
  if p_val not in (-1, 0, 1) then
    raise exception 'Bad vote.';
  end if;
  if not exists (select 1 from comments where id = p_comment) then
    raise exception 'That comment is gone.';
  end if;
  if p_val = 0 then
    delete from comment_votes where comment_id = p_comment and voter = p_voter;
  else
    insert into comment_votes (comment_id, voter, val)
    values (p_comment, p_voter, p_val)
    on conflict (comment_id, voter) do update set val = excluded.val;
  end if;
end;
$$;
revoke all on function public.vote_comment(bigint, int, text, int) from public;
grant execute on function public.vote_comment(bigint, int, text, int) to anon, authenticated;

-- A team can delete its own comment, nobody else's.
create or replace function public.delete_comment(
  p_comment bigint, p_voter int, p_password text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform check_team_password(p_voter, p_password);
  delete from comments where id = p_comment and voter = p_voter;
  if not found then
    raise exception 'That is not your comment.';
  end if;
end;
$$;
revoke all on function public.delete_comment(bigint, int, text) from public;
grant execute on function public.delete_comment(bigint, int, text) to anon, authenticated;

-- ============================ PICK 'EM ============================
-- One row per team per week: which teams that manager thinks will win each of
-- the six head-to-head matchups. Same Tue 00:00 -> Thu 20:00 window as ballots,
-- enforced on the page; like submit_ballot this accepts any week on purpose, so
-- the commissioner can backfill.
--
-- A pick is just the roster_id expected to win. No matchup id is stored, and
-- none is needed: a team plays exactly one opponent in a week, so the roster_id
-- identifies its matchup on its own. That also makes the row impossible to
-- misread later if Sleeper renumbers its matchup ids.
create table if not exists public.picks (
  season     int   not null,
  week       int   not null check (week between 1 and 18),
  voter      int   not null check (voter between 1 and 12),   -- Sleeper roster_id
  picks      int[] not null,                                   -- roster_ids picked to win
  updated_at timestamptz not null default now(),
  primary key (season, week, voter)
);

alter table public.picks enable row level security;

-- Readable by everyone, like ballots. No write policies: submit_picks() below is
-- the only way in, and it checks the team's password.
drop policy if exists "Anyone can read picks" on public.picks;
create policy "Anyone can read picks" on public.picks
  for select to anon, authenticated using (true);

drop function if exists public.submit_picks(int, int, int, int[], text);

create or replace function public.submit_picks(
  p_season int, p_week int, p_voter int, p_picks int[], p_password text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  existing text;
  n int;
begin
  if p_voter is null or p_voter not between 1 and 12 then
    raise exception 'Pick your team first.';
  end if;
  if p_week is null or p_week not between 1 and 18 then
    raise exception 'That week doesn''t exist.';
  end if;
  n := coalesce(array_length(p_picks, 1), 0);
  -- Twelve teams means six matchups, so six is the ceiling. Fewer is allowed
  -- because a week can be short a pairing; zero is not a submission.
  if n < 1 or n > 6 then
    raise exception 'Pick a winner in every matchup.';
  end if;
  -- One winner per matchup, so the same team cannot appear twice and every
  -- entry has to be a real roster.
  if (select count(distinct x) from unnest(p_picks) as x where x between 1 and 12) <> n then
    raise exception 'Those picks are not a valid set of teams.';
  end if;
  if p_password is null or length(p_password) < 4 then
    raise exception 'Your password needs at least 4 characters.';
  end if;

  select pw_hash into existing from team_passwords where voter = p_voter;
  if existing is null then
    -- Same rule as a first ballot: the password entered becomes the team's.
    insert into team_passwords (voter, pw_hash) values (p_voter, crypt(p_password, gen_salt('bf')));
  elsif existing <> crypt(p_password, existing) then
    raise exception 'Wrong password for this team.';
  end if;

  insert into picks (season, week, voter, picks, updated_at)
  values (p_season, p_week, p_voter, p_picks, now())
  on conflict (season, week, voter)
  do update set picks = excluded.picks, updated_at = now();

  return case when existing is null then 'created' else 'saved' end;
end;
$$;

revoke all on function public.submit_picks(int, int, int, int[], text) from public;
grant execute on function public.submit_picks(int, int, int, int[], text) to anon, authenticated;

-- Live updates: new ballots appear on everyone's screen without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.ballots;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.picks;
exception when duplicate_object then null;
end $$;

-- ============================ CASINO ============================
-- Play money only: nothing is bought, nothing is cashed out. Teams earn $50 for
-- a complete ballot and $50 for a complete pick 'em slate, inside the voting
-- window, and bet it on DraftKings lines (read from ESPN) and on WCXC matchups.
-- Bankrolls never reset.
--
-- Trust model: the browser can read everything and write nothing directly.
--   * place_bet() is the only way a team spends money. It re-reads every price
--     from casino_lines, so odds sent by a page are only ever compared, never used.
--   * casino_lines, outcomes, leg results and settlement are written by the
--     casino-sync edge function with the service role (see supabase/casino-cron.sql).
--   * Every movement of money is a row in casino_ledger, unique on (kind, ref),
--     so a reward, a stake, a payout or a refund can never be applied twice.

-- Limits, tunable without a deploy: update public.casino_rules set ... where id = 1;
create table if not exists public.casino_rules (
  id                 int primary key default 1 check (id = 1),
  reward_ballot      numeric(10,2) not null default 50,
  reward_picks       numeric(10,2) not null default 50,
  min_stake          numeric(10,2) not null default 1,
  max_stake_straight numeric(10,2) not null default 100,
  max_stake_parlay   numeric(10,2) not null default 25,
  max_payout         numeric(10,2) not null default 1000,
  max_open           int           not null default 10,
  parlay_min_legs    int           not null default 2,
  parlay_max_legs    int           not null default 6,
  parlay_max_price   numeric(10,4) not null default 21,      -- decimal, = +2000
  leg_min_price      numeric(10,4) not null default 1.2,     -- = -500
  leg_max_price      numeric(10,4) not null default 11,      -- = +1000
  pregame_stale_sec  int           not null default 1800,
  live_enabled       boolean       not null default false,   -- on once ESPN is seen updating odds in-game
  live_delay_sec     int           not null default 45,
  live_stale_sec     int           not null default 120,
  live_tolerance     numeric(6,4)  not null default 0.05,    -- relative price move allowed during the delay
  pending_timeout_sec int          not null default 300,
  prop_american      int           not null default -115,
  fantasy_hold       numeric(6,4)  not null default 0.045,
  season_start       date          not null default '2026-09-09',  -- kept current by casino-sync
  rewards_since      timestamptz   not null default '2026-10-06 00:00:00 America/New_York',  -- the casino opened in week 5's window
  props_synced       jsonb         not null default '{}',          -- event id -> last props fetch
  fantasy_synced_at  timestamptz,
  synced_at          timestamptz
);
insert into public.casino_rules (id) values (1) on conflict (id) do nothing;

-- One row per side of a market. Prices are decimal odds; american is display.
create table if not exists public.casino_lines (
  id          text primary key,         -- nfl:<event>:spread:home, prop:<event>:<athlete>:rec_yd:over, fan:<season>:<week>:<matchup>:ml:<roster>
  season      int  not null,
  week        int  not null,
  event       text not null,            -- one leg per event in a parlay
  sport       text not null check (sport in ('nfl','prop','fantasy')),
  market      text not null,
  side        text not null,
  label       text not null default '',
  event_label text not null default '',
  point       numeric(8,2),
  price       numeric(10,4) not null check (price > 1),
  american    int  not null,
  team        int,                      -- fantasy: the roster this side backs
  teams       int[],                    -- fantasy: both rosters in the matchup
  player      text,                     -- prop: Sleeper player id
  nfl_team    text,
  commence_at timestamptz not null,
  state       text not null default 'pre' check (state in ('pre','in','post')),
  score       text not null default '',
  status      text not null default 'open' check (status in ('open','suspended','closed')),
  outcome     jsonb,                    -- set once final; legs are graded against it
  updated_at  timestamptz not null default now()
);
create index if not exists casino_lines_week_idx  on public.casino_lines (season, week, sport, status);
create index if not exists casino_lines_event_idx on public.casino_lines (event);

create table if not exists public.bets (
  id          bigint generated always as identity primary key,
  voter       int  not null check (voter between 1 and 12),
  season      int  not null,
  kind        text not null check (kind in ('straight','parlay')),
  stake       numeric(10,2) not null check (stake > 0),
  price       numeric(10,4) not null check (price > 1),
  status      text not null check (status in ('pending','open','won','lost','push','void','rejected')),
  payout      numeric(10,2),
  note        text,
  placed_at   timestamptz not null default now(),
  accepted_at timestamptz,
  settled_at  timestamptz
);
create index if not exists bets_voter_idx  on public.bets (voter, status);
create index if not exists bets_status_idx on public.bets (status, placed_at desc);

create table if not exists public.bet_legs (
  bet_id   bigint not null references public.bets(id) on delete cascade,
  line_id  text   not null references public.casino_lines(id),
  price    numeric(10,4) not null,
  point    numeric(8,2),
  score_at text not null default '',
  result   text check (result in ('win','loss','push','void')),
  primary key (bet_id, line_id)
);
create index if not exists bet_legs_line_idx on public.bet_legs (line_id) where result is null;

create table if not exists public.casino_ledger (
  id         bigint generated always as identity primary key,
  voter      int  not null check (voter between 1 and 12),
  amount     numeric(10,2) not null,
  kind       text not null check (kind in ('ballot','picks','stake','payout','refund','adjust')),
  ref        text not null,
  created_at timestamptz not null default now(),
  unique (kind, ref)
);
create index if not exists casino_ledger_voter_idx on public.casino_ledger (voter);

alter table public.casino_rules  enable row level security;
alter table public.casino_lines  enable row level security;
alter table public.bets          enable row level security;
alter table public.bet_legs      enable row level security;
alter table public.casino_ledger enable row level security;

-- Everyone can see everything — that's the point of the leaderboard. No write
-- policies anywhere: place_bet() and the service role are the only writers.
drop policy if exists "Anyone can read casino rules" on public.casino_rules;
create policy "Anyone can read casino rules" on public.casino_rules for select to anon, authenticated using (true);
drop policy if exists "Anyone can read casino lines" on public.casino_lines;
create policy "Anyone can read casino lines" on public.casino_lines for select to anon, authenticated using (true);
drop policy if exists "Anyone can read bets" on public.bets;
create policy "Anyone can read bets" on public.bets for select to anon, authenticated using (true);
drop policy if exists "Anyone can read bet legs" on public.bet_legs;
create policy "Anyone can read bet legs" on public.bet_legs for select to anon, authenticated using (true);
drop policy if exists "Anyone can read the ledger" on public.casino_ledger;
create policy "Anyone can read the ledger" on public.casino_ledger for select to anon, authenticated using (true);

-- Twelve rows, so the page never has to page through the whole ledger.
create or replace view public.casino_bankrolls with (security_invoker = true) as
select l.voter,
       sum(l.amount)                                               as balance,
       coalesce(sum(l.amount) filter (where l.kind in ('ballot','picks','adjust')), 0) as earned,
       coalesce((select sum(b.stake) from bets b where b.voter = l.voter and b.status in ('pending','open')), 0) as at_risk,
       coalesce((select sum(b.stake) from bets b where b.voter = l.voter and b.status in ('won','lost','push','void')), 0) as staked,
       coalesce((select sum(b.payout) from bets b where b.voter = l.voter and b.status in ('won','lost','push','void')), 0) as returned,
       (select count(*) from bets b where b.voter = l.voter and b.status = 'won')  as won,
       (select count(*) from bets b where b.voter = l.voter and b.status = 'lost') as lost,
       (select count(*) from bets b where b.voter = l.voter and b.status in ('push','void')) as pushed
from casino_ledger l
group by l.voter;
grant select on public.casino_bankrolls to anon, authenticated;

/* The casino's idea of "now". Always now() in production; the offline tests
   pin it so the voting window and kickoff checks can be exercised. */
create or replace function public.casino_clock() returns timestamptz
language sql stable as $$ select now() $$;

/* Rewards. A complete ballot (12 ranks) or a complete slate (6 picks) pays once
   per team per week, and only when cast inside that week's real window — Tue
   00:00 to Thu 20:00 ET, for the week that window belongs to. The RPCs accept
   any week on purpose (commissioner backfill), so without the window check a
   backfill would mint money. Resubmitting never pays twice: (kind, ref) is unique. */
create or replace function public.casino_reward() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r casino_rules%rowtype;
  et timestamp := casino_clock() at time zone 'America/New_York';
  dow int := extract(dow from et);
  anchor date;
  wk int;
  k text;
  amt numeric;
begin
  select * into r from casino_rules where id = 1;
  if not found then return new; end if;
  if not (dow in (2, 3) or (dow = 4 and extract(hour from et) < 20)) then return new; end if;
  -- same week count as pollWeekFor() in index.html: Tuesdays from the season start
  anchor := r.season_start - ((extract(dow from r.season_start)::int - 2 + 7) % 7);
  wk := least(18, greatest(1, floor((et::date - anchor) / 7.0)::int + 1));
  if new.week <> wk or new.season <> extract(year from r.season_start)::int then return new; end if;
  if tg_table_name = 'ballots' then
    if coalesce(array_length(new.ranking, 1), 0) <> 12 then return new; end if;
    k := 'ballot'; amt := r.reward_ballot;
  else
    if coalesce(array_length(new.picks, 1), 0) < 6 then return new; end if;
    k := 'picks'; amt := r.reward_picks;
  end if;
  insert into casino_ledger (voter, amount, kind, ref)
  values (new.voter, amt, k, format('%s:%s:%s', new.season, new.week, new.voter))
  on conflict (kind, ref) do nothing;
  return new;
end;
$$;
revoke all on function public.casino_reward() from public, anon, authenticated;

drop trigger if exists casino_reward_ballot on public.ballots;
create trigger casino_reward_ballot after insert or update on public.ballots
  for each row execute function public.casino_reward();
drop trigger if exists casino_reward_picks on public.picks;
create trigger casino_reward_picks after insert or update on public.picks
  for each row execute function public.casino_reward();

/* Catch-up for anything cast before the trigger existed: the casino opened
   part-way through week 5's window, after some teams had already voted. Pays
   exactly what the trigger would have (complete, cast inside that week's own
   window) but only from rewards_since, so earlier weeks are not paid
   retroactively. Uses no clock, so it gives the same answer whenever it runs,
   and re-running pays nothing twice because (kind, ref) is unique. */
with r as (
  select *, season_start - ((extract(dow from season_start)::int - 2 + 7) % 7) as anchor
  from casino_rules where id = 1
), sub as (
  select 'ballot'::text as k, season, week, voter, updated_at,
         coalesce(array_length(ranking, 1), 0) = 12 as complete
  from ballots
  union all
  select 'picks'::text, season, week, voter, updated_at,
         coalesce(array_length(picks, 1), 0) >= 6
  from picks
)
insert into casino_ledger (voter, amount, kind, ref)
select s.voter, case when s.k = 'ballot' then r.reward_ballot else r.reward_picks end, s.k,
       format('%s:%s:%s', s.season, s.week, s.voter)
from sub s cross join r
where s.complete
  and s.season = extract(year from r.season_start)::int
  and s.updated_at >= r.rewards_since
  and s.updated_at >= ((r.anchor + (s.week - 1) * 7)::timestamp at time zone 'America/New_York')
  and s.updated_at <  (((r.anchor + (s.week - 1) * 7 + 2)::timestamp + interval '20 hours') at time zone 'America/New_York')
on conflict (kind, ref) do nothing;

/* Placing a bet. p_legs is [{"line": id, "price": decimal seen, "point": point seen}].
   One leg is a straight bet, two or more a parlay. Every price is re-read here;
   what the page sent is only compared, so a doctored request can at worst be
   refused. The team's bets are serialised by an advisory lock, so two tabs
   cannot both spend the same dollar. */
create or replace function public.place_bet(
  p_voter int, p_password text, p_legs jsonb, p_stake numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r       casino_rules%rowtype;
  l       casino_lines%rowtype;
  leg     jsonb;
  n       int;
  v_kind  text;
  v_price numeric := 1;
  v_max   numeric;
  v_live  boolean := false;
  v_ids   text[] := '{}';
  v_evts  text[] := '{}';
  v_keep  jsonb := '[]';
  v_bal   numeric;
  v_open  int;
  v_id    bigint;
  v_status text;
  seen    numeric;
  seen_pt numeric;
begin
  perform check_team_password(p_voter, p_password);
  perform pg_advisory_xact_lock(4242, p_voter);
  select * into r from casino_rules where id = 1;

  if p_stake is null or p_stake <> round(p_stake, 2) then
    raise exception 'Stake must be in dollars and cents.';
  end if;
  if p_stake < r.min_stake then
    raise exception 'Minimum stake is $%.', r.min_stake;
  end if;
  if p_legs is null or jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) = 0 then
    raise exception 'Add a selection first.';
  end if;
  n := jsonb_array_length(p_legs);
  v_kind := case when n = 1 then 'straight' else 'parlay' end;
  if n > 1 and (n < r.parlay_min_legs or n > r.parlay_max_legs) then
    raise exception 'Parlays take % to % legs.', r.parlay_min_legs, r.parlay_max_legs;
  end if;

  for leg in select value from jsonb_array_elements(p_legs) loop
    select * into l from casino_lines where id = leg->>'line';
    if not found then
      raise exception 'That line is no longer offered.';
    end if;
    if l.id = any(v_ids) then
      raise exception 'The same selection is on the slip twice.';
    end if;
    if l.event = any(v_evts) then
      raise exception 'Only one leg per game. Same-game parlays aren''t allowed.';
    end if;
    v_ids := v_ids || l.id;
    v_evts := v_evts || l.event;

    if l.status <> 'open' then
      raise exception '% is suspended right now.', coalesce(nullif(l.label, ''), 'That selection');
    end if;
    begin
      seen := (leg->>'price')::numeric;
      seen_pt := nullif(leg->>'point', '')::numeric;
    exception when others then
      raise exception 'Odds changed. Check your slip and try again.';
    end;
    if seen is null or abs(seen - l.price) > 0.00005 or l.point is distinct from seen_pt then
      raise exception 'Odds changed. Check your slip and try again.';
    end if;
    if l.price < r.leg_min_price then
      raise exception '% is too short a price to bet.', coalesce(nullif(l.label, ''), 'That selection');
    end if;
    if l.price > r.leg_max_price then
      raise exception '% is too long a price to bet.', coalesce(nullif(l.label, ''), 'That selection');
    end if;

    if l.state = 'pre' then
      if casino_clock() >= l.commence_at then
        raise exception '% has already kicked off.', coalesce(nullif(l.event_label, ''), 'That game');
      end if;
      if l.updated_at < casino_clock() - make_interval(secs => r.pregame_stale_sec) then
        raise exception 'Those odds are out of date. Wait for the next refresh.';
      end if;
    elsif l.state = 'in' then
      if not r.live_enabled or l.sport <> 'nfl' then
        raise exception '% is closed for betting.', coalesce(nullif(l.event_label, ''), 'That game');
      end if;
      if l.updated_at < casino_clock() - make_interval(secs => r.live_stale_sec) then
        raise exception 'Live odds are out of date. Wait for the next refresh.';
      end if;
      v_live := true;
    else
      raise exception '% is over.', coalesce(nullif(l.event_label, ''), 'That game');
    end if;

    -- Backing your own fantasy team is fine; betting against it would pay you
    -- to bench your starters.
    if l.sport = 'fantasy' and p_voter = any(l.teams) and
       ((l.market <> 'total' and l.team is distinct from p_voter) or (l.market = 'total' and l.side = 'under')) then
      raise exception 'You can back your own team, but you can''t bet against it.';
    end if;

    v_price := v_price * l.price;
    v_keep := v_keep || jsonb_build_object('line', l.id, 'price', l.price, 'point', l.point, 'score', l.score);
  end loop;

  v_price := round(v_price, 4);
  if v_kind = 'parlay' then
    v_price := least(v_price, r.parlay_max_price);
    v_max := r.max_stake_parlay;
  else
    v_max := r.max_stake_straight;
  end if;
  if p_stake > v_max then
    raise exception 'Maximum % stake is $%.', v_kind, v_max;
  end if;
  if round(p_stake * v_price, 2) > r.max_payout then
    raise exception 'A ticket can pay at most $%, so the most you can stake at these odds is $%.',
      r.max_payout, floor(r.max_payout / v_price * 100) / 100;
  end if;

  select count(*) into v_open from bets where voter = p_voter and status in ('pending', 'open');
  if v_open >= r.max_open then
    raise exception 'You already have % bets open. Wait for some to settle.', v_open;
  end if;
  select coalesce(sum(amount), 0) into v_bal from casino_ledger where voter = p_voter;
  if v_bal < p_stake then
    raise exception 'You have $% to bet with.', to_char(v_bal, 'FM999999990.00');
  end if;

  v_status := case when v_live then 'pending' else 'open' end;
  insert into bets (voter, season, kind, stake, price, status, accepted_at)
  values (p_voter, extract(year from r.season_start)::int, v_kind, p_stake, v_price, v_status,
          case when v_live then null else now() end)
  returning id into v_id;
  insert into bet_legs (bet_id, line_id, price, point, score_at)
  select v_id, x->>'line', (x->>'price')::numeric, nullif(x->>'point', '')::numeric, coalesce(x->>'score', '')
  from jsonb_array_elements(v_keep) as x;
  insert into casino_ledger (voter, amount, kind, ref) values (p_voter, -p_stake, 'stake', v_id::text);

  return jsonb_build_object('id', v_id, 'status', v_status, 'price', v_price,
    'payout', round(p_stake * v_price, 2), 'balance', v_bal - p_stake);
end;
$$;
revoke all on function public.place_bet(int, text, jsonb, numeric) from public;
grant execute on function public.place_bet(int, text, jsonb, numeric) to anon, authenticated;

/* ---- Service-role only: called by the casino-sync edge function. ---- */

-- Final outcomes onto lines: [{"id": line id, "outcome": {...}}]
create or replace function public.casino_set_outcomes(p jsonb) returns int
language sql
security definer
set search_path = public
as $$
  with u as (
    update casino_lines l set outcome = x.outcome, status = 'closed', state = 'post'
    from jsonb_to_recordset(p) as x(id text, outcome jsonb)
    where l.id = x.id and l.outcome is null
    returning 1)
  select count(*)::int from u;
$$;

-- Leg results: [{"bet": id, "line": id, "result": "win"}]
create or replace function public.casino_grade_legs(p jsonb) returns int
language sql
security definer
set search_path = public
as $$
  with u as (
    update bet_legs g set result = x.result
    from jsonb_to_recordset(p) as x(bet bigint, line text, result text)
    where g.bet_id = x.bet and g.line_id = x.line and g.result is null
    returning 1)
  select count(*)::int from u;
$$;

-- Settle one open bet. The payout is capped here as well, whatever the caller says.
create or replace function public.casino_settle(p_bet bigint, p_status text, p_payout numeric) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare b bets%rowtype; r casino_rules%rowtype; pay numeric;
begin
  if p_status not in ('won','lost','push','void') then raise exception 'bad status %', p_status; end if;
  select * into r from casino_rules where id = 1;
  select * into b from bets where id = p_bet and status = 'open' for update;
  if not found then return false; end if;
  pay := greatest(0, least(coalesce(p_payout, 0), r.max_payout, round(b.stake * b.price, 2)));
  update bets set status = p_status, payout = pay, settled_at = now() where id = p_bet;
  if pay > 0 then
    insert into casino_ledger (voter, amount, kind, ref) values (b.voter, pay, 'payout', p_bet::text)
    on conflict (kind, ref) do nothing;
  end if;
  return true;
end;
$$;

-- Accept or refuse a live bet once its delay is up. Refusal refunds the stake.
create or replace function public.casino_resolve(p_bet bigint, p_accept boolean, p_note text) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare b bets%rowtype;
begin
  select * into b from bets where id = p_bet and status = 'pending' for update;
  if not found then return false; end if;
  if p_accept then
    update bets set status = 'open', accepted_at = now() where id = p_bet;
  else
    update bets set status = 'rejected', payout = b.stake, note = p_note, settled_at = now() where id = p_bet;
    insert into casino_ledger (voter, amount, kind, ref) values (b.voter, b.stake, 'refund', p_bet::text)
    on conflict (kind, ref) do nothing;
  end if;
  return true;
end;
$$;

revoke all on function public.casino_set_outcomes(jsonb)              from public, anon, authenticated;
revoke all on function public.casino_grade_legs(jsonb)                from public, anon, authenticated;
revoke all on function public.casino_settle(bigint, text, numeric)    from public, anon, authenticated;
revoke all on function public.casino_resolve(bigint, boolean, text)   from public, anon, authenticated;
do $$
begin
  grant execute on function public.casino_set_outcomes(jsonb)            to service_role;
  grant execute on function public.casino_grade_legs(jsonb)              to service_role;
  grant execute on function public.casino_settle(bigint, text, numeric)  to service_role;
  grant execute on function public.casino_resolve(bigint, boolean, text) to service_role;
exception when undefined_object then null;   -- no service_role outside Supabase
end $$;

do $$
begin
  alter publication supabase_realtime add table public.bets;
exception when duplicate_object or undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.casino_ledger;
exception when duplicate_object or undefined_object then null;
end $$;

-- Commissioner tools (run by hand when needed):
--   Give or take money (always through the ledger, never by editing a balance):
--     insert into public.casino_ledger (voter, amount, kind, ref) values (8, 25, 'adjust', 'note-2026-10-06');
--   Turn live betting on once ESPN is seen updating odds in-game:
--     update public.casino_rules set live_enabled = true where id = 1;
--   Void a bet that can't be graded (refunds the stake):
--     select public.casino_settle(123, 'void', (select stake from public.bets where id = 123));
--   Reset a team's password (they set a new one on their next ballot):
--     delete from public.team_passwords where voter = 8;
--   Delete one ballot:
--     delete from public.ballots where season = 2026 and week = 3 and voter = 8;
--   Delete one team's picks for a week:
--     delete from public.picks where season = 2026 and week = 3 and voter = 8;
