begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(12);

select ok((select relrowsecurity from pg_class where oid='public.solana_reconciliation_runs'::regclass),
  'reconciliation runs have RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.solana_reconciliation_audit'::regclass),
  'reconciliation audit has RLS enabled');
select ok(not has_table_privilege('authenticated','public.solana_reconciliation_audit','SELECT'),
  'authenticated clients cannot read internal reconciliation audit');
select ok(not has_table_privilege('authenticated','public.solana_reconciliation_audit','INSERT'),
  'authenticated clients cannot insert audit rows');
select ok(not has_table_privilege('authenticated','public.solana_reconciliation_audit','UPDATE'),
  'authenticated clients cannot edit audit rows');
select ok(exists (
  select 1 from information_schema.columns where table_schema='public' and table_name='tickets'
    and column_name='solana_transfer_count'
), 'ticket records store verified chain transfer counts separately');
select ok(exists (
  select 1 from information_schema.columns where table_schema='public' and table_name='ticket_transfer_history'
    and column_name='solana_receipt_account'
), 'transfer history stores derived receipt evidence');
select ok(has_function_privilege('service_role',
  'public.start_solana_reconciliation_run(uuid,uuid,uuid,text,text,integer,uuid,uuid)','EXECUTE'),
  'only the trusted service can start reconciliation runs');
select ok(not has_function_privilege('authenticated',
  'public.start_solana_reconciliation_run(uuid,uuid,uuid,text,text,integer,uuid,uuid)','EXECUTE'),
  'authenticated clients cannot start reconciliation runs directly');
select ok(has_function_privilege('service_role',
  'public.apply_solana_ticket_reconciliation(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)','EXECUTE'),
  'the trusted service can invoke atomic repair');
select ok(not has_function_privilege('authenticated',
  'public.apply_solana_ticket_reconciliation(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)','EXECUTE'),
  'authenticated clients cannot invoke database repair');

select lives_ok($test$
do $fixture$
declare
  v_actor uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_event uuid;
  v_type uuid;
  v_booking uuid;
  v_item uuid;
  v_ticket uuid;
  v_failed_ticket uuid;
  v_scan uuid := gen_random_uuid();
  v_repair uuid := gen_random_uuid();
  v_signature text := 'reconciliation-test-' || gen_random_uuid()::text;
  v_transfer_signature text := 'reconciliation-transfer-' || gen_random_uuid()::text;
  v_old_qr uuid;
  v_result jsonb;
  v_previous jsonb;
  v_chain jsonb;
  v_failed_previous jsonb;
  v_failed_chain jsonb;
  v_error text;
  i integer;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values
    (v_actor,'authenticated','authenticated',v_actor::text || '@nodara.test','',now(),'{}','{}',now(),now()),
    (v_other,'authenticated','authenticated',v_other::text || '@nodara.test','',now(),'{}','{}',now(),now());

  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(v_actor,'Reconciliation test','reconciliation-test-' || replace(gen_random_uuid()::text,'-',''),
    'Reconciliation fixture','Testing','Test City','Test Country',now()+interval '2 days','published')
  returning id into v_event;
  begin
    perform public.start_solana_reconciliation_run(gen_random_uuid(),v_event,v_other,'scan','event',10,null,null);
    raise exception 'expected event access check to reject another organiser';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error not like 'Event not found or access denied%' then raise; end if;
  end;
  select id into v_type from public.ticket_types where event_id=v_event limit 1;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,booking_reference)
  values(v_event,v_actor,2,0,'USD','confirmed','not_required','NOD-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)))
  returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_type,2,0,'USD') returning id into v_item;
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id,status,
    solana_network,solana_program_id,solana_ticket_account,solana_event_account,
    solana_registration_signature,wallet_address,blockchain_status,blockchain_verified_at,
    solana_ticket_valid,solana_checked_in,solana_transfer_count)
  values(v_booking,v_item,v_event,v_type,v_actor,'issued','devnet',
    'CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf','ticket-pda-1','event-pda-1',
    'registration-signature','old-wallet','verified',now(),true,false,1)
  returning id,qr_token into v_ticket,v_old_qr;
  insert into public.ticket_transfer_history(
    ticket_id,event_id,from_wallet,to_wallet,transaction_signature,transfer_sequence,solana_receipt_account
  ) values (v_ticket,v_event,'old-wallet','new-wallet',v_transfer_signature,0,'receipt-pda-1');
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id,status,
    solana_network,solana_program_id,solana_ticket_account,solana_event_account,
    solana_registration_signature,wallet_address,blockchain_status,blockchain_verified_at,
    solana_ticket_valid,solana_checked_in,solana_transfer_count)
  values(v_booking,v_item,v_event,v_type,v_actor,'issued','devnet',
    'CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf','ticket-pda-2','event-pda-1',
    'registration-signature','old-wallet','verified',now(),true,false,0)
  returning id into v_failed_ticket;

  perform public.start_solana_reconciliation_run(v_scan,v_event,v_actor,'scan','event',10,null,null);
  select jsonb_build_object(
    'status',status,'blockchainStatus',blockchain_status,'network',solana_network,
    'programId',solana_program_id,'ticketAccount',solana_ticket_account,'eventAccount',solana_event_account,
    'registrationSignature',solana_registration_signature,'walletAddress',wallet_address,
    'ticketValid',solana_ticket_valid,'checkedIn',solana_checked_in,'transferCount',solana_transfer_count,
    'checkedInAt',checked_in_at,'checkedInBy',checked_in_by,'checkInSignature',null,
    'transferHistory',jsonb_build_array(jsonb_build_object(
      'sequence',0,'receiptAccount','receipt-pda-1','fromWallet','old-wallet',
      'toWallet','new-wallet','signature',v_transfer_signature
    ))
  ) into v_previous from public.tickets where id=v_ticket;
  v_chain := jsonb_build_object(
    'network','devnet','programId','CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf',
    'eventAccount','event-pda-1','ticketAccount','ticket-pda-1','eventId',v_event,'ticketId',v_ticket,
    'organizer','organizer-wallet','issuer','organizer-wallet','initialOwner','old-wallet','owner','new-wallet',
    'valid',true,'checkedIn',false,'transferCount',1,
    'transferHistory',jsonb_build_array(jsonb_build_object(
      'sequence',0,'receiptAccount','receipt-pda-1','fromWallet','old-wallet',
      'toWallet','new-wallet','signature',v_transfer_signature
    )),
    'registrationSignature','registration-signature','checkInSignature',null,'checkInBlockTime',null,
    'checkInOrganizerWallet',null,'lastTransferSignature',v_transfer_signature,'finalizedSlot',100
  );
  insert into public.solana_reconciliation_audit(
    run_id,event_id,ticket_id,classification,database_state,verified_chain_state,
    auto_repair_safe,reason,initiated_by
  ) values (v_scan,v_event,v_ticket,'OWNER_MISMATCH',v_previous,v_chain,true,'Verified chain owner differs.',v_actor);

  select jsonb_build_object(
    'status',status,'blockchainStatus',blockchain_status,'network',solana_network,
    'programId',solana_program_id,'ticketAccount',solana_ticket_account,'eventAccount',solana_event_account,
    'registrationSignature',solana_registration_signature,'walletAddress',wallet_address,
    'ticketValid',solana_ticket_valid,'checkedIn',solana_checked_in,'transferCount',solana_transfer_count,
    'checkedInAt',checked_in_at,'checkedInBy',checked_in_by,'checkInSignature',null,'transferHistory','[]'::jsonb
  ) into v_failed_previous from public.tickets where id=v_failed_ticket;
  v_failed_chain := jsonb_build_object(
    'network','devnet','programId','CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf',
    'eventAccount','event-pda-1','ticketAccount','ticket-pda-2','eventId',v_event,'ticketId',v_failed_ticket,
    'organizer','organizer-wallet','issuer','organizer-wallet','initialOwner','old-wallet','owner','wrong-chain-owner',
    'valid',true,'checkedIn',false,'transferCount',1,
    'transferHistory',jsonb_build_array(jsonb_build_object(
      'sequence',0,'receiptAccount','receipt-pda','fromWallet','old-wallet',
      'toWallet','intermediate-wallet','signature',v_signature
    )),
    'registrationSignature','registration-signature','checkInSignature',null,'checkInBlockTime',null,
    'checkInOrganizerWallet',null,'lastTransferSignature',v_signature,'finalizedSlot',100
  );
  insert into public.solana_reconciliation_audit(
    run_id,event_id,ticket_id,classification,database_state,verified_chain_state,
    auto_repair_safe,reason,initiated_by
  ) values (v_scan,v_event,v_failed_ticket,'TRANSFER_HISTORY_MISMATCH',v_failed_previous,v_failed_chain,true,'Transfer history needs repair.',v_actor);
  perform public.finish_solana_reconciliation_run(v_scan,v_actor,'completed',2,0,2,0,0,0);
  perform public.start_solana_reconciliation_run(v_repair,v_event,v_actor,'repair','ticket',2,null,v_scan);

  v_result := public.apply_solana_ticket_reconciliation(
    v_repair,v_scan,v_ticket,v_actor,'OWNER_MISMATCH',v_previous,v_chain,'Verified chain owner differs.'
  );
  if v_result->>'repaired' is distinct from 'true'
    or (select wallet_address from public.tickets where id=v_ticket) <> 'new-wallet'
    or (select holder_user_id from public.tickets where id=v_ticket) is not null
    or (select qr_token from public.tickets where id=v_ticket) = v_old_qr then
    raise exception 'verified owner repair did not update only the expected ticket fields';
  end if;
  v_result := public.apply_solana_ticket_reconciliation(
    v_repair,v_scan,v_ticket,v_actor,'OWNER_MISMATCH',v_previous,v_chain,'Verified chain owner differs.'
  );
  if v_result->>'idempotent' is distinct from 'true'
    or (select count(*) from public.solana_reconciliation_audit where run_id=v_repair and ticket_id=v_ticket) <> 1 then
    raise exception 'repeated repair was not idempotent';
  end if;

  begin
    perform public.apply_solana_ticket_reconciliation(
      v_repair,v_scan,v_failed_ticket,v_actor,'TRANSFER_HISTORY_MISMATCH',
      v_failed_previous,v_failed_chain,'Transfer history needs repair.'
    );
    raise exception 'expected inconsistent transfer chain to fail';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error not like 'Verified transfer history does not lead to the current chain owner%' then raise; end if;
  end;
  if (select count(*) from public.ticket_transfer_history where ticket_id=v_failed_ticket) <> 0
    or (select wallet_address from public.tickets where id=v_failed_ticket) <> 'old-wallet'
    or exists(select 1 from public.solana_reconciliation_audit where run_id=v_repair and ticket_id=v_failed_ticket) then
    raise exception 'interrupted repair left partial database changes';
  end if;
  perform public.finish_solana_reconciliation_run(v_repair,v_actor,'completed',2,0,2,1,0,1);

  for i in 1..10 loop
    perform public.start_solana_reconciliation_run(gen_random_uuid(),v_event,v_actor,'scan','event',10,null,null);
  end loop;
  begin
    perform public.start_solana_reconciliation_run(gen_random_uuid(),v_event,v_actor,'scan','event',10,null,null);
    raise exception 'expected rate limit to reject the thirteenth run';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error not like 'Reconciliation request rate limit exceeded%' then raise; end if;
  end;
end
$fixture$;
$test$, 'repairs are evidence-bound, atomic, idempotent, event-scoped, and rate-limited');

select * from finish();
rollback;
