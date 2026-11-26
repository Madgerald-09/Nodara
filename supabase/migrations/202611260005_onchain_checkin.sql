-- On-chain check-in is the source of truth for registered tickets. This table
-- records only the independently verified Devnet result; browser clients cannot write it.
create table public.ticket_checkin_history (
  ticket_id uuid primary key references public.tickets(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  organizer_user_id uuid not null references public.profiles(id) on delete restrict,
  organizer_wallet text not null,
  solana_network text not null default 'devnet' check (solana_network = 'devnet'),
  transaction_signature text not null unique,
  verified_at timestamptz not null default now()
);
create index ticket_checkin_history_event_idx on public.ticket_checkin_history(event_id, verified_at desc);
alter table public.ticket_checkin_history enable row level security;
revoke all on public.ticket_checkin_history from public, anon, authenticated;
grant select on public.ticket_checkin_history to authenticated;
grant all on public.ticket_checkin_history to service_role;
create policy "Organisers and current holders read verified check-ins"
  on public.ticket_checkin_history for select to authenticated
  using (
    exists (select 1 from public.events e where e.id = ticket_checkin_history.event_id and e.organizer_id = (select auth.uid()))
    or exists (select 1 from public.tickets t where t.id = ticket_checkin_history.ticket_id and t.holder_user_id = (select auth.uid()))
  );

-- Report the current holder (rather than the original purchaser) on the organiser
-- attendee list after a verified transfer.
create or replace function public.get_event_attendees(p_event_id uuid)
returns table(ticket_id uuid, booking_reference text, attendee_name text, attendee_email text,
  ticket_type text, quantity integer, booking_status text, ticket_status text, checked_in_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.events where id=p_event_id and organizer_id=(select auth.uid())) then
    raise exception 'Event not found or access denied';
  end if;
  return query
    select t.id,b.booking_reference,p.full_name,au.email,tt.name,1::integer,b.status,t.status,t.checked_in_at,b.created_at
    from public.tickets t join public.bookings b on b.id=t.booking_id
    left join public.profiles p on p.id=t.holder_user_id left join auth.users au on au.id=t.holder_user_id
    join public.ticket_types tt on tt.id=t.ticket_type_id
    where t.event_id=p_event_id and b.status='confirmed' order by b.created_at desc;
end;
$$;
revoke all on function public.get_event_attendees(uuid) from public, anon;
grant execute on function public.get_event_attendees(uuid) to authenticated;

-- Called only by verify-solana-check-in after it validates the confirmed
-- transaction and reads the resulting Anchor accounts from Devnet.
create function public.record_verified_ticket_checkin(
  p_ticket_id uuid, p_event_id uuid, p_organizer_user_id uuid, p_organizer_wallet text,
  p_signature text, p_program_id text, p_ticket_account text, p_event_account text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_existing public.ticket_checkin_history%rowtype;
begin
  select * into v_existing from public.ticket_checkin_history where transaction_signature=p_signature;
  if found then
    if v_existing.ticket_id=p_ticket_id and v_existing.event_id=p_event_id
      and v_existing.organizer_user_id=p_organizer_user_id and v_existing.organizer_wallet=p_organizer_wallet then
      return jsonb_build_object('recorded',true,'idempotent',true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and event_id=p_event_id for update;
  if not found then raise exception 'Ticket does not exist for this event'; end if;
  select * into v_existing from public.ticket_checkin_history where transaction_signature=p_signature;
  if found then
    if v_existing.ticket_id=p_ticket_id and v_existing.event_id=p_event_id
      and v_existing.organizer_user_id=p_organizer_user_id and v_existing.organizer_wallet=p_organizer_wallet then
      return jsonb_build_object('recorded',true,'idempotent',true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;
  if not exists(select 1 from public.events e where e.id=p_event_id and e.organizer_id=p_organizer_user_id)
    or v_ticket.status <> 'issued' or v_ticket.blockchain_status <> 'verified'
    or v_ticket.solana_network <> 'devnet' or v_ticket.solana_program_id <> p_program_id
    or v_ticket.solana_ticket_account <> p_ticket_account or v_ticket.solana_event_account <> p_event_account then
    raise exception 'Ticket or organiser metadata changed before check-in synchronization';
  end if;
  if exists(select 1 from public.ticket_checkin_history h where h.ticket_id=p_ticket_id) then
    raise exception 'Ticket already has a verified on-chain check-in';
  end if;
  insert into public.ticket_checkin_history(ticket_id,event_id,organizer_user_id,organizer_wallet,transaction_signature)
    values(p_ticket_id,p_event_id,p_organizer_user_id,p_organizer_wallet,p_signature);
  update public.tickets set status='checked_in',checked_in_at=now(),checked_in_by=p_organizer_user_id where id=p_ticket_id;
  return jsonb_build_object('recorded',true,'idempotent',false);
end;
$$;
revoke all on function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text) to service_role;

-- Never let the legacy off-chain RPC set attendance for a ticket registered on
-- Solana. Such tickets can only be synchronized through the verifier above.
create or replace function public.check_in_ticket(p_event_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype;
begin
  if not exists(select 1 from public.events where id=p_event_id and organizer_id=(select auth.uid())) then
    raise exception 'Event not found or access denied';
  end if;
  if p_code is null or length(p_code)>100 then return jsonb_build_object('result','invalid'); end if;
  select * into v_ticket from public.tickets
    where event_id=p_event_id and (qr_token::text=p_code or (id::text=p_code and blockchain_status='off_chain')) for update;
  if not found then return jsonb_build_object('result','invalid'); end if;
  if v_ticket.blockchain_status <> 'off_chain' then return jsonb_build_object('result','requires_on_chain'); end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('result','cancelled'); end if;
  if v_ticket.status='checked_in' then return jsonb_build_object('result','already_used','checked_in_at',v_ticket.checked_in_at); end if;
  if not exists(select 1 from public.bookings where id=v_ticket.booking_id and status='confirmed') then
    return jsonb_build_object('result','invalid');
  end if;
  update public.tickets set status='checked_in',checked_in_at=now(),checked_in_by=(select auth.uid()) where id=v_ticket.id;
  return jsonb_build_object('result','valid','ticket_id',v_ticket.id);
end;
$$;
revoke all on function public.check_in_ticket(uuid,text) from public, anon;
grant execute on function public.check_in_ticket(uuid,text) to authenticated;
