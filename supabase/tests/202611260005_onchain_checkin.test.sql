begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(11);

select ok(exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='ticket_checkin_history' and c.relrowsecurity
), 'verified check-in history has RLS enabled');
select ok(not has_table_privilege('authenticated','public.ticket_checkin_history','INSERT'),
  'authenticated clients cannot insert check-in history');
select ok(not has_table_privilege('authenticated','public.ticket_checkin_history','UPDATE'),
  'authenticated clients cannot update check-in history');
select ok(not has_function_privilege('authenticated',
  'public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz)','EXECUTE'),
  'authenticated clients cannot call the trusted check-in synchronizer');
select ok(has_function_privilege('service_role',
  'public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text,text,bigint,timestamptz)','EXECUTE'),
  'the service role can call the trusted check-in synchronizer');
select ok(exists (
  select 1 from pg_policies where schemaname='public' and tablename='ticket_checkin_history'
    and policyname='Organisers and current holders read verified check-ins'
), 'check-in history reads are limited by organiser or current-holder policies');
select ok(position('requires_on_chain' in pg_get_functiondef('public.check_in_ticket(uuid,text)'::regprocedure)) > 0,
  'legacy RPC refuses to mark a registered Solana ticket checked in');
select ok(not has_column_privilege('authenticated','public.tickets','status','UPDATE'),
  'authenticated clients cannot directly change ticket status');
select ok(not has_column_privilege('authenticated','public.tickets','checked_in_at','UPDATE'),
  'authenticated clients cannot directly change check-in timestamps');
select ok(not has_column_privilege('authenticated','public.tickets','checked_in_by','UPDATE'),
  'authenticated clients cannot directly change the check-in organiser');

select lives_ok($test$
do $$
declare
  v_user uuid := gen_random_uuid();
  v_event uuid;
  v_type uuid;
  v_booking uuid;
  v_item uuid;
  v_ticket uuid;
  v_signature text := 'test-check-in-' || gen_random_uuid()::text;
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_user,'authenticated','authenticated',v_user::text || '@nodara.test','',now(),'{}','{}',now(),now());
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(v_user,'Check-in test','check-in-test-' || replace(gen_random_uuid()::text,'-',''),
    'Check-in synchronization fixture','Testing','Test City','Test Country',now()+interval '2 days','published')
  returning id into v_event;
  select id into v_type from public.ticket_types where event_id=v_event limit 1;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,booking_reference)
  values(v_event,v_user,1,0,'USD','confirmed','not_required','NOD-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)))
  returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_type,1,0,'USD') returning id into v_item;
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id,solana_network,
    solana_program_id,solana_ticket_account,solana_event_account,wallet_address,blockchain_status,blockchain_verified_at)
  values(v_booking,v_item,v_event,v_type,v_user,'devnet','program-id','ticket-pda-' || gen_random_uuid()::text,
    'event-pda-' || gen_random_uuid()::text,'current-owner','verified',now()) returning id into v_ticket;

  begin
    perform public.record_verified_ticket_checkin(v_ticket,v_event,v_user,'organizer-wallet',
      'test-signature-' || gen_random_uuid()::text,'program-id',
      (select solana_ticket_account from public.tickets where id=v_ticket),
      (select solana_event_account from public.tickets where id=v_ticket),'stale-owner',0,now());
    raise exception 'Expected stale on-chain owner to be rejected';
  exception when others then
    if sqlerrm not like 'Ticket holder, wallet owner or organiser metadata changed before check-in synchronization%' then
      raise;
    end if;
  end;
  if (select status from public.tickets where id=v_ticket) <> 'issued'
    or exists(select 1 from public.ticket_checkin_history where ticket_id=v_ticket) then
    raise exception 'stale owner check-in changed attendance state';
  end if;

  v_result := public.record_verified_ticket_checkin(v_ticket,v_event,v_user,'organizer-wallet',
    v_signature,'program-id',(select solana_ticket_account from public.tickets where id=v_ticket),
    (select solana_event_account from public.tickets where id=v_ticket),'current-owner',0,now());
  if v_result->>'recorded' is distinct from 'true'
    or (select status from public.tickets where id=v_ticket) is distinct from 'checked_in'
    or (select count(*) from public.ticket_checkin_history where transaction_signature=v_signature) <> 1 then
    raise exception 'verified check-in did not update attendance exactly once';
  end if;
  v_result := public.record_verified_ticket_checkin(v_ticket,v_event,v_user,'organizer-wallet',
    v_signature,'program-id',(select solana_ticket_account from public.tickets where id=v_ticket),
    (select solana_event_account from public.tickets where id=v_ticket),'current-owner',0,now());
  if v_result->>'idempotent' is distinct from 'true' then raise exception 'duplicate check-in was not idempotent'; end if;
end
$$;
$test$, 'database synchronizer rejects stale owners and records a check-in once');

select * from finish();
rollback;
