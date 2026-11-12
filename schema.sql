-- WCXC poll ballots on Cloudflare D1 (replaces the ballot half of supabase-setup.sql).
-- Apply: npx wrangler d1 execute wcxc --remote --file=schema.sql
-- Safe to re-run. Writes go only through POST /api/ballot (server/worker.mjs).

-- One row per team per week. Resubmitting replaces the old ballot.
create table if not exists ballots (
  season     integer not null,
  week       integer not null check (week between 1 and 18),
  voter      integer not null check (voter between 1 and 12),  -- Sleeper roster_id
  ranking    text    not null,                                 -- JSON array of roster_ids, best first
  updated_at text    not null,                                 -- ISO 8601, UTC
  primary key (season, week, voter)
);

-- Per-team password. A team's first-ever ballot sets it; every ballot after
-- that needs the same one. Never returned by any endpoint.
create table if not exists team_passwords (
  voter      integer primary key check (voter between 1 and 12),
  pw_hash    text    not null,                                 -- pbkdf2$<iter>$<salt>$<hash>
  created_at text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
