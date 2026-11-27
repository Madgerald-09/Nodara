# NODARA Phase 13 — Platform optimisation, security and scale

Audit date: 2026-11-27. This is a local source and test review, not a production penetration test or live database audit. Supabase production was not queried. The uncommitted working tree was preserved.

## Executive summary

Two concrete improvements were made:

1. Route-level lazy loading plus moving the Solana client provider into the organiser workspace reduced the built entry chunk from **862.33 KB (234.68 KB gzip)** in the captured pre-change build to **321.94 KB (95.30 KB gzip)** in the final build. This is a 62.7% reduction in the entry chunk. Solana code is now emitted in route-dependent chunks; the 462.06 KB browser chunk appears as a dependency of deferred on-chain action chunks and is not preloaded from `dist/index.html`. A browser network trace remains the final verification.
2. Paystack webhook bodies are now read with a streaming 256 KB cap before signature verification/parsing. Previously the entire body was buffered before checking its size.

The organiser event list now fetches a 25-row page, while the dashboard uses bounded recent rows and database counts instead of transferring all organiser events. A generic React error boundary provides a safe reload state for render and lazy-route failures.

Most security results remain static findings because production database access, Deno, and a local Postgres test server were unavailable. No blanket security guarantee is made.

## Prioritised findings

### High — AI event import remains disabled pending SSRF assurance

- **Component:** Firecrawl importer; `supabase/functions/import-event-webpage/index.ts`, `supabase/functions/_shared/phase12.mjs`.
- **Evidence:** exact HTTPS host allowlisting and private-looking hostname rejection exist. Firecrawl public API documentation reviewed earlier does not establish a redirect/private-address fetch guarantee. A redirect could invalidate the initial URL check.
- **Impact:** unsafe external fetches could reach internal services if the provider follows an unsafe redirect.
- **Status:** **Configuration-dependent / fixed by fail-closed behavior.** Function returns 503 unless `FIRECRAWL_SSRF_GUARD_CONFIRMED=true`; the value was not set. Do not set it without provider-side evidence. No Firecrawl request was made.
- **Retest:** pure URL validation tests passed; provider redirect behavior remains unverified.

### High — production RLS and grants cannot be confirmed from local source

- **Components:** Supabase tables/RPCs across migrations 001–014.
- **Evidence:** local SQL files define RLS and grants; the production schema and migration history have not been fully verified, and this task did not connect to production.
- **Impact:** local policy text cannot establish deployed protection or confirm migrations were applied in the intended sequence.
- **Status:** **Identified but unresolved / needs production catalog review.** Do not apply migrations based on this report. In particular 014 is local and unapplied.
- **Retest:** SQL catalog and pgTAP execution unavailable (no responding local PostgreSQL server).

### High — on-chain synchronization previously accepted `confirmed` evidence

- **Components:** `verify-solana-ticket`, `verify-solana-transfer`, `verify-solana-check-in`.
- **Evidence:** before this change, these functions requested transactions and account state at `confirmed`, while reconciliation already required `finalized`.
- **Impact:** database synchronization could precede finality and later conflict with canonical Devnet state.
- **Status:** **Fixed and statically tested.** The three server verifiers now query transaction and account evidence at `finalized`; transaction submission remains at `confirmed` so wallets still receive responsive progress. A not-yet-finalized transaction remains unsynchronized and can be retried. Claiming transferred tickets also reads the finalized ticket account.
- **Retest:** Node static regression assertion passes. No RPC or live Devnet transaction was performed.

### Medium — Firecrawl and ElevenLabs provider size handling

- **Components:** `supabase/functions/_shared/provider_api.mjs`, transcription endpoint.
- **Evidence:** provider responses are now read with explicit body caps (1 MB extraction JSON, 5 MB audio, 256 KB transcript response); request audio is streamed under a 1.6 MB cap before multipart parsing.
- **Impact:** bounds memory use from large provider responses and crafted request bodies.
- **Status:** **Fixed and tested** with mocked provider responses. Provider service behavior itself remains unverified.

### Medium — speech duration is not independently enforced server-side

- **Component:** ElevenLabs transcription.
- **Evidence:** UI stops recording at 20 seconds and the server enforces MIME and 1.5 MB file limits plus per-user hourly request limits. The server does not decode audio to verify duration.
- **Impact:** a modified client could submit a longer, highly compressed recording within the byte limit, subject to authentication and rate limits.
- **Status:** **Identified but unresolved.** Keep limits; add server-side duration inspection or a provider-side duration cap before enabling at scale. Recordings are not persisted by NODARA, but are sent to ElevenLabs for transcription.

### Medium — substring event search may scan as the catalogue grows

- **Components:** `src/services/searchUtils.ts`, `src/services/eventService.ts`; event indexes in migration 001.
- **Evidence:** search uses `ILIKE '%term%'` across title, descriptions, category, city and country. Existing indexes cover published start date, category/date and location/date, not arbitrary substring matching.
- **Impact:** broad text searches may become expensive on a large catalogue.
- **Status:** **Identified, not changed.** No production EXPLAIN/ANALYZE data was available, so a trigram/full-text migration would be speculative. Capture query plans and timings on a representative isolated dataset before adding indexes.

### Medium — organiser event list was unbounded

- **Component:** organiser event dashboard and `eventService.ts`.
- **Evidence:** the list previously selected all organiser rows and filtered status in the browser.
- **Impact:** transfer size and rendering grew with organiser history.
- **Status:** **Fixed and build-tested.** The list now uses 25-row server-side ranges/status filtering; dashboard counts use `count: exact` and recent rows are limited to five. This is multiple bounded queries and should be monitored for very large accounts.

### Low — deployment migrations and third-party services remain unverified

- **Components:** migration 014, three Phase 12 Edge Functions, Supabase and provider configuration.
- **Evidence:** migration not applied, Edge Functions not deployed, no provider secrets configured in this task.
- **Status:** **Configuration-dependent.** No real API calls or deployment were performed.

### Informational — excluded social migration remains unsafe to activate under current product rules

- **Component:** `supabase/migrations/202611270008_social_ecosystem.sql`.
- **Evidence:** the local file defines public profile/follow/feed functionality excluded by NODARA’s privacy and teen-safety rules.
- **Status:** **Unchanged and unapplied.** Keep it excluded from all migration commands.

## Area-by-area audit

| Area | Evidence reviewed | Result |
|---|---|---|
| Frontend performance | Vite output before/after; route imports; global Solana provider | Route splitting reduced the entry bundle 862.33 KB → 321.94 KB raw. Organiser analytics and account/discovery routes load lazily. LCP, CLS, interaction latency and browser network timing were not measured. |
| React rendering | Home discovery effects, recommendation/trending visibility gates, debounce and abort handling | Existing homepage search debounces 280 ms, aborts stale requests and URL updates are debounced. No broad memoization added without evidence. |
| Images/assets | Event card `loading="lazy"`, fallback images and existing Unsplash widths | Graceful event-image fallback and lazy loading exist. Responsive `srcset` and measured CLS were not evaluated; no image refactor made. |
| Database queries/indexes | Local migrations 001–014 and service query patterns | Core event/status/date, user, booking, ticket, notification and payment analytics indexes exist in local SQL. Production index presence is unverified. Substring search is the main query-plan concern. No Phase 13 migration added. |
| Authentication/authorisation | Supabase auth usage, organiser ownership filters, server-side function auth patterns | Organiser routes check a session for UX and DB operations also filter `organizer_id`; server/RLS still must be verified in deployed DB. Frontend route checks are not treated as security boundaries. |
| RLS/RPCs | Local policy/function definitions in migrations, including analytics and reconciliation | Local RPCs generally use qualified names and explicit search paths; important reconciliation functions grant service-role execution. The new rate limiter is `SECURITY DEFINER`, empty `search_path`, explicitly requires `auth.role()='service_role'`, and denies client grants. Live catalog validation unavailable. |
| Paystack | webhook signature helper, webhook flow, refund verifier and payment SQL | Raw-body signature validation includes timestamped signature support and a legacy HMAC path; provider verification and idempotency are present in source. Webhook body cap is now enforced while streaming. No provider or database integration was exercised. Paystack key checks retain test-mode enforcement. |
| Refunds/financial reports | `refunds.ts`, request function, finalization migration, analytics RPC | Source validates ticket/payment identity and amount/currency, blocks checked-in/transferred/on-chain tickets pending invalidation, and reports only verified payments with completed refunds deducted by currency. Runtime concurrency/RLS behavior is not certified without SQL tests and deployed schema. |
| Solana | program ID/Devnet config, client transaction services, verification and reconciliation functions | Static scan found the expected Devnet program ID and Devnet RPC defaults; no private keys were found in `src` or function source scan. Submission is confirmed; trusted registration/transfer/check-in sync now requires finalized evidence. No transaction broadcast or live RPC verification occurred. |
| Firecrawl | URL validation, allowlist, extraction response normalization, Edge Function | Authenticated request, exact host allowlist, output cleanup, timeout, rate limit and owner-scoped duplicate lookup exist. Redirect SSRF assurance is unavailable, so function is disabled by default. |
| ElevenLabs/grounding | TTS/STT endpoints, provider helpers and discovery page | Secrets server-side, authentication/rate limits, strict inputs, body limits and no NODARA recording storage. Search uses published events, fixed supported filters and existing recommendation opt-outs; no generated SQL or arbitrary LLM answers. Server-side audio duration remains a limitation. |
| Notifications | queue worker, email delivery helper, notification migrations | Worker uses a secret comparison, test recipient routing, provider idempotency keys, bounded batch claim and retry state. No actual email sent. Test/live mode is a server configuration switch and must stay `test` for launch verification. |
| Error handling/accessibility | route fallback, importer, voice UI, global styles | Added app error boundary and lazy-route loading state; controls have labels/status/error announcements and focus-visible styles. Full screen-reader, contrast, keyboard and mobile-device testing was not available. |

## Changes made in Phase 13

- Route-level dynamic imports for organiser, ticket, payment-return, account, saved event, public event, moderation, community, notification and AI discovery pages.
- Solana `ClientProvider` now mounts only inside the organiser workspace rather than around the entire app.
- Organiser event browsing now paginates at 25 rows and filters status in the query. Overview counts use database count requests and only fetch five recent event rows.
- Paystack webhook body cap now applies while streaming, before HMAC verification and JSON parsing.
- Trusted Solana registration, transfer, check-in and transferred-ticket claim reads use finalized chain evidence.
- Provider response/request byte caps added to Phase 12 helpers.
- Global render/lazy import error boundary with a safe reload state.

## Files updated in this phase

- `src/App.tsx`
- `src/main.tsx`
- `src/pages/OrganiserApp.tsx`
- `src/services/eventService.ts`
- `src/index.css`
- `src/components/AppErrorBoundary.tsx` (new)
- `src/pages/OrganiserPagination.css` (new)
- `supabase/functions/paystack-webhook/index.ts`
- `supabase/functions/verify-solana-ticket/index.ts`
- `supabase/functions/verify-solana-transfer/index.ts`
- `supabase/functions/verify-solana-check-in/index.ts`
- `supabase/functions/claim-transferred-ticket/index.ts`
- `supabase/functions/_shared/provider_api.mjs`
- `supabase/functions/elevenlabs-transcribe/index.ts`
- `tests/phase12-integrations.test.mjs` (finality regression assertion).
- This report.

`src/pages/PublicEventPage.tsx`, `src/types/database.ts`, `supabase/config.toml`, and the importer/discovery source files are preceding Phase 12 work; they were preserved and are not Phase 13 changes.

The working tree also contains prior uncommitted Phase 11–12 files, including analytics files/migration 013 and the Phase 12 importer, voice and migration 014. They were preserved; do not treat the whole working-tree diff as Phase 13 changes.

## Measurements

| Build artifact | Before | After |
|---|---:|---:|
| Vite entry JavaScript | 862.33 KB raw / 234.68 KB gzip | 321.94 KB raw / 95.30 KB gzip |
| Route loading | Most application pages statically imported | Route pages dynamically imported; organiser analytics also lazy |
| Solana client provider | Mounted around every route | Mounted only in organiser workspace |

This is a build artifact measurement, not a browser LCP or network waterfall. Final build still reports a 462.06 KB browser dependency chunk; verify through a browser network trace that non-organiser routes do not request it. No claims are made about LCP, CLS or INP.

## Test results

- `npm run build` — passed. Final build has no >500 KB chunk warning after the entry split; a 462.06 KB dependency chunk remains close to the threshold.
- `npm run lint` — passed.
- `npm test` — passed, 15 test files (including provider mocks and finalized-evidence regression assertion).
- `git diff --check` — passed.
- `cargo test -p nodara_tickets --lib` — passed, 1 Rust unit test. Anchor macro emitted existing `unexpected cfg` warnings.
- `anchor test` — not run. `Anchor.toml` points to a local wallet path which is absent; no local test keypair was generated.
- Deno Edge Function tests — not run; Deno is unavailable.
- SQL/pgTAP tests — not run; local PostgreSQL was not responding. No remote database connection was made.
- Devnet transaction/RPC tests, Paystack calls, Firecrawl, ElevenLabs and email delivery — not run.

## Deployment and manual verification still required

1. Review schema and migration history in an isolated Supabase test project. Migration 014 is unapplied and must be reviewed before use; never include migration 008.
2. Run Phase 12 SQL/pgTAP tests on an isolated database and deploy/test Edge Functions only in a test project.
3. Keep Firecrawl disabled until redirect/private-network controls are independently verified. Then validate with a security-reviewed URL test harness before enabling.
4. Configure ElevenLabs secrets only in Supabase; verify rate limits, provider errors, short recordings and no recording persistence. Add trusted duration enforcement before broad enablement.
5. In an approved Devnet test, confirm registration/transfer/check-in remain pending at confirmed commitment and sync only after finalized; ensure retry UI works.
6. Run `EXPLAIN (ANALYZE, BUFFERS)` for representative event search, recommendations and analytics on an isolated representative dataset before adding indexes.
7. Verify homepage route waterfall, organiser route waterfall, mobile overflow, keyboard navigation and screen-reader announcements in browsers/devices.
8. Verify Paystack test webhook, refund retries, notification test recipient enforcement and queue idempotency against isolated services.

## Safety confirmation

- Migration 008 was not modified or applied; exclude it from future migration runs.
- Migrations 009–014 remain in the working tree and were not applied. Migration 013 and 014 were not overwritten by Phase 13.
- No production data or schema was accessed or changed.
- No Edge Function or frontend deployment occurred.
- No commit or push occurred.
- Paystack remains test-mode only; no transactions were initiated.
- Solana remains Devnet; no transaction was broadcast and no program authority changed.
- No secrets, private keys or wallet seed phrases were added to source.
- Phase 14 was not started.
