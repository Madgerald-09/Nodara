# NODARA Production Reconciliation Audit

**Scope:** local migrations 001–007 and repository references only. No production connection or SQL execution was performed. No repair migration was created.

## Executive summary

The production catalog JSON is not present in the conversation context available for this audit; the available artifact is the SQL script that generates it. The user-provided textual findings establish that some reconciliation tables and functions exist, but do not include catalog rows, definitions, grants, constraints, indexes, policies, or trigger details. Consequently, the report distinguishes those limited facts from items that need the JSON output. Absence of `supabase_migrations.schema_migrations` is not evidence that migrations are unapplied.

Local review found a repository-level overload question and a transfer-count gap worth resolving before production is treated as ready:

* No repository call site uses the old 9-argument `record_verified_ticket_checkin` overload. Migration 007 explicitly drops the then-current 9-argument overload before defining the 11-argument overload. This supports removing the old overload after production dependency/grant evidence confirms safety; it does not authorize dropping it now.
* Migration 007's 11-argument check-in function validates the supplied `p_transfer_count` is in range, but does not compare it with `v_ticket.solana_transfer_count`. The Edge Function supplies the count decoded from the ticket account. The function should reject a non-NULL stored count that differs, while allowing NULL for legacy/uninitialized rows and then storing the verified count. Its row lock serializes database synchronization against the transfer synchronizer, but cannot lock Solana state. The Edge Function's current commitment is `confirmed`, so finality and interleaving remain considerations.

## Migration-by-migration comparison

The classifications below compare local expectations with only the production facts supplied in prose. The missing JSON catalog means detailed comparisons are **NEEDS VERIFICATION**.

| Migration | Local expected effects | Production comparison |
|---|---|---|
| `202611240001_initial_schema.sql` | Six core tables; constraints/indexes; profile, community-owner and booking triggers; RLS, policies, grants, helper functions | **NEEDS VERIFICATION** — supplied summary says core application tables exist, but does not enumerate definitions or confirm individual migration effects. |
| `202611260001_event_content_fields.sql` | Adds `events.short_description` and `events.address` with checks | **NEEDS VERIFICATION** — not shown in supplied production facts. |
| `202611260002_ticketing.sql` | Ticket types, booking items, ticket columns, booking functions/triggers, RLS and grants | **NEEDS VERIFICATION** — “ticketing tables” are reported, but columns, policies, functions and triggers are not supplied. |
| `202611260003_solana_ticketing.sql` | Devnet event/ticket metadata, transfer history table, protected chain metadata and associated RLS/grants | **NEEDS VERIFICATION** — transfer history is reported to exist, but its structure/indexes/policies/privileges were not included in the facts. |
| `202611260004_controlled_transfers.sql` | Current ticket-holder column/backfill, holder RLS, transfer synchronization and claim functions, revised attendance listing/check-in RPC | **NEEDS VERIFICATION** — no full production table/function definitions or policy report is available. |
| `202611260005_onchain_checkin.sql` | Check-in history, organizer attendee query, trusted synchronization RPC and legacy RPC guard | **NEEDS VERIFICATION** — production check-in history/function details were not included. |
| `202611260006_checkin_owner_lock.sql` | Replaces 8-argument check-in RPC with 9-argument owner-lock implementation | **CONFIRMED MISMATCH (overload presence)** — prose says production has a 9-argument older overload and an 11-argument newer overload; it does not establish their exact definitions or grants. |
| `202611260007_solana_reconciliation.sql` | Reconciliation columns/history evidence, tables, indexes, RLS/grants, three privileged RPCs; replaces transfer and check-in synchronizers with 11-argument forms | **CONFIRMED MATCH (object names only)** — prose reports both reconciliation tables and three named RPCs, plus the newer check-in and transfer RPCs. **NEEDS VERIFICATION** for exact definitions, columns, constraints, indexes, grants, policies, and all other effects. |

### Production objects confirmed by supplied findings

These are confirmed only as existence/configuration claims in the supplied summary, not independently checked against catalog output:

* `solana_reconciliation_runs` and `solana_reconciliation_audit` exist; RLS is enabled; no policies were reported; postgres and `service_role` have grants.
* Two `record_verified_ticket_checkin` overloads exist, with 9 and 11 arguments.
* The newer check-in and transfer functions reportedly restrict execution to `service_role`.
* `start_solana_reconciliation_run`, `finish_solana_reconciliation_run`, and `apply_solana_ticket_reconciliation` exist.
* `supabase_migrations.schema_migrations` was reported absent.

All other migration-specific schema matches remain **NEEDS VERIFICATION** until the JSON report is available. “No policies currently reported” is not a substitute for the policy list from the audit query.

## Missing, mismatched, or unverified objects

* **CONFIRMED MISMATCH:** the reported 9-argument check-in overload remains alongside the 11-argument overload, while local migration 007 explicitly drops the 9-argument signature before creating the 11-argument function.
* **NEEDS VERIFICATION:** whether the 9-argument overload has `PUBLIC`, `anon`, or `authenticated` execute access, whether it is security-definer, and whether catalog dependencies refer to it.
* **NEEDS VERIFICATION:** whether exact migration-007 table columns, checks, indexes, grants, and reconciliation table RLS match production.
* **NEEDS VERIFICATION:** exact 11-argument check-in and transfer function bodies, ownership/Devnet checks, replay checks, transfer sequence checks, and grants.
* **NEEDS VERIFICATION:** effects of migrations 001–005 beyond the table/function existence statements in the supplied summary.

## Old check-in overload analysis

Repository search found no application/Edge Function call that intentionally supplies the 9-argument RPC. The only Edge Function caller is `supabase/functions/verify-solana-check-in/index.ts`, which passes the 11 named arguments (`p_owner_wallet`, `p_transfer_count`, `p_verified_at` included). The relevant SQL references are migration definitions and tests. Migration 007 explicitly executes `drop function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text)` before creating its 11-argument implementation. Migration 006 also drops its predecessor overload as it installs the owner-lock version.

Repository references therefore indicate the legacy overload is not needed by checked-in app code. However, local source cannot establish production dependencies such as external SQL clients, scheduled jobs, dashboard scripts, or other database functions. Review the audit report’s dependents and EXECUTE grants for the old signature before removal. Do not remove it until those production checks are reviewed. If any untracked caller depends on it, first migrate that caller to the verified 11-argument path and remove/restrict access through a separately reviewed change.

## Transfer-count consistency

Migration 007’s 11-argument check-in function rejects a NULL or out-of-range supplied count, but has no equality condition against the locked row’s `solana_transfer_count`. Migration 006 has no transfer-count parameter. The current `verify-solana-check-in` function reads the on-chain `TicketRecord.transfer_count` after transaction confirmation and passes it as `p_transfer_count`. Ticket registration initializes the database count to zero; the 11-argument transfer synchronizer advances it to `sequence + 1` and checks the prior count when it is non-NULL.

**Expected check-in behavior:** under the row lock, reject when the database count is non-NULL and differs from the supplied, independently decoded on-chain count. Accept NULL as a legacy/uninitialized value, because the chain evidence is authoritative, then write the verified count. This maintains compatibility with older rows while detecting stale or mismatched transfer synchronization.

**Race implications:** `FOR UPDATE` serializes database transfer/check-in synchronizers for the same ticket. If transfer synchronization commits first, the count comparison rejects stale check-in evidence. If check-in commits first, the transfer synchronization should reject because the ticket is no longer issued. This does not serialize database operations with Solana. The verifier currently requests `confirmed` transaction/account evidence rather than `finalized`; two independent chain transactions can also race before the database lock is acquired. Before production readiness, verify that the transaction really succeeded, that account state corresponds to a consistent post-transaction slot, and decide whether synchronization requires finalized evidence or another explicit freshness check. Do not infer safety from the SQL row lock alone.

## Migration-history recovery recommendation

The repository has eight ordered migration files under `supabase/migrations/`, but no checked-in Supabase configuration file or authoritative migration baseline record was found; `supabase/README.md` describes manual SQL Editor execution. Production reportedly lacks `supabase_migrations.schema_migrations`.

Do not create that schema/table manually, mark migrations as applied, or run `supabase db push` to solve this. First preserve the read-only audit output and make a reviewed inventory mapping every migration statement to observed production effects, including object definitions and data backfills. Identify a controlled Supabase-supported baseline/repair workflow with the project owner and Supabase tooling for the linked project; test it against a production clone or staging copy. The baseline must record only migrations whose full effects have been proven, and any repair must contain only reviewed missing changes. Keep a backup and an explicit rollback/recovery plan. The absent history table by itself cannot determine which SQL was run.

## Exact outstanding deployment tasks

1. Obtain the complete output from `nodara_production_catalog_audit.sql` and review every table/function section, especially the 9-argument function’s privileges/dependencies and the 11-argument function bodies.
2. Compare production columns, constraints, indexes, triggers, RLS policies and ACLs to migrations 001–007. Resolve any gaps before writing repair SQL.
3. Decide whether check-in and transfer verification require finalized evidence. The current check-in verifier uses `confirmed`; the reconciliation verifier uses `finalized`.
4. Validate/retest the production `verify-solana-check-in`, `verify-solana-transfer`, `reconcile-solana-tickets`, and `verify-solana-ticket` deployments against their matching SQL signatures and migration schema. This audit does not establish which Edge Function versions are deployed.
5. Establish a supported migration-history baseline in staging, after the production schema inventory is complete. Do not replay the current non-idempotent migration chain against production blindly.
6. After review and explicit deployment approval, prepare a narrowly scoped repair plan; no migration is included in this report.

## Proposed safe repair plan (dependency order)

1. Preserve and review the audit JSON; confirm catalog visibility and any omitted objects with additional read-only catalog queries if needed.
2. Compare core objects from 001 and 001-event-fields first, then ticket/booking objects from 002, chain metadata/history from 003, holder/transfer changes from 004, check-in history/RPC from 005, owner lock from 006, and reconciliation schema/functions from 007.
3. Confirm 11-argument function signatures match current Edge Function RPC parameter names and types. Check direct grants and `auth.role()` guards independently.
4. Resolve the old overload’s production dependencies and privileges. Migrate any external callers before considering its removal.
5. Review the transfer-count comparison and chain finality/freshness requirement; test both NULL and non-NULL count cases plus transfer/check-in concurrency in staging.
6. Recover migration tracking using a supported baseline process in staging, without replaying already-present DDL. Only then draft an additive, idempotent repair for proven omissions.
7. Run database policy/RPC tests and Edge Function tests in staging, deploy functions compatible with the applied schema, then deploy reviewed database changes through the approved process.

## Test results

* `npm run build` — passed. Vite emitted its existing warning that a generated bundle chunk exceeds 500 kB.
* `npm run lint` — passed.
* Deno tests — not run; Deno is not installed in this environment.
* `NO_DNA=1 RUSTUP_TOOLCHAIN=nightly-2024-06-10 anchor test` — Rust/SBF compilation completed, but Anchor integration tests did not run because the configured local validator RPC port 8899 was already occupied.
* No SQL integration tests, production database queries, or Devnet transactions were run.
