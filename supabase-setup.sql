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
