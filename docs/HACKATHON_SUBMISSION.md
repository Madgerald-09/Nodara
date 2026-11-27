# NODARA — Hackathon Submission Draft

**Project:** NODARA  
**Tagline:** Discover. Connect. Experience.  
**Repository:** [github.com/Madgerald-09/Nodara](https://github.com/Madgerald-09/Nodara)  
**Current development branch:** `Gerald`  
**Demo URL supplied by project:** <https://nodara-sigma.vercel.app/> (not independently verified in this assessment)

> Submission integrity: this document describes local implementation and test evidence. The current working tree contains uncommitted and untracked work; GitHub links point to the remote repository and may not include that local work until the team reviews and publishes it. No deployment or live integration was verified for this submission draft.

## Project introduction

NODARA is a privacy-first global experience discovery platform that helps people find events and communities, save plans that interest them, and gives organisers tools to publish and manage experiences.

**Discover. Connect. Experience.**

## The problem

Real-world experiences are scattered across event pages, local groups, venue listings and social channels. People spend time searching across disconnected sources, while organisers must assemble discovery, ticketing and attendee workflows from separate tools. Discovery also often requires oversharing personal information or entering open social spaces.

## The solution

NODARA brings event discovery, community information, personal recommendations and collections, booking/ticket workflows and organiser tools into one experience. Private user activity is intended to stay personal; community functionality focuses on public information, official announcements and existing membership rather than stranger-to-stranger contact.

## Features present in the repository

- Published event discovery with search, filters, sorting, recommendations and trending/nearby sections.
- Public event detail pages, event sharing and calendar export.
- Private profile/preferences, saved events, personal collections and an activity dashboard.
- Community browsing, membership, official information/announcements and moderation flows.
- Organiser event creation and management, ticketing/check-in pages and analytics/reporting source.
- Booking, ticketing, Paystack payment/refund and reservation-expiry source.
- Solana Devnet ticket registration, transfer and check-in source with server-side verification code.
- Deterministic natural-language event discovery and optional ElevenLabs speech functions.
- Firecrawl-assisted event import source, currently fail-closed and not safe to demonstrate until SSRF/redirect protection is independently verified.

These are implementation claims. Except for local automated tests/build, integrations are **not verified against deployed services in this assessment**. In particular, no production catalog, browser session, payment, email, provider request or blockchain transaction was observed.

## Technology

- **Frontend:** React, TypeScript, Vite.
- **Backend:** Supabase Auth, PostgreSQL, Row Level Security, Edge Functions.
- **On-chain ticketing:** Solana Devnet, Rust and Anchor. The source pins program ID `CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf`; current deployment/finality was not independently checked here.
- **Payments:** Paystack integration source with test-mode checks; no test payment was made.
- **Voice:** ElevenLabs server-side TTS/transcription integration source; no provider request was made.
- **Event import:** Firecrawl current API integration source; deliberately disabled pending independent SSRF/redirect assurance.
- **Automated tests:** Node test runner and Rust/Cargo unit test.

## Technical approach and innovation

NODARA combines discovery and organiser workflows while retaining Supabase as the application data layer. Personal recommendations use explicit preference and available activity signals rather than a claimed AI model. Natural-language discovery translates supported phrasing into ordinary validated filters and reads published event data; it does not generate SQL or invent event facts.

The ticketing architecture combines off-chain ticket records with Solana Devnet evidence. Trusted server functions are intended to verify instructions, signatures and resulting account state before synchronizing protected database fields. This architecture has not been demonstrated end to end in the current assessment.

Payments are designed around server-side Paystack initialization and webhook verification, database idempotency and booking finalization. Source and mocked tests exist, but the migration state, deployed functions and actual Paystack test-mode flow remain unverified. Do not describe payments as live or production-ready.

## Suggested 3–5 minute demo

Use only a test deployment connected to an isolated test database. Do not use production accounts or create public test events. The statuses below indicate prerequisites; no step was performed during this assessment.

| Time | Demo step | Account/environment | Status |
|---|---|---|---|
| 0:00–0:30 | Introduce the fragmentation problem and NODARA’s privacy-first goal | Presentation | Ready as narration |
| 0:30–1:20 | Open homepage; search, combine filters, inspect event detail | Guest account, published test events in isolated test project | NOT VERIFIED; browser/database needed |
| 1:20–1:50 | Save an event and show personal recommendations/collection | Disposable test user and isolated DB | NOT VERIFIED; auth/RLS needed |
| 1:50–2:30 | Open official community information and announcement | Test community seeded in isolated DB | NOT VERIFIED; migration/RLS needed |
| 2:30–3:15 | Show organiser event management and analytics UI | Test organiser with owned test event | NOT VERIFIED; do not publish to production |
| 3:15–4:10 | Show ticket workflow only if isolated ticket fixture and finalized Devnet transaction evidence are available | Isolated DB, non-compromised Devnet test wallet, test event | NOT VERIFIED; skip if prerequisites are absent |
| 4:10–4:40 | Show natural-language discovery; voice only if ElevenLabs test path is verified | Isolated test project/provider configuration | NOT VERIFIED; Firecrawl remains disabled |
| 4:40–5:00 | Close with the vision: helping people find and take part in real-world experiences | Presentation | Ready as narration |

### Safe fallback

If test infrastructure is not ready, demonstrate only screens that the team has personally opened against a safe local/test dataset and label them as a local product walkthrough. Use genuine screenshots or recordings captured by the team; none were captured in this assessment. If those are unavailable, use the source/build/test evidence and explain what remains unverified. Do not substitute fabricated records, transaction hashes, metrics, provider output, screenshots or a production claim.

## Short pitch

**NODARA helps people discover what to experience next.** It brings event and community discovery, personal planning and organiser tools together in a privacy-first platform, with an on-chain ticket verification path designed for Solana Devnet.

## Concise project description

NODARA is a privacy-first experience discovery platform for finding events and communities, organizing personal plans, and helping organisers publish and manage experiences. It combines React and Supabase discovery workflows with an Anchor-based Solana Devnet ticket verification integration. Payment, voice and event-import integrations are implemented in source but remain subject to isolated test-environment verification; Firecrawl import stays disabled pending SSRF assurance.

## Source map

The paths below identify local implementation areas; the current branch contains uncommitted work, so remote links may not yet reflect these files.

| Capability | Source paths |
|---|---|
| Discovery and search | `src/App.tsx`, `src/services/eventService.ts`, `src/services/searchUtils.ts` |
| Personal recommendations | `src/services/recommendationService.ts`, `src/services/recommendationEngine.ts` |
| Organiser tools and analytics | `src/pages/OrganiserApp.tsx`, `src/pages/OrganiserAnalyticsPage.tsx`, `src/services/organiserAnalyticsService.ts` |
| Paystack functions | `supabase/functions/initialize-paystack-payment/`, `supabase/functions/paystack-webhook/`, `supabase/functions/request-paystack-refund/`, `supabase/functions/get-payment-status/` |
| Solana client and generated IDL | `src/services/solanaService.ts`, `src/idl/nodara_tickets.json`, `programs/nodara_tickets/src/lib.rs` |
| Solana trusted verification | `supabase/functions/verify-solana-ticket/`, `verify-solana-transfer/`, `verify-solana-check-in/`, `reconcile-solana-tickets/` |
| Firecrawl event import | `src/components/EventWebpageImporter.tsx`, `supabase/functions/import-event-webpage/index.ts`, `supabase/functions/_shared/phase12.mjs` |
| ElevenLabs voice and discovery | `src/pages/AiDiscoveryPage.tsx`, `src/services/naturalLanguageDiscovery.ts`, `supabase/functions/elevenlabs-event-speech/`, `supabase/functions/elevenlabs-transcribe/` |
| Automated tests | `tests/`, `supabase/tests/` |

## Current evidence and limitations

- `npm run build`: passed.
- `npm run lint`: passed.
- `npm test`: 15 files passed, 0 failed.
- `cargo test -p nodara_tickets --lib`: 1 test passed, with existing Anchor macro configuration warnings.
- No production database audit result was retrieved; the saved audit JSON explicitly records that catalog retrieval did not execute.
- No browser journey, isolated Supabase flow, Paystack test transaction/webhook, email delivery, ElevenLabs call, Firecrawl request or Devnet transaction was performed.
- Database migrations 006/007 and 009–014 have uncertain application status. Migration 008 is paused and must not be applied.
- Firecrawl must remain disabled until redirect/private-network protections are independently confirmed.
- Solana remains Devnet only; Paystack must remain in test mode.

## Claims to avoid

Do not claim production readiness, verified live ticket transactions, successful payment/refund, actual email delivery, active Firecrawl import, AI-generated answers, engagement/revenue metrics, user counts, deployed feature state, security certification or legal compliance based on this repository assessment.
