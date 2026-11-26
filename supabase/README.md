# Supabase setup

## Configure the frontend

Copy `.env.example` to `.env.local` in the project root. The supplied project URL and publishable key are already listed in the example. Vite exposes only variables prefixed with `VITE_`; use the publishable key here. Never place a service role key or database password in a frontend environment file.

Restart `npm run dev` after changing environment values. The app validates the URL and key format at startup and shows a configuration message when either value is missing or malformed.

## Apply the database migration

In the Supabase Dashboard, open **SQL Editor**, create a new query, paste the contents of `migrations/202611240001_initial_schema.sql`, and run it against the NODARA project. This creates the six application tables, signup and validation triggers, indexes, grants, RLS policies, and the member-count RPC.

The migration creates an empty event and community catalogue. Insert or import published `events` and `communities` rows before expecting cards to appear. New Auth users receive a `profiles` row automatically. Creating a community also creates its creator's owner membership automatically.

For ticketing and Devnet transfers, also apply the later additive migrations in filename order after the initial/event migrations. In particular, `202611260004_controlled_transfers.sql` must be applied after `202611260002_ticketing.sql` and `202611260003_solana_ticketing.sql`; it updates ticket-holder RLS and installs server-only atomic synchronization functions.

## Event organiser fields

The event editor also stores a short card summary and a full street address. Since the initial schema may already be applied, apply `migrations/202611260001_event_content_fields.sql` once in **SQL Editor** before creating or editing events from the organiser UI. This only adds nullable columns and checks; it does not change RLS policies or existing event data.

## Configure Auth

In **Authentication → Providers**, enable Email and Password. In **Authentication → URL Configuration**, set the Site URL for the deployed app and add development/deployment URLs to the Redirect URLs list (for local Vite, `http://localhost:5173`). Keep email confirmation enabled for production and configure a working email delivery provider.

## Security model

- Browser code uses only the project's publishable key; PostgreSQL RLS is the authority for user data.
- Clients can add only their own regular community memberships. The database assigns the creator's owner role in a trigger; there is no client update policy for roles.
- The community count RPC returns only community IDs and aggregate counts. Membership rows remain readable only to their member.
- Booking rows are always pending on insert. A database trigger takes amount and currency from the published event and only permits a pending request to become cancelled through the client policy.
- No payment, capacity reservation, organizer publishing UI, or admin role assignment workflow is included in this milestone.

## Devnet transfer functions

Deploy `verify-solana-transfer` and `claim-transferred-ticket` after applying migration `202611260004_controlled_transfers.sql`. Both functions require the authenticated user JWT and use the Supabase service-role key only in the Edge Function runtime. They check Devnet and the pinned NODARA program; do not add service-role credentials to `.env.local` or Vite configuration.

The migration should be applied to a staging project and its RLS policies exercised with anon and multiple authenticated accounts before production use. The repository build does not connect to or mutate the Supabase project.
