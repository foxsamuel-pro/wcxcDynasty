-- WCXC Poll Tracker: run this once in Supabase > SQL Editor > New query > Run

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

-- Hashed team PINs. Nobody can read this table from the website.
create table if not exists public.team_pins (
  voter      int primary key check (voter between 1 and 12),
  pin_hash   text not null,
  created_at timestamptz not null default now()
);

alter table public.ballots   enable row level security;
alter table public.team_pins enable row level security;

-- Anyone can read ballots. No insert/update/delete policies, so the only
-- way to write is through submit_ballot() below, which checks the PIN.
drop policy if exists "Anyone can read ballots" on public.ballots;
create policy "Anyone can read ballots" on public.ballots
  for select to anon, authenticated using (true);

create or replace function public.submit_ballot(
  p_season int, p_week int, p_voter int, p_ranking int[], p_pin text
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
  if p_pin is null or length(p_pin) < 4 then
    raise exception 'Your PIN needs at least 4 characters.';
  end if;

  select pin_hash into existing from team_pins where voter = p_voter;
  if existing is null then
    -- First ballot for this team: the PIN they enter becomes the team PIN.
    insert into team_pins (voter, pin_hash) values (p_voter, crypt(p_pin, gen_salt('bf')));
  elsif existing <> crypt(p_pin, existing) then
    raise exception 'Wrong PIN for this team.';
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
--   Reset a team's PIN (they set a new one on their next ballot):
--     delete from public.team_pins where voter = 8;
--   Delete one ballot:
--     delete from public.ballots where season = 2026 and week = 3 and voter = 8;
