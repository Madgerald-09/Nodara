# NODARA Phase 12: AI discovery integrations

Phase 12 adds an organiser-assisted event page import, spoken public-event summaries, speech-to-text search, and a deterministic discovery assistant. The assistant does not generate SQL or invent event facts: it parses a small supported set of filters and queries the existing published `events` table. Personalised recommendations use the existing recommendation service and its opt-out settings.

## Firecrawl importer (12.1)

Implementation files:

- `supabase/functions/import-event-webpage/index.ts` — authenticated Edge Function and structured Firecrawl request.
- `supabase/functions/_shared/phase12.mjs` — host validation, output cleanup, and duplicate detection.
- `src/components/EventWebpageImporter.tsx` — editable-draft handoff in the organiser create form.
- `src/pages/OrganiserApp.tsx` — reuses the existing event form and save/publish actions.

The function uses Firecrawl's current `POST /v2/scrape` endpoint with a JSON schema format; it does not call the deprecated `/extract` endpoint. It only returns a bounded set of extracted fields, checks duplicates within the authenticated organiser's own event rows, and never saves or publishes automatically. The organiser reviews and edits the existing form before using its normal save/publish controls. `source_url` and `registration_url` are stored on the event and may be shown on its public detail page; they do not expose bookings or user data.

**Fail-closed limitation:** an exact host allowlist and source URL validation are enforced, but Firecrawl's public API contract reviewed for this work did not document a control that guarantees redirects cannot reach private or internal addresses. Therefore the function returns 503 and does not call Firecrawl unless the server-side `FIRECRAWL_SSRF_GUARD_CONFIRMED=true` setting is present. Do not set it until the provider's redirect and private-network protections have been independently verified for the configured service. If they cannot be verified, leave event import disabled. An allowlist alone is not treated as proof of redirect safety.

## ElevenLabs voice discovery (12.2)

Implementation files:

- `supabase/functions/elevenlabs-event-speech/index.ts` — reads a published event through the user's Supabase session and generates audio from those database fields only.
- `supabase/functions/elevenlabs-transcribe/index.ts` — forwards short audio for transcription and returns only a bounded transcript; NODARA does not persist recordings.
- `supabase/functions/_shared/voice_discovery.mjs` — text grounding and transcript validation.
- `src/pages/AiDiscoveryPage.tsx` — explicit microphone control, text fallback, results, audio playback and stop controls.

TTS uses ElevenLabs `POST /v1/text-to-speech/{voice_id}` with `eleven_multilingual_v2`; transcription uses `POST /v1/speech-to-text` with `scribe_v2`. Both require sign-in and per-user server-side rate limits. The browser recording automatically stops after 20 seconds; the server also limits upload size to 1.5 MB and supported audio MIME types. The audio is sent to ElevenLabs for processing; do not record unless the user presses the microphone button. Voice service availability depends on the selected voice being configured and permitted for the account.

## Unified discovery (12.3)

Implementation files:

- `src/pages/AiDiscoveryPage.tsx` — `/discover/assistant` route and UI.
- `src/services/naturalLanguageDiscovery.ts` — deterministic natural-language filter parser and factual response formatter.
- `src/services/eventService.ts` — existing published-event queries, limits and RLS path.
- `src/services/recommendationService.ts` — existing preference/activity ranking when a user asks for recommendations.

Supported query hints include category names, free/paid, a city/location after `in`, `near`, or `around`, and simple periods such as this weekend, next week, this month and next month. Results are from published events only and limited by the existing event service. Recommendation requests use the existing service, including its profile privacy preferences. No third-party text-generation model, provider key, new event store, arbitrary SQL, private attendee data or booking details are involved.

## Database and local setup

New additive migration: `supabase/migrations/202611270014_phase12_ai_discovery.sql`.

It adds optional `source_url` and `registration_url` fields to existing events and a private `ai_provider_rate_limits` table plus a service-role-only rate-limit function. Its test is `supabase/tests/202611270014_phase12_ai_discovery.test.sql`. This migration has **not** been applied. Apply migrations only in the repository's reviewed order after schema and SQL test review; migration 008 remains paused and must not be applied.

Required Supabase Edge Function secrets/settings (set only in a non-production test project first):

- Existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` runtime settings.
- `NODARA_APP_ORIGIN` — exact browser app origin.
- `FIRECRAWL_API_KEY` — server-only provider secret.
- `FIRECRAWL_ALLOWED_HOSTS` — comma-separated exact hostnames approved for organiser imports.
- `FIRECRAWL_SSRF_GUARD_CONFIRMED=true` — leave unset unless redirect and private-network protections are verified; otherwise imports remain disabled.
- `ELEVENLABS_API_KEY` — server-only provider secret.
- `ELEVENLABS_VOICE_ID` — account-approved voice identifier.

Never put these values in `VITE_*` variables. Development uses the same feature controls; no credentials are included in this repository. After a reviewed test database has the migration and the Edge Functions are deployed to that isolated project, configure secrets through the Supabase dashboard or CLI secret store. This work did not deploy functions or change any database.

## Planned test-project deployment order

1. Back up and review the test-project schema; ensure migration 008 is excluded.
2. Apply `202611270014_phase12_ai_discovery.sql` through the project's approved migration workflow.
3. Run `supabase/tests/202611270014_phase12_ai_discovery.test.sql` on an isolated local/test database.
4. Configure the listed secrets and exact host allowlist in a test Supabase project. Leave the Firecrawl safety confirmation unset until verified.
5. Deploy `import-event-webpage`, `elevenlabs-event-speech`, and `elevenlabs-transcribe` to the test project.
6. Manually verify a test organiser import, event-page detail links, signed-in speech, a 20-second microphone cap, text fallback, rate limiting and opt-out-aware recommendations.
7. Do not enable production or live-provider use until SSRF review and the test checklist pass.

No migration, Edge Function, provider transaction, or production change was executed while implementing this phase.
