-- WCXC Poll Tracker: run this once in Supabase > SQL Editor > New query > Run.
-- Safe to re-run; it won't clobber an existing password or existing ballots.

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

-- One shared password for the whole league, stored as a bcrypt hash.
-- Nobody can read this table from the website.
create table if not exists public.league_auth (
  id         int primary key default 1 check (id = 1),        -- only ever one row
  pw_hash    text not null,
  updated_at timestamptz not null default now()
);

-- Replaced by the shared password above.
drop table if exists public.team_pins;

alter table public.ballots     enable row level security;
alter table public.league_auth enable row level security;

-- Anyone can read ballots. No insert/update/delete policies, so the only way to
-- write is through submit_ballot() below, which checks the league password.
drop policy if exists "Anyone can read ballots" on public.ballots;
create policy "Anyone can read ballots" on public.ballots
  for select to anon, authenticated using (true);

-- No policies at all on league_auth, so the hash is invisible to the site.

-- Set or change the league password. Commissioner only - run it by hand:
--   select public.set_league_password('your new password');
create or replace function public.set_league_password(p_pw text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_pw is null or length(p_pw) < 4 then
    raise exception 'Password needs at least 4 characters.';
  end if;
  insert into league_auth (id, pw_hash, updated_at)
  values (1, crypt(p_pw, gen_salt('bf')), now())
  on conflict (id) do update set pw_hash = excluded.pw_hash, updated_at = now();
end;
$$;

-- Deliberately NOT granted to anon: if the site could call this, anyone could
-- change the league password.
revoke all on function public.set_league_password(text) from public, anon, authenticated;

-- Lets the site say "wrong password" at sign-in instead of at submit time.
-- Returns only true/false, never the hash.
create or replace function public.check_password(p_pw text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  h text;
begin
  select pw_hash into h from league_auth where id = 1;
  if h is null or p_pw is null then return false; end if;
  return h = crypt(p_pw, h);
end;
$$;

revoke all on function public.check_password(text) from public;
grant execute on function public.check_password(text) to anon, authenticated;

-- The only write path. Re-checks the password server-side; never trust the client.
drop function if exists public.submit_ballot(int, int, int, int[], text);

create or replace function public.submit_ballot(
  p_season int, p_week int, p_voter int, p_ranking int[], p_pw text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h text;
begin
  select pw_hash into h from league_auth where id = 1;
  if h is null then
    raise exception 'No league password is set yet. Ask the commissioner.';
  end if;
  if p_pw is null or h <> crypt(p_pw, h) then
    raise exception 'Wrong league password.';
  end if;

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

  insert into ballots (season, week, voter, ranking, updated_at)
  values (p_season, p_week, p_voter, p_ranking, now())
  on conflict (season, week, voter)
  do update set ranking = excluded.ranking, updated_at = now();

  return 'saved';
end;
$$;

revoke all on function public.submit_ballot(int, int, int, int[], text) from public;
grant execute on function public.submit_ballot(int, int, int, int[], text) to anon, authenticated;

-- Starter password, only applied if one isn't set yet. CHANGE IT (see below).
do $$
begin
  if not exists (select 1 from public.league_auth where id = 1) then
    perform public.set_league_password('wcxc2026');
  end if;
end $$;

-- Live updates: new ballots appear on everyone's screen without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.ballots;
exception when duplicate_object then null;
end $$;

-- Commissioner tools (run by hand when needed):
--   Change the league password (everyone signs in again with the new one):
--     select public.set_league_password('whatever you want');
--   Delete one ballot:
--     delete from public.ballots where season = 2026 and week = 3 and voter = 8;
--   See who has voted this week:
--     select voter, updated_at from public.ballots where season = 2026 and week = 3 order by voter;
