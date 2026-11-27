alter table public.tickets
  add column solana_registration_signature text,
  add column solana_ticket_valid boolean,
  add column solana_checked_in boolean,
  add column solana_transfer_count bigint
    check (solana_transfer_count is null or solana_transfer_count between 0 and 4294967295);

alter table public.ticket_transfer_history
  add column transfer_sequence bigint
    check (transfer_sequence is null or transfer_sequence between 0 and 4294967295),
  add column solana_receipt_account text;

create unique index ticket_transfer_history_sequence_unique
  on public.ticket_transfer_history(ticket_id, transfer_sequence)
  where transfer_sequence is not null;
create unique index ticket_transfer_history_receipt_unique
  on public.ticket_transfer_history(solana_receipt_account)
  where solana_receipt_account is not null;

create table public.solana_reconciliation_runs (
  id uuid primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  mode text not null check (mode in ('scan', 'repair')),
  scope text not null check (scope in ('ticket', 'event')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  page_size integer not null check (page_size between 1 and 25),
  cursor_after uuid,
  source_run_id uuid references public.solana_reconciliation_runs(id) on delete set null,
  checked_count integer not null default 0 check (checked_count >= 0),
  in_sync_count integer not null default 0 check (in_sync_count >= 0),
  discrepancy_count integer not null default 0 check (discrepancy_count >= 0),
  repaired_count integer not null default 0 check (repaired_count >= 0),
  manual_review_count integer not null default 0 check (manual_review_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index solana_reconciliation_runs_actor_idx
  on public.solana_reconciliation_runs(initiated_by, created_at desc);
create index solana_reconciliation_runs_event_idx
  on public.solana_reconciliation_runs(event_id, created_at desc);

create table public.solana_reconciliation_audit (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.solana_reconciliation_runs(id) on delete cascade,
  source_run_id uuid references public.solana_reconciliation_runs(id) on delete set null,
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_id uuid not null,
  classification text not null check (classification in (
    'IN_SYNC', 'MISSING_ON_CHAIN', 'MISSING_IN_DATABASE', 'OWNER_MISMATCH',
    'STATUS_MISMATCH', 'TRANSFER_HISTORY_MISMATCH', 'CHECKIN_MISMATCH',
    'INVALID_ACCOUNT', 'PENDING_CONFIRMATION', 'RPC_UNAVAILABLE',
    'REQUIRES_MANUAL_REVIEW'
  )),
  database_state jsonb,
  verified_chain_state jsonb,
  action_taken text not null default 'none',
  repair_succeeded boolean,
  auto_repair_safe boolean not null default false,
  reason text not null,
  transaction_signature text,
  error_details text,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (run_id, ticket_id)
);
create index solana_reconciliation_audit_event_idx
  on public.solana_reconciliation_audit(event_id, created_at desc);
create index solana_reconciliation_audit_ticket_idx
  on public.solana_reconciliation_audit(ticket_id, created_at desc);

alter table public.solana_reconciliation_runs enable row level security;
alter table public.solana_reconciliation_audit enable row level security;
revoke all on public.solana_reconciliation_runs, public.solana_reconciliation_audit
  from public, anon, authenticated;
grant all on public.solana_reconciliation_runs, public.solana_reconciliation_audit to service_role;
grant usage, select on sequence public.solana_reconciliation_audit_id_seq to service_role;

create function public.start_solana_reconciliation_run(
  p_run_id uuid,
  p_event_id uuid,
  p_initiated_by uuid,
  p_mode text,
  p_scope text,
  p_page_size integer,
  p_cursor_after uuid default null,
  p_source_run_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_source public.solana_reconciliation_runs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted reconciliation service may start a run';
  end if;
  if p_mode not in ('scan', 'repair') or p_scope not in ('ticket', 'event')
    or p_page_size < 1 or p_page_size > 25 then
    raise exception 'Invalid reconciliation request limits';
  end if;
  if not exists (
    select 1 from public.events e
    where e.id = p_event_id and e.organizer_id = p_initiated_by
  ) then
    raise exception 'Event not found or access denied';
  end if;
  if p_mode = 'repair' then
    select * into v_source from public.solana_reconciliation_runs
      where id = p_source_run_id and event_id = p_event_id
        and initiated_by = p_initiated_by and mode = 'scan' and status = 'completed';
    if not found then raise exception 'Source reconciliation run was not found'; end if;
  elsif p_source_run_id is not null then
    raise exception 'A scan cannot reference a repair source run';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_initiated_by::text, 0));
  if (
    select count(*) from public.solana_reconciliation_runs r
    where r.initiated_by = p_initiated_by and r.created_at > now() - interval '1 minute'
  ) >= 12 then
    raise exception 'Reconciliation request rate limit exceeded';
  end if;

  insert into public.solana_reconciliation_runs(
    id, event_id, initiated_by, mode, scope, page_size, cursor_after, source_run_id
  ) values (
    p_run_id, p_event_id, p_initiated_by, p_mode, p_scope, p_page_size, p_cursor_after, p_source_run_id
  );
  return p_run_id;
end;
$$;
revoke all on function public.start_solana_reconciliation_run(uuid,uuid,uuid,text,text,integer,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.start_solana_reconciliation_run(uuid,uuid,uuid,text,text,integer,uuid,uuid)
  to service_role;

create function public.finish_solana_reconciliation_run(
  p_run_id uuid,
  p_initiated_by uuid,
  p_status text,
  p_checked_count integer,
  p_in_sync_count integer,
  p_discrepancy_count integer,
  p_repaired_count integer,
  p_manual_review_count integer,
  p_error_count integer
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted reconciliation service may finish a run';
  end if;
  if p_status not in ('completed', 'failed') then raise exception 'Invalid run status'; end if;
  update public.solana_reconciliation_runs
  set status = p_status,
      checked_count = greatest(p_checked_count, 0),
      in_sync_count = greatest(p_in_sync_count, 0),
      discrepancy_count = greatest(p_discrepancy_count, 0),
      repaired_count = greatest(p_repaired_count, 0),
      manual_review_count = greatest(p_manual_review_count, 0),
      error_count = greatest(p_error_count, 0),
      completed_at = now()
  where id = p_run_id and initiated_by = p_initiated_by and status = 'running';
  if not found then raise exception 'Reconciliation run is unavailable or already finished'; end if;
end;
$$;
revoke all on function public.finish_solana_reconciliation_run(uuid,uuid,text,integer,integer,integer,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.finish_solana_reconciliation_run(uuid,uuid,text,integer,integer,integer,integer,integer,integer)
  to service_role;

create function public.apply_solana_ticket_reconciliation(
  p_run_id uuid,
  p_source_run_id uuid,
  p_ticket_id uuid,
  p_initiated_by uuid,
  p_classification text,
  p_previous_state jsonb,
  p_verified_chain_state jsonb,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.solana_reconciliation_runs%rowtype;
  v_source public.solana_reconciliation_audit%rowtype;
  v_ticket public.tickets%rowtype;
  v_event public.events%rowtype;
  v_transfer jsonb;
  v_existing public.ticket_transfer_history%rowtype;
  v_owner text;
  v_signature text;
  v_block_time bigint;
  v_transfer_count bigint;
  v_expected_sequence bigint := 0;
  v_previous_owner text;
  v_action text := 'synchronized verified chain state';
  v_previous jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted reconciliation service may repair ticket records';
  end if;
  select * into v_run from public.solana_reconciliation_runs
    where id = p_run_id and initiated_by = p_initiated_by and mode = 'repair'
      and source_run_id = p_source_run_id and status = 'running' for update;
  if not found then raise exception 'Repair run is unavailable'; end if;
  select * into v_source from public.solana_reconciliation_audit
    where run_id = p_run_id and source_run_id = p_source_run_id and ticket_id = p_ticket_id
      and initiated_by = p_initiated_by and repair_succeeded;
  if found then
    return jsonb_build_object('repaired', true, 'idempotent', true, 'action', v_source.action_taken);
  end if;
  select * into v_source from public.solana_reconciliation_audit
    where run_id = p_source_run_id and event_id = v_run.event_id and ticket_id = p_ticket_id
      and initiated_by = p_initiated_by and auto_repair_safe;
  if not found or v_source.classification <> p_classification then
    raise exception 'This discrepancy was not marked safe for automatic repair';
  end if;
  if v_source.verified_chain_state->>'ticketAccount' is distinct from p_verified_chain_state->>'ticketAccount'
    or v_source.verified_chain_state->>'eventAccount' is distinct from p_verified_chain_state->>'eventAccount'
    or v_source.verified_chain_state->>'network' is distinct from p_verified_chain_state->>'network'
    or v_source.verified_chain_state->>'programId' is distinct from p_verified_chain_state->>'programId'
    or v_source.verified_chain_state->>'eventId' is distinct from p_verified_chain_state->>'eventId'
    or v_source.verified_chain_state->>'ticketId' is distinct from p_verified_chain_state->>'ticketId'
    or v_source.verified_chain_state->>'organizer' is distinct from p_verified_chain_state->>'organizer'
    or v_source.verified_chain_state->>'issuer' is distinct from p_verified_chain_state->>'issuer'
    or v_source.verified_chain_state->>'initialOwner' is distinct from p_verified_chain_state->>'initialOwner'
    or v_source.verified_chain_state->>'owner' is distinct from p_verified_chain_state->>'owner'
    or v_source.verified_chain_state->>'valid' is distinct from p_verified_chain_state->>'valid'
    or v_source.verified_chain_state->>'checkedIn' is distinct from p_verified_chain_state->>'checkedIn'
    or v_source.verified_chain_state->>'transferCount' is distinct from p_verified_chain_state->>'transferCount'
    or v_source.verified_chain_state->'transferHistory' is distinct from p_verified_chain_state->'transferHistory'
    or v_source.verified_chain_state->>'registrationSignature' is distinct from p_verified_chain_state->>'registrationSignature'
    or v_source.verified_chain_state->>'checkInSignature' is distinct from p_verified_chain_state->>'checkInSignature'
    or v_source.verified_chain_state->>'checkInBlockTime' is distinct from p_verified_chain_state->>'checkInBlockTime'
    or v_source.verified_chain_state->>'checkInOrganizerWallet' is distinct from p_verified_chain_state->>'checkInOrganizerWallet'
    or v_source.verified_chain_state->>'lastTransferSignature' is distinct from p_verified_chain_state->>'lastTransferSignature' then
    raise exception 'Verified chain evidence changed; run reconciliation again';
  end if;
  select * into v_event from public.events
    where id = v_run.event_id and organizer_id = p_initiated_by;
  if not found then raise exception 'Event access changed before repair'; end if;
  select * into v_ticket from public.tickets
    where id = p_ticket_id and event_id = v_run.event_id for update;
  if not found then raise exception 'Ticket record changed before repair'; end if;

  v_previous := jsonb_build_object(
    'status', v_ticket.status,
    'blockchainStatus', v_ticket.blockchain_status,
    'network', v_ticket.solana_network,
    'programId', v_ticket.solana_program_id,
    'ticketAccount', v_ticket.solana_ticket_account,
    'eventAccount', v_ticket.solana_event_account,
    'registrationSignature', v_ticket.solana_registration_signature,
    'walletAddress', v_ticket.wallet_address,
    'ticketValid', v_ticket.solana_ticket_valid,
    'checkedIn', v_ticket.solana_checked_in,
    'transferCount', v_ticket.solana_transfer_count,
    'checkedInAt', v_ticket.checked_in_at,
    'checkedInBy', v_ticket.checked_in_by
  );
  if v_ticket.status is distinct from p_previous_state->>'status'
    or v_ticket.blockchain_status is distinct from p_previous_state->>'blockchainStatus'
    or v_ticket.solana_network is distinct from p_previous_state->>'network'
    or v_ticket.solana_program_id is distinct from p_previous_state->>'programId'
    or v_ticket.solana_ticket_account is distinct from p_previous_state->>'ticketAccount'
    or v_ticket.solana_event_account is distinct from p_previous_state->>'eventAccount'
    or v_ticket.solana_registration_signature is distinct from p_previous_state->>'registrationSignature'
    or v_ticket.wallet_address is distinct from p_previous_state->>'walletAddress'
    or v_ticket.solana_ticket_valid is distinct from nullif(p_previous_state->>'ticketValid', '')::boolean
    or v_ticket.solana_checked_in is distinct from nullif(p_previous_state->>'checkedIn', '')::boolean
    or v_ticket.solana_transfer_count is distinct from nullif(p_previous_state->>'transferCount', '')::bigint
    or v_ticket.checked_in_at is distinct from nullif(p_previous_state->>'checkedInAt', '')::timestamptz
    or v_ticket.checked_in_by is distinct from nullif(p_previous_state->>'checkedInBy', '')::uuid then
    raise exception 'Ticket database state changed; run reconciliation again';
  end if;

  v_owner := p_verified_chain_state->>'owner';
  v_transfer_count := (p_verified_chain_state->>'transferCount')::bigint;
  if p_verified_chain_state->>'network' is distinct from 'devnet'
    or p_verified_chain_state->>'programId' is distinct from 'CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf'
    or p_verified_chain_state->>'eventId' is distinct from v_run.event_id::text
    or p_verified_chain_state->>'ticketId' is distinct from p_ticket_id::text
    or p_verified_chain_state->>'ticketAccount' is null
    or p_verified_chain_state->>'eventAccount' is null
    or p_verified_chain_state->>'registrationSignature' is null
    or v_owner is null
    or v_transfer_count is null
    or v_transfer_count < 0 or v_transfer_count > 4294967295 then
    raise exception 'Verified chain evidence is incomplete or outside Devnet';
  end if;
  if jsonb_typeof(p_verified_chain_state->'valid') is distinct from 'boolean'
    or jsonb_typeof(p_verified_chain_state->'checkedIn') is distinct from 'boolean' then
    raise exception 'Verified chain validity or check-in state is missing';
  end if;
  if v_ticket.solana_ticket_account is not null
    and v_ticket.solana_ticket_account <> p_verified_chain_state->>'ticketAccount' then
    raise exception 'Stored ticket PDA conflicts with verified chain evidence';
  end if;
  if v_ticket.solana_event_account is not null
    and v_ticket.solana_event_account <> p_verified_chain_state->>'eventAccount' then
    raise exception 'Stored event PDA conflicts with verified chain evidence';
  end if;

  if case
      when jsonb_typeof(p_verified_chain_state->'transferHistory') = 'array'
        then jsonb_array_length(p_verified_chain_state->'transferHistory') <> v_transfer_count
      else true
    end then
    raise exception 'Complete verified transfer history is required for repair';
  end if;
  v_previous_owner := p_verified_chain_state->>'initialOwner';
  if v_previous_owner is null then raise exception 'Verified registration owner is missing'; end if;
  for v_transfer in
    select value from jsonb_array_elements(p_verified_chain_state->'transferHistory') with ordinality as transfers(value, position)
    order by position
  loop
    if v_transfer->>'sequence' is null
      or (v_transfer->>'sequence')::bigint <> v_expected_sequence
      or v_transfer->>'signature' is null
      or v_transfer->>'receiptAccount' is null
      or v_transfer->>'fromWallet' is null
      or v_transfer->>'toWallet' is null
      or v_transfer->>'fromWallet' = v_transfer->>'toWallet'
      or v_transfer->>'fromWallet' is distinct from v_previous_owner then
      raise exception 'A verified transfer entry is incomplete';
    end if;
    v_expected_sequence := v_expected_sequence + 1;
    v_previous_owner := v_transfer->>'toWallet';
    select * into v_existing from public.ticket_transfer_history
      where transaction_signature = v_transfer->>'signature' for update;
    if found then
      if v_existing.ticket_id <> p_ticket_id or v_existing.event_id <> v_run.event_id
        or v_existing.from_wallet <> v_transfer->>'fromWallet'
        or v_existing.to_wallet <> v_transfer->>'toWallet'
        or v_existing.solana_network <> 'devnet'
        or (v_existing.transfer_sequence is not null and v_existing.transfer_sequence <> (v_transfer->>'sequence')::bigint)
        or (v_existing.solana_receipt_account is not null and v_existing.solana_receipt_account <> v_transfer->>'receiptAccount') then
        raise exception 'Stored transfer history conflicts with verified chain history';
      end if;
      update public.ticket_transfer_history set transfer_sequence = (v_transfer->>'sequence')::bigint,
        solana_receipt_account = v_transfer->>'receiptAccount'
      where id = v_existing.id;
    else
      select * into v_existing from public.ticket_transfer_history
        where ticket_id = p_ticket_id and transfer_sequence = (v_transfer->>'sequence')::bigint for update;
      if found then raise exception 'A different transfer is already stored for this sequence'; end if;
      insert into public.ticket_transfer_history(
        ticket_id, event_id, from_wallet, to_wallet, solana_network, transaction_signature,
        transfer_sequence, solana_receipt_account
      ) values (
        p_ticket_id, v_run.event_id, v_transfer->>'fromWallet', v_transfer->>'toWallet',
        'devnet', v_transfer->>'signature', (v_transfer->>'sequence')::bigint,
        v_transfer->>'receiptAccount'
      );
    end if;
  end loop;
  if v_previous_owner is distinct from v_owner then
    raise exception 'Verified transfer history does not lead to the current chain owner';
  end if;
  if (select count(*) from public.ticket_transfer_history where ticket_id = p_ticket_id) <> v_transfer_count
    or exists (
      select 1 from public.ticket_transfer_history h
      where h.ticket_id = p_ticket_id and (h.transfer_sequence is null or h.solana_receipt_account is null)
    ) then
    raise exception 'Stored transfer history is not a complete match for the chain';
  end if;

  if (p_verified_chain_state->>'checkedIn')::boolean then
    v_signature := p_verified_chain_state->>'checkInSignature';
    v_block_time := (p_verified_chain_state->>'checkInBlockTime')::bigint;
    if v_signature is null or v_block_time is null
      or p_verified_chain_state->>'checkInOrganizerWallet' is null then
      raise exception 'Finalized check-in transaction evidence is required';
    end if;
    if v_ticket.status = 'cancelled' then raise exception 'Cancelled tickets cannot be automatically reactivated'; end if;
    if v_ticket.checked_in_by is not null and v_ticket.checked_in_by <> p_initiated_by then
      raise exception 'Stored attendance organiser conflicts with the authorised event owner';
    end if;
    if exists (
      select 1 from public.ticket_checkin_history h
      where h.ticket_id = p_ticket_id and (
        h.event_id <> v_run.event_id or h.organizer_user_id <> p_initiated_by
        or h.organizer_wallet <> p_verified_chain_state->>'checkInOrganizerWallet'
        or h.transaction_signature <> v_signature
      )
    ) then raise exception 'Stored check-in history conflicts with the finalized transaction'; end if;
    insert into public.ticket_checkin_history(
      ticket_id, event_id, organizer_user_id, organizer_wallet, solana_network,
      transaction_signature, verified_at
    ) values (
      p_ticket_id, v_run.event_id, p_initiated_by, p_verified_chain_state->>'checkInOrganizerWallet',
      'devnet', v_signature, to_timestamp(v_block_time)
    ) on conflict (ticket_id) do nothing;
    update public.tickets set status = 'checked_in', checked_in_at = to_timestamp(v_block_time),
      checked_in_by = p_initiated_by
    where id = p_ticket_id and event_id = v_run.event_id and status in ('issued', 'checked_in');
    v_action := 'synchronized finalized on-chain check-in';
  elsif v_ticket.status = 'checked_in' then
    raise exception 'Database check-in cannot be cleared automatically';
  elsif not (p_verified_chain_state->>'valid')::boolean and v_ticket.status = 'issued' then
    update public.tickets set status = 'cancelled'
      where id = p_ticket_id and event_id = v_run.event_id and status = 'issued';
    v_action := 'marked ticket cancelled from finalized on-chain invalidation';
  elsif (p_verified_chain_state->>'valid')::boolean and v_ticket.status = 'cancelled' then
    raise exception 'A cancelled application ticket cannot be automatically reactivated';
  end if;

  update public.tickets set
    solana_network = 'devnet',
    solana_program_id = 'CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf',
    solana_ticket_account = p_verified_chain_state->>'ticketAccount',
    solana_event_account = p_verified_chain_state->>'eventAccount',
    solana_registration_signature = p_verified_chain_state->>'registrationSignature',
    blockchain_status = 'verified',
    blockchain_verified_at = coalesce(blockchain_verified_at, now()),
    wallet_address = v_owner,
    holder_user_id = case when wallet_address is distinct from v_owner then null else holder_user_id end,
    qr_token = case when wallet_address is distinct from v_owner then gen_random_uuid() else qr_token end,
    solana_ticket_valid = (p_verified_chain_state->>'valid')::boolean,
    solana_checked_in = (p_verified_chain_state->>'checkedIn')::boolean,
    solana_transfer_count = v_transfer_count,
    solana_transaction_signature = coalesce(
      p_verified_chain_state->>'checkInSignature',
      p_verified_chain_state->>'lastTransferSignature',
      p_verified_chain_state->>'registrationSignature'
    )
  where id = p_ticket_id and event_id = v_run.event_id;

  insert into public.solana_reconciliation_audit(
    run_id, source_run_id, event_id, ticket_id, classification, database_state,
    verified_chain_state, action_taken, repair_succeeded, auto_repair_safe,
    reason, transaction_signature, initiated_by
  ) values (
    p_run_id, p_source_run_id, v_run.event_id, p_ticket_id, p_classification,
    v_previous, p_verified_chain_state, v_action, true, true, p_reason,
    coalesce(p_verified_chain_state->>'checkInSignature', p_verified_chain_state->>'lastTransferSignature',
      p_verified_chain_state->>'registrationSignature'), p_initiated_by
  ) on conflict (run_id, ticket_id) do update set
    verified_chain_state = excluded.verified_chain_state,
    action_taken = excluded.action_taken,
    repair_succeeded = true,
    error_details = null;
  return jsonb_build_object('repaired', true, 'action', v_action);
end;
$$;
revoke all on function public.apply_solana_ticket_reconciliation(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.apply_solana_ticket_reconciliation(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)
  to service_role;

drop function public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text);
create function public.record_verified_ticket_transfer(
  p_ticket_id uuid, p_event_id uuid, p_current_user_id uuid,
  p_from_wallet text, p_to_wallet text, p_signature text,
  p_program_id text, p_ticket_account text, p_event_account text,
  p_transfer_sequence bigint, p_receipt_account text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_existing public.ticket_transfer_history%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted transfer verifier required'; end if;
  if p_transfer_sequence is null or p_transfer_sequence < 0 or p_transfer_sequence > 4294967295
    or p_receipt_account is null or p_signature is null or p_from_wallet is null or p_to_wallet is null then
    raise exception 'Verified transfer receipt is invalid';
  end if;
  select * into v_existing from public.ticket_transfer_history where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.from_wallet = p_from_wallet and v_existing.to_wallet = p_to_wallet
      and v_existing.solana_network = 'devnet'
      and v_existing.transfer_sequence = p_transfer_sequence
      and v_existing.solana_receipt_account = p_receipt_account then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for a different transfer';
  end if;
  select * into v_ticket from public.tickets where id = p_ticket_id and event_id = p_event_id for update;
  if not found then raise exception 'Ticket does not exist for this event'; end if;
  select * into v_existing from public.ticket_transfer_history where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.from_wallet = p_from_wallet and v_existing.to_wallet = p_to_wallet
      and v_existing.solana_network = 'devnet'
      and v_existing.transfer_sequence = p_transfer_sequence
      and v_existing.solana_receipt_account = p_receipt_account then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for a different transfer';
  end if;
  if v_ticket.holder_user_id is distinct from p_current_user_id
    or v_ticket.status <> 'issued' or v_ticket.blockchain_status <> 'verified'
    or v_ticket.solana_network <> 'devnet' or v_ticket.solana_program_id <> p_program_id
    or v_ticket.solana_ticket_account <> p_ticket_account or v_ticket.solana_event_account <> p_event_account
    or v_ticket.wallet_address <> p_from_wallet
    or (v_ticket.solana_transfer_count is not null and v_ticket.solana_transfer_count <> p_transfer_sequence) then
    raise exception 'Ticket holder or verified chain metadata changed before synchronization';
  end if;
  if p_from_wallet = p_to_wallet then raise exception 'Ticket recipient must differ from its current owner'; end if;
  if exists (select 1 from public.ticket_transfer_history where ticket_id = p_ticket_id and transfer_sequence = p_transfer_sequence) then
    raise exception 'Transfer sequence was already recorded';
  end if;
  insert into public.ticket_transfer_history(
    ticket_id, event_id, from_wallet, to_wallet, solana_network, transaction_signature,
    transfer_sequence, solana_receipt_account
  ) values (
    p_ticket_id, p_event_id, p_from_wallet, p_to_wallet, 'devnet', p_signature,
    p_transfer_sequence, p_receipt_account
  );
  update public.tickets set wallet_address = p_to_wallet, solana_transaction_signature = p_signature,
    holder_user_id = null, qr_token = gen_random_uuid(), solana_transfer_count = p_transfer_sequence + 1,
    solana_ticket_valid = true, solana_checked_in = false
  where id = p_ticket_id and event_id = p_event_id;
  return jsonb_build_object('recorded', true, 'idempotent', false);
end;
$$;
revoke all on function public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text,bigint,text)
  to service_role;

drop function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text);
create function public.record_verified_ticket_checkin(
  p_ticket_id uuid, p_event_id uuid, p_organizer_user_id uuid, p_organizer_wallet text,
  p_signature text, p_program_id text, p_ticket_account text, p_event_account text,
  p_owner_wallet text, p_transfer_count bigint, p_verified_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_existing public.ticket_checkin_history%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted check-in verifier required'; end if;
  if p_transfer_count is null or p_transfer_count < 0 or p_transfer_count > 4294967295
    or p_verified_at is null or p_owner_wallet is null then
    raise exception 'Verified check-in evidence is incomplete';
  end if;
  select * into v_existing from public.ticket_checkin_history where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.organizer_user_id = p_organizer_user_id
      and v_existing.organizer_wallet = p_organizer_wallet then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;
  select * into v_ticket from public.tickets where id = p_ticket_id and event_id = p_event_id for update;
  if not found then raise exception 'Ticket does not exist for this event'; end if;
  select * into v_existing from public.ticket_checkin_history where transaction_signature = p_signature;
  if found then
    if v_existing.ticket_id = p_ticket_id and v_existing.event_id = p_event_id
      and v_existing.organizer_user_id = p_organizer_user_id
      and v_existing.organizer_wallet = p_organizer_wallet then
      return jsonb_build_object('recorded', true, 'idempotent', true);
    end if;
    raise exception 'Transaction signature was already used for another check-in';
  end if;
  if not exists (select 1 from public.events e where e.id = p_event_id and e.organizer_id = p_organizer_user_id)
    or v_ticket.status <> 'issued' or v_ticket.blockchain_status <> 'verified'
    or v_ticket.solana_network <> 'devnet' or v_ticket.solana_program_id <> p_program_id
    or v_ticket.solana_ticket_account <> p_ticket_account or v_ticket.solana_event_account <> p_event_account
    or v_ticket.holder_user_id is null or v_ticket.wallet_address is distinct from p_owner_wallet
    or p_transfer_count < 0 or p_transfer_count > 4294967295 then
    raise exception 'Ticket holder, wallet owner or organiser metadata changed before check-in synchronization';
  end if;
  if exists (select 1 from public.ticket_checkin_history where ticket_id = p_ticket_id) then
    raise exception 'Ticket already has a verified on-chain check-in';
  end if;
  insert into public.ticket_checkin_history(
    ticket_id, event_id, organizer_user_id, organizer_wallet, transaction_signature, verified_at
  ) values (
    p_ticket_id, p_event_id, p_organizer_user_id, p_organizer_wallet, p_signature, p_verified_at
  );
  update public.tickets set status = 'checked_in', checked_in_at = p_verified_at,
    checked_in_by = p_organizer_user_id, solana_ticket_valid = true,
    solana_checked_in = true, solana_transfer_count = p_transfer_count,
    solana_transaction_signature = p_signature
  where id = p_ticket_id;
  return jsonb_build_object('recorded', true, 'idempotent', false);
end;
$$;
revoke all on function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz)
  to service_role;
