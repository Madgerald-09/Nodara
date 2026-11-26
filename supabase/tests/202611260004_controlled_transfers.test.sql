begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(8);

select ok(exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='tickets' and column_name='holder_user_id'
), 'tickets store a separate current NODARA holder');

select ok(not has_table_privilege('authenticated','public.tickets','UPDATE'),
  'authenticated clients cannot write ticket ownership');
select ok(not has_function_privilege('authenticated',
  'public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text)','EXECUTE'),
  'authenticated clients cannot invoke transfer synchronization');
select ok(has_function_privilege('service_role',
  'public.record_verified_ticket_transfer(uuid,uuid,uuid,text,text,text,text,text,text)','EXECUTE'),
  'the trusted service role can invoke transfer synchronization');
select ok(exists (
  select 1 from pg_policies where schemaname='public' and tablename='tickets'
    and policyname='Current ticket holders and event organisers read ticket records'
    and qual ilike '%holder_user_id%'
), 'ticket reads are scoped to the current holder or event organiser');
select ok(exists (
  select 1 from pg_policies where schemaname='public' and tablename='ticket_transfer_history'
    and policyname='Current ticket holders and event organisers read transfer history'
    and qual ilike '%holder_user_id%'
), 'transfer history follows current ticket access');

select lives_ok($test$
do $fixture$
declare
  v_buyer uuid := gen_random_uuid();
  v_recipient uuid := gen_random_uuid();
  v_organizer uuid := gen_random_uuid();
  v_event uuid;
  v_type uuid;
  v_booking uuid;
  v_item uuid;
  v_ticket uuid;
  v_old_qr uuid;
  v_signature text := 'test-transfer-' || gen_random_uuid()::text;
  v_result jsonb;
begin
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values
    (v_buyer,'authenticated','authenticated',v_buyer::text || '@nodara.test','',now(),'{}','{}',now(),now()),
    (v_recipient,'authenticated','authenticated',v_recipient::text || '@nodara.test','',now(),'{}','{}',now(),now()),
    (v_organizer,'authenticated','authenticated',v_organizer::text || '@nodara.test','',now(),'{}','{}',now(),now());

  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(v_organizer,'Transfer test','transfer-test-' || replace(gen_random_uuid()::text,'-',''),
    'Transfer synchronization fixture','Testing','Test City','Test Country',now()+interval '2 days','published')
  returning id into v_event;
  select id into v_type from public.ticket_types where event_id=v_event limit 1;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,booking_reference)
  values(v_event,v_buyer,1,0,'USD','confirmed','not_required','NOD-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)))
  returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_type,1,0,'USD') returning id into v_item;
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id,solana_network,
    solana_program_id,solana_ticket_account,solana_event_account,wallet_address,blockchain_status,blockchain_verified_at)
  values(v_booking,v_item,v_event,v_type,v_buyer,'devnet','program-id','ticket-pda-' || gen_random_uuid()::text,
    'event-pda-' || gen_random_uuid()::text,'sender-wallet','verified',now()) returning id,qr_token into v_ticket,v_old_qr;

  v_result := public.record_verified_ticket_transfer(v_ticket,v_event,v_buyer,'sender-wallet','recipient-wallet',
    v_signature,'program-id',(select solana_ticket_account from public.tickets where id=v_ticket),
    (select solana_event_account from public.tickets where id=v_ticket));
  if v_result->>'recorded' is distinct from 'true' then raise exception 'verified transfer was not recorded'; end if;
  if (select holder_user_id from public.tickets where id=v_ticket) is not null then raise exception 'old holder access was not revoked'; end if;
  if (select wallet_address from public.tickets where id=v_ticket) is distinct from 'recipient-wallet' then raise exception 'wallet owner was not synchronized'; end if;
  if (select qr_token from public.tickets where id=v_ticket) = v_old_qr then raise exception 'old QR token was not rotated'; end if;
  if (select count(*) from public.ticket_transfer_history where transaction_signature=v_signature) <> 1 then raise exception 'transfer history was not recorded exactly once'; end if;

  v_result := public.record_verified_ticket_transfer(v_ticket,v_event,v_buyer,'sender-wallet','recipient-wallet',
    v_signature,'program-id',(select solana_ticket_account from public.tickets where id=v_ticket),
    (select solana_event_account from public.tickets where id=v_ticket));
  if v_result->>'idempotent' is distinct from 'true' then raise exception 'duplicate processing was not idempotent'; end if;
  if not public.claim_transferred_ticket(v_ticket,v_recipient,'recipient-wallet') then raise exception 'recipient claim failed'; end if;
  if (select holder_user_id from public.tickets where id=v_ticket) is distinct from v_recipient then raise exception 'recipient did not receive NODARA access'; end if;
end
$fixture$;
$test$, 'verified transfer updates holder, rotates QR, records history once, and supports recipient claim');

select ok(position('holder_user_id' in pg_get_functiondef('public.get_my_tickets()'::regprocedure)) > 0,
  'ticket listing returns rows by current holder');
select * from finish();
rollback;
