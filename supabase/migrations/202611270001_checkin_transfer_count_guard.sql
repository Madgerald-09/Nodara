-- Fix stale transfer-count synchronization for on-chain check-ins.
-- The locked DB count is compared with independently verified Devnet state.
-- NULL is accepted for legacy/uninitialized tickets and is replaced by the
-- verified count as part of the successful attendance update.
create or replace function public.record_verified_ticket_checkin(
  p_ticket_id uuid, p_event_id uuid, p_organizer_user_id uuid, p_organizer_wallet text,
  p_signature text, p_program_id text, p_ticket_account text, p_event_account text,
  p_owner_wallet text, p_transfer_count bigint, p_verified_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ticket public.tickets%rowtype;
  v_existing public.ticket_checkin_history%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted check-in verifier required';
  end if;
  if p_transfer_count is null or p_transfer_count < 0 or p_transfer_count > 4294967295
    or p_verified_at is null or p_owner_wallet is null then
    raise exception 'Verified check-in evidence is incomplete';
  end if;

  select * into v_existing
  from public.ticket_checkin_history
  where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.organizer_user_id = p_organizer_user_id
      and v_existing.organizer_wallet = p_organizer_wallet then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id and event_id = p_event_id
  for update;
  if not found then raise exception 'Ticket does not exist for this event'; end if;

  -- Repeat the signature lookup under the ticket row lock to make concurrent
  -- retries idempotent. The unique signature constraint is the final safeguard.
  select * into v_existing
  from public.ticket_checkin_history
  where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.organizer_user_id = p_organizer_user_id
      and v_existing.organizer_wallet = p_organizer_wallet then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;

  if not exists (
      select 1 from public.events e
      where e.id = p_event_id and e.organizer_id = p_organizer_user_id
    )
    or v_ticket.status <> 'issued'
    or v_ticket.blockchain_status <> 'verified'
    or v_ticket.solana_network <> 'devnet'
    or v_ticket.solana_program_id <> p_program_id
    or v_ticket.solana_ticket_account <> p_ticket_account
    or v_ticket.solana_event_account <> p_event_account
    or v_ticket.holder_user_id is null
    or v_ticket.wallet_address is distinct from p_owner_wallet then
    raise exception 'Ticket holder, wallet owner or organiser metadata changed before check-in synchronization';
  end if;
  if v_ticket.solana_transfer_count is not null
    and v_ticket.solana_transfer_count <> p_transfer_count then
    raise exception 'Stored ticket transfer count does not match verified Devnet state';
  end if;
  if exists (
    select 1 from public.ticket_checkin_history h where h.ticket_id = p_ticket_id
  ) then
    raise exception 'Ticket already has a verified on-chain check-in';
  end if;

  insert into public.ticket_checkin_history(
    ticket_id, event_id, organizer_user_id, organizer_wallet, transaction_signature, verified_at
  ) values (
    p_ticket_id, p_event_id, p_organizer_user_id, p_organizer_wallet, p_signature, p_verified_at
  );
  update public.tickets set
    status = 'checked_in',
    checked_in_at = p_verified_at,
    checked_in_by = p_organizer_user_id,
    solana_ticket_valid = true,
    solana_checked_in = true,
    solana_transfer_count = p_transfer_count,
    solana_transaction_signature = p_signature
  where id = p_ticket_id and event_id = p_event_id;
  return jsonb_build_object('recorded', true, 'idempotent', false);
end;
$$;

revoke all on function public.record_verified_ticket_checkin(
  uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz
) from public, anon, authenticated;
grant execute on function public.record_verified_ticket_checkin(
  uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz
) to service_role;

-- The production catalog showed no catalog dependents for this obsolete
-- SECURITY DEFINER overload. Repository-wide search also found no callers.
-- Migration 007 intended to retire this signature. The audited permissions were
-- service_role only; removing it closes the route that bypasses count validation.
drop function if exists public.record_verified_ticket_checkin(
  uuid,uuid,uuid,text,text,text,text,text,text
);
