# Scheduled community announcement publisher

The `publish-due-community-announcements` Edge Function processes due announcement rows through the service-role-only `publish_due_community_announcements()` RPC. The RPC locks due rows with `SKIP LOCKED`, publishes each row once, and records a system history entry in the same transaction.

Scheduling is **not enabled by this repository change**. Until an operator configures a trusted schedule, announcements in `scheduled` state remain private.

## Required setup after review and deployment approval

1. Apply the approved database migrations through `202611270011_moderated_community_information.sql` using the repository's resolved migration-history process. Do not run an unrestricted `supabase db push` while migration 008 remains paused.
2. Deploy `publish-due-community-announcements` with `verify_jwt = true` from `supabase/config.toml`.
3. In Supabase Cron (or another trusted scheduler), configure a POST once per minute to:
   `https://<project-ref>.supabase.co/functions/v1/publish-due-community-announcements`
4. Supply `Authorization: Bearer <service-role JWT>` from a protected secret store such as Supabase Vault. Never place that credential in the frontend, repository, or a public cron URL. The function also compares the bearer token with the server-side `SUPABASE_SERVICE_ROLE_KEY` before calling the RPC.
5. Send `Content-Type: application/json` and `{}` as the request body. Monitor non-2xx responses and retry; the database function is safe to retry.
6. Confirm one due test announcement becomes published and gets an `auto_published` history row in an isolated project before enabling this schedule for production.

This function cannot change event or community records and exposes only the number of announcements published in a run.
