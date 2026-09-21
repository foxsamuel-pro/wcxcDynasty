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

-- Live updates: new ballots appear on everyone's screen without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.ballots;
exception when duplicate_object then null;
end $$;

-- Commissioner tools (run by hand when needed):
--   Reset a team's password (they set a new one on their next ballot):
--     delete from public.team_passwords where voter = 8;
--   Delete one ballot:
--     delete from public.ballots where season = 2026 and week = 3 and voter = 8;
