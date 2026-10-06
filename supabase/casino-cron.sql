-- Runs the casino-sync edge function every minute. Run once in Supabase >
-- SQL Editor AFTER supabase-setup.sql and after deploying the function.
--
-- 1. Database > Extensions: enable pg_cron and pg_net (or let the lines below do it).
-- 2. Pick a long random secret and give it to the function:
--      npx supabase@latest secrets set CRON_SECRET=<secret> --project-ref qwgwaedeuihvneirbplb
-- 3. Put the SAME secret in the vault, replacing the placeholder below, then run this file.
--
-- To stop it:  select cron.unschedule('casino-sync');
-- To see runs: select * from cron.job_run_details order by start_time desc limit 20;
--              select * from net._http_response order by created desc limit 20;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Paste this file into the SQL Editor and replace the placeholder THERE. Don't save
-- the real secret into the copy in the repo.
do $$
declare
  secret text := 'REPLACE-WITH-THE-SAME-SECRET';
  sid uuid;
begin
  if secret like 'REPLACE-WITH%' or length(secret) < 16 then
    raise exception 'Put your CRON_SECRET (the same value you gave supabase secrets set) in place of the placeholder first.';
  end if;
  -- stored or replaced, so running this again with a new secret just updates it
  select id into sid from vault.secrets where name = 'casino_cron_secret';
  if sid is null then
    perform vault.create_secret(secret, 'casino_cron_secret');
  else
    perform vault.update_secret(sid, secret);
  end if;
end $$;

do $$
begin
  perform cron.unschedule('casino-sync');
exception when others then null;
end $$;

select cron.schedule('casino-sync', '* * * * *', $$
  select net.http_post(
    url     := 'https://qwgwaedeuihvneirbplb.supabase.co/functions/v1/casino-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'casino_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$);
