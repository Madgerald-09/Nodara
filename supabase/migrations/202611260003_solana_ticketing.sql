-- Additive Devnet ticket metadata. No wallet address, identity or ticket-holder data is written on-chain.
alter table public.events
  add column allow_ticket_transfers boolean not null default false,
  add column solana_network text,
  add column solana_program_id text,
  add column solana_event_account text;

alter table public.events add constraint events_solana_network_check
  check (solana_network is null or solana_network = 'devnet');
create unique index events_solana_account_unique on public.events(solana_event_account)
  where solana_event_account is not null;

-- Do not let a browser choose chain identifiers or change transfer policy. Keep the
-- existing organiser editing features using explicit column-level update grants.
revoke update on public.events from authenticated;
grant update (title, slug, short_description, description, category, cover_image,
  location, address, venue, country, start_date, end_date, price, currency,
  capacity, status) on public.events to authenticated;

alter table public.tickets
  add column solana_program_id text,
  add column solana_ticket_account text,
  add column solana_event_account text,
  add column blockchain_verified_at timestamptz;
alter table public.tickets add constraint tickets_solana_network_check
  check (solana_network is null or solana_network = 'devnet');
create unique index tickets_solana_account_unique on public.tickets(solana_ticket_account)
  where solana_ticket_account is not null;
create unique index tickets_id_event_unique on public.tickets(id, event_id);

create table public.ticket_transfer_history (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null,
  event_id uuid not null references public.events(id) on delete cascade,
  from_wallet text not null,
  to_wallet text not null,
  solana_network text not null default 'devnet' check (solana_network = 'devnet'),
  transaction_signature text not null unique,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (from_wallet <> to_wallet),
  foreign key (ticket_id, event_id) references public.tickets(id, event_id) on delete cascade
);
create index ticket_transfer_history_ticket_idx on public.ticket_transfer_history(ticket_id, created_at desc);
create index ticket_transfer_history_event_idx on public.ticket_transfer_history(event_id, created_at desc);

alter table public.ticket_transfer_history enable row level security;
revoke all on public.ticket_transfer_history from public, anon, authenticated;
grant all on public.ticket_transfer_history to service_role;
grant select on public.ticket_transfer_history to authenticated;
create policy "Attendees and event organisers read transfer history"
  on public.ticket_transfer_history for select to authenticated
  using (
    exists (select 1 from public.tickets t where t.id = ticket_transfer_history.ticket_id and t.user_id = (select auth.uid()))
    or exists (select 1 from public.events e where e.id = ticket_transfer_history.event_id and e.organizer_id = (select auth.uid()))
  );

-- Chain metadata is written only by a trusted verifier using service_role after RPC verification.
-- Existing client privileges and RLS policies on events and tickets are preserved as-is.
