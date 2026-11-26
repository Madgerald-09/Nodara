-- The purchaser remains recorded in user_id for booking/audit history. holder_user_id
-- represents who may currently access the ticket; it is cleared during a verified
-- transfer and set only after the recipient proves control of the destination wallet.
alter table public.tickets
  add column holder_user_id uuid references public.profiles(id) on delete set null;
update public.tickets set holder_user_id = user_id where holder_user_id is null;
create index tickets_holder_user_idx on public.tickets(holder_user_id, event_id, created_at desc);

create function public.initialize_ticket_holder()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.holder_user_id is null then new.holder_user_id := new.user_id; end if;
  return new;
end;
$$;
create trigger tickets_initialize_holder before insert on public.tickets
for each row execute function public.initialize_ticket_holder();
revoke all on function public.initialize_ticket_holder() from public, anon, authenticated;

drop policy "Ticket owners and event organisers read ticket records" on public.tickets;
create policy "Current ticket holders and event organisers read ticket records" on public.tickets for select to authenticated
  using (holder_user_id = (select auth.uid()) or exists(
    select 1 from public.events e where e.id = public.tickets.event_id and e.organizer_id = (select auth.uid())
  ));

drop policy "Attendees and event organisers read transfer history" on public.ticket_transfer_history;
create policy "Current ticket holders and event organisers read transfer history"
  on public.ticket_transfer_history for select to authenticated
  using (
    exists (select 1 from public.tickets t where t.id = ticket_transfer_history.ticket_id and t.holder_user_id = (select auth.uid()))
    or exists (select 1 from public.events e where e.id = ticket_transfer_history.event_id and e.organizer_id = (select auth.uid()))
  );

create or replace function public.get_my_tickets()
returns table(ticket_id uuid, qr_token uuid, ticket_status text, created_at timestamptz,
  booking_reference text, booking_status text, payment_status text, event_id uuid, event_title text,
  event_start timestamptz, event_end timestamptz, location text, venue text, cover_image text,
  ticket_type text, blockchain_status text)
language sql stable security definer set search_path = '' as $$
  select t.id,t.qr_token,t.status,t.created_at,b.booking_reference,b.status,b.payment_status,e.id,e.title,
    e.start_date,e.end_date,e.location,e.venue,e.cover_image,tt.name,t.blockchain_status
  from public.tickets t join public.bookings b on b.id=t.booking_id
  join public.events e on e.id=t.event_id join public.ticket_types tt on tt.id=t.ticket_type_id
  where t.holder_user_id=(select auth.uid()) and b.status='confirmed' order by e.start_date;
$$;

-- Rotate QR access on every verified transfer. Do not accept the stable public UUID
-- as a check-in code for on-chain tickets, or a previous owner could reuse it.
create or replace function public.check_in_ticket(p_event_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype;
begin
  if not exists(select 1 from public.events where id=p_event_id and organizer_id=auth.uid()) then
    raise exception 'Event not found or access denied';
  end if;
  if p_code is null or length(p_code)>100 then return jsonb_build_object('result','invalid'); end if;
  select * into v_ticket from public.tickets
    where event_id=p_event_id and (qr_token::text=p_code or (id::text=p_code and blockchain_status='off_chain')) for update;
  if not found then return jsonb_build_object('result','invalid'); end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('result','cancelled'); end if;
  if v_ticket.status='checked_in' then return jsonb_build_object('result','already_used','checked_in_at',v_ticket.checked_in_at); end if;
  if not exists(select 1 from public.bookings where id=v_ticket.booking_id and status='confirmed') then
    return jsonb_build_object('result','invalid');
  end if;
  update public.tickets set status='checked_in',checked_in_at=now(),checked_in_by=auth.uid() where id=v_ticket.id;
  return jsonb_build_object('result','valid','ticket_id',v_ticket.id);
end;
$$;

-- One transaction atomically records the verified on-chain receipt and removes the
-- previous NODARA user's ticket access. Only the trusted Edge Function may call this.
create function public.record_verified_ticket_transfer(
  p_ticket_id uuid, p_event_id uuid, p_current_user_id uuid,
  p_from_wallet text, p_to_wallet text, p_signature text,
  p_program_id text, p_ticket_account text, p_event_account text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_existing public.ticket_transfer_history%rowtype;
begin
  select * into v_existing from public.ticket_transfer_history where transaction_signature=p_signature;
  if found then
    if v_existing.ticket_id=p_ticket_id and v_existing.event_id=p_event_id
      and v_existing.from_wallet=p_from_wallet and v_existing.to_wallet=p_to_wallet
      and v_existing.solana_network='devnet' then
      return jsonb_build_object('recorded',true,'idempotent',true);
    end if;
    raise exception 'Transaction signature was already used for a different transfer';
  end if;

  select * into v_ticket from public.tickets where id=p_ticket_id and event_id=p_event_id for update;
  if not found then raise exception 'Ticket does not exist for this event'; end if;
  -- Recheck after acquiring the ticket lock so two concurrent calls for the same
  -- confirmed signature resolve idempotently instead of racing the holder update.
  select * into v_existing from public.ticket_transfer_history where transaction_signature=p_signature;
  if found then
    if v_existing.ticket_id=p_ticket_id and v_existing.event_id=p_event_id
      and v_existing.from_wallet=p_from_wallet and v_existing.to_wallet=p_to_wallet
      and v_existing.solana_network='devnet' then
      return jsonb_build_object('recorded',true,'idempotent',true);
    end if;
    raise exception 'Transaction signature was already used for a different transfer';
  end if;
  if v_ticket.holder_user_id is distinct from p_current_user_id
    or v_ticket.status <> 'issued' or v_ticket.blockchain_status <> 'verified'
    or v_ticket.solana_network <> 'devnet' or v_ticket.solana_program_id <> p_program_id
    or v_ticket.solana_ticket_account <> p_ticket_account or v_ticket.solana_event_account <> p_event_account
    or v_ticket.wallet_address <> p_from_wallet then
    raise exception 'Ticket holder or verified chain metadata changed before synchronization';
  end if;
  if p_from_wallet = p_to_wallet then raise exception 'Ticket recipient must differ from its current owner'; end if;

  insert into public.ticket_transfer_history(ticket_id,event_id,from_wallet,to_wallet,solana_network,transaction_signature)
    values(p_ticket_id,p_event_id,p_from_wallet,p_to_wallet,'devnet',p_signature);
  update public.tickets set wallet_address=p_to_wallet, solana_transaction_signature=p_signature,
    holder_user_id=null, qr_token=gen_random_uuid()
    where id=p_ticket_id and event_id=p_event_id;
  return jsonb_build_object('recorded',true,'idempotent',false);
end;
$$;

-- The recipient must sign a message tied to their NODARA user, the ticket, and their
-- wallet. This function is called only after the Edge Function verifies that proof
-- and re-reads the current on-chain owner.
create function public.claim_transferred_ticket(p_ticket_id uuid,p_user_id uuid,p_wallet text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype;
begin
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or v_ticket.blockchain_status <> 'verified' or v_ticket.solana_network <> 'devnet'
    or v_ticket.wallet_address <> p_wallet or v_ticket.status <> 'issued'
    or not exists(select 1 from public.ticket_transfer_history h where h.ticket_id=p_ticket_id and h.to_wallet=p_wallet) then
    return false;
  end if;
  if v_ticket.holder_user_id = p_user_id then return true; end if;
  if v_ticket.holder_user_id is not null then return false; end if;
  update public.tickets set holder_user_id=p_user_id where id=p_ticket_id and holder_user_id is null;
  return found;
end;
$$;

revoke all on function public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.claim_transferred_ticket(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text) to service_role;
grant execute on function public.claim_transferred_ticket(uuid,uuid,text) to service_role;
