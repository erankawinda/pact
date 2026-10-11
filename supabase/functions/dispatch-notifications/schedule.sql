-- Run only after the reviewed migration and authenticated Edge Function are deployed.
-- Prerequisites: enable pg_cron + pg_net + Vault using the Supabase Dashboard.
-- Store real values PRIVATELY in Vault under these names before running:
--   pact_notification_dispatch_url
--   pact_notification_dispatch_secret
-- This file intentionally contains no project identity or credentials.
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='pact_notification_dispatch_url')
 or not exists(select 1 from vault.decrypted_secrets where name='pact_notification_dispatch_secret') then
  raise exception 'Create the two private notification Vault secrets before scheduling';
 end if;
end $$;
select cron.schedule(
 'pact-dispatch-notifications',
 '* * * * *',
 $job$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='pact_notification_dispatch_url'),
  headers := jsonb_build_object('Content-Type','application/json','x-pact-dispatch-key',
   (select decrypted_secret from vault.decrypted_secrets where name='pact_notification_dispatch_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 110000
 );
 $job$
);
