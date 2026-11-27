# Notification queue worker

This Edge Function is not a public product endpoint. It verifies a dedicated high-entropy `NOTIFICATION_WORKER_SECRET`, asks service-role-only SQL RPCs to enqueue eligible reminders and claim email work, then sends email through the Resend HTTP API. It never sends a ticket QR token or raw payment/refund payload.

Email delivery is disabled unless `NOTIFICATION_EMAIL_ENABLED=true`. The default `NOTIFICATION_EMAIL_MODE` is `test`; in test mode, every message is sent only to `NOTIFICATION_TEST_RECIPIENT`. Use a provider-approved test inbox and synthetic test-account content. Set `NOTIFICATION_EMAIL_MODE=live` only after a separate operational review and sender-domain setup. The worker applies Resend's `Idempotency-Key` header using the database notification idempotency key, with retry leases and capped exponential backoff in PostgreSQL.

## Required server-side secrets/configuration

- `NOTIFICATION_WORKER_SECRET`: at least 32 random bytes, used by the scheduler to call this endpoint.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: supplied by the Supabase Edge Function runtime; server-side only.
- `NOTIFICATION_EMAIL_ENABLED`: `false` until reviewed; `true` enables queue delivery.
- `NOTIFICATION_EMAIL_MODE`: `test` or `live`; defaults to `test`.
- `NOTIFICATION_TEST_RECIPIENT`: required in test mode; a provider-approved test inbox.
- `RESEND_API_KEY`: Edge Function secret only.
- `NOTIFICATION_FROM_EMAIL`: verified Resend sender.
- `NODARA_APP_URL`: public HTTPS application origin used to create safe internal links.

## Scheduling

Scheduling is intentionally not installed automatically by the migration. After review, enable Supabase Cron and `pg_net`, put the worker secret in Supabase Vault, and configure one hourly request. Example after storing a Vault secret named `notification_worker_secret`:

```sql
select cron.schedule(
  'nodara-notification-worker',
  '0 * * * *',
  $job$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/process-notification-queue',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notification_worker_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);
```

Replace the project reference and configure Vault through the Supabase dashboard. Do not paste the secret into this file, SQL history, a browser, or source control. Monitor Cron invocation results and the private `notification_deliveries` queue. The migration itself does not create a schedule.

Deploy order in an isolated project: first verify the actual database already has the notification migration dependencies (ticketing 260002, Solana/transfer ticket fields 260003–260004, payment foundation 270002, refunds 270004, and announcements 270011). Migration 270011 also depends on 270010. If local migrations 009–011 are still required, apply them in dependency order through the repository's approved migration-history recovery process while explicitly keeping 008 out; do not use an unrestricted `db push`. Then apply `202611270012_notifications.sql`, deploy `process-notification-queue`, set test-only email configuration, and verify in-app delivery and the provider sandbox recipient before scheduling. No production migration or function was applied for this local implementation.

Resend's current email API supports an `Idempotency-Key` header for duplicate-safe retries (provider retention is limited, so NODARA's database key remains authoritative): [Resend idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).
