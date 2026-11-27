-- Additive social foundation. Existing profile rows remain private until users
-- explicitly enable discoverability; city/country and interests are separately opt-in.
alter table public.profiles
  add column is_discoverable boolean not null default false,
  add column show_location boolean not null default false,
  add column show_interests boolean not null default false,
  add column show_hosted_events boolean not null default false;

alter table public.profiles
  add constraint profiles_discoverable_username_required
    check (not is_discoverable or username is not null);

create table public.user_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followed_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_follows_pk primary key (follower_id, followed_id),
  constraint user_follows_no_self check (follower_id <> followed_id)
);
create index user_follows_followed_created_idx on public.user_follows(followed_id, created_at desc);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_blocks_pk primary key (blocker_id, blocked_id),
  constraint user_blocks_no_self check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on public.user_blocks(blocked_id, blocker_id);

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index social_posts_author_created_idx on public.social_posts(author_id, created_at desc) where deleted_at is null;
create index social_posts_feed_idx on public.social_posts(created_at desc, id desc) where deleted_at is null;
create index social_posts_event_idx on public.social_posts(event_id, created_at desc) where deleted_at is null;

create table public.social_reactions (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint social_reactions_pk primary key(post_id,user_id)
);
create index social_reactions_user_idx on public.social_reactions(user_id, created_at desc);

create table public.social_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index social_comments_post_created_idx on public.social_comments(post_id, created_at asc) where deleted_at is null;
create index social_comments_author_idx on public.social_comments(author_id, created_at desc) where deleted_at is null;

create table public.community_posts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  is_announcement boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
create index community_posts_feed_idx on public.community_posts(community_id, created_at desc, id desc) where removed_at is null;

create table public.social_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('follow','reaction','comment','community_announcement','moderation')),
  post_id uuid references public.social_posts(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  comment_id uuid references public.social_comments(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 240),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint social_notifications_not_self check (actor_id is null or actor_id <> recipient_id)
);
create index social_notifications_recipient_idx on public.social_notifications(recipient_id, created_at desc, id desc);
create index social_notifications_unread_idx on public.social_notifications(recipient_id, created_at desc) where read_at is null;

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('profile','post','comment','community')),
  target_id uuid not null,
  category text not null check (category in ('harassment','spam','inappropriate','impersonation','safety','other')),
  description text check (description is null or char_length(description) <= 1000),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now(),
  constraint content_reports_dedupe unique(reporter_id,target_type,target_id,status)
);
create index content_reports_queue_idx on public.content_reports(status, created_at desc);

create table public.community_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  moderator_id uuid not null references public.profiles(id) on delete restrict,
  post_id uuid references public.community_posts(id) on delete set null,
  action text not null check (action in ('remove_post','restore_post')),
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
create index community_moderation_history_idx on public.community_moderation_actions(community_id, created_at desc);

revoke all on table public.user_follows, public.user_blocks, public.social_posts, public.social_reactions,
  public.social_comments, public.community_posts, public.social_notifications,
  public.content_reports, public.community_moderation_actions from public,anon,authenticated;

alter table public.profiles enable row level security;
alter table public.user_follows enable row level security;
alter table public.user_blocks enable row level security;
alter table public.social_posts enable row level security;
alter table public.social_reactions enable row level security;
alter table public.social_comments enable row level security;
alter table public.community_posts enable row level security;
alter table public.social_notifications enable row level security;
alter table public.content_reports enable row level security;
alter table public.community_moderation_actions enable row level security;

grant update (is_discoverable, show_location, show_interests, show_hosted_events) on public.profiles to authenticated;
grant select, delete on public.user_follows to authenticated;
grant insert (follower_id,followed_id) on public.user_follows to authenticated;
grant select, delete on public.user_blocks to authenticated;
grant insert (blocker_id,blocked_id) on public.user_blocks to authenticated;
grant select, delete on public.social_posts to authenticated;
grant insert (author_id,body,event_id) on public.social_posts to authenticated;
grant insert (post_id,user_id), delete on public.social_reactions to authenticated;
grant insert (post_id,author_id,body), delete on public.social_comments to authenticated;
grant insert (community_id,author_id,body,is_announcement), delete on public.community_posts to authenticated;
grant select on public.social_notifications to authenticated;
grant select on public.content_reports to authenticated;
grant insert (reporter_id,target_type,target_id,category,description) on public.content_reports to authenticated;
grant select on public.community_moderation_actions to authenticated;
grant all on public.user_follows, public.user_blocks, public.social_posts, public.social_reactions,
  public.social_comments, public.community_posts, public.social_notifications,
  public.content_reports, public.community_moderation_actions to service_role;

create function public.can_view_social_author(p_author_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_author_id and p.is_discoverable
      and ((select auth.uid()) is null or not exists (
        select 1 from public.user_blocks b
        where (b.blocker_id = (select auth.uid()) and b.blocked_id = p_author_id)
           or (b.blocker_id = p_author_id and b.blocked_id = (select auth.uid()))
      ))
  );
$$;
revoke all on function public.can_view_social_author(uuid) from public;
grant execute on function public.can_view_social_author(uuid) to anon, authenticated, service_role;

create function public.get_public_profiles(p_query text default '', p_limit integer default 20, p_offset integer default 0)
returns table (
  id uuid, username text, display_name text, avatar_url text, bio text, location text,
  interest_categories text[], follower_count bigint, following_count bigint, followed_by_viewer boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare v_query text := pg_catalog.left(pg_catalog.btrim(pg_catalog.coalesce(p_query,'')), 80);
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 or p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'Invalid profile pagination';
  end if;
  if v_query = '' then return; end if;
  return query
  select p.id, p.username, p.full_name, p.avatar_url, p.bio,
    case when p.show_location then p.location else null end,
    case when p.show_interests then p.interest_categories else '{}'::text[] end,
    (select pg_catalog.count(*) from public.user_follows f where f.followed_id=p.id),
    (select pg_catalog.count(*) from public.user_follows f where f.follower_id=p.id),
    exists(select 1 from public.user_follows f where f.follower_id=(select auth.uid()) and f.followed_id=p.id)
  from public.profiles p
  where p.is_discoverable and (v_query = '' or p.username ilike '%'||v_query||'%' or p.full_name ilike '%'||v_query||'%')
    and public.can_view_social_author(p.id)
  order by p.full_name nulls last, p.username
  limit p_limit offset p_offset;
end;
$$;
revoke all on function public.get_public_profiles(text,integer,integer) from public;
grant execute on function public.get_public_profiles(text,integer,integer) to anon, authenticated, service_role;

create function public.get_public_profile(p_username text)
returns table (
  id uuid, username text, display_name text, avatar_url text, bio text, location text,
  interest_categories text[], follower_count bigint, following_count bigint,
  followed_by_viewer boolean, communities jsonb, upcoming_events jsonb
)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.full_name, p.avatar_url, p.bio,
    case when p.show_location then p.location else null end,
    case when p.show_interests then p.interest_categories else '{}'::text[] end,
    (select pg_catalog.count(*) from public.user_follows f where f.followed_id=p.id),
    (select pg_catalog.count(*) from public.user_follows f where f.follower_id=p.id),
    exists(select 1 from public.user_follows f where f.follower_id=(select auth.uid()) and f.followed_id=p.id),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',c.id,'name',c.name,'slug',c.slug,'category',c.category,'cover_image',c.cover_image
    ) order by c.name),'[]'::jsonb)
      from public.community_members cm join public.communities c on c.id=cm.community_id where cm.user_id=p.id),
    case when p.show_hosted_events then (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',e.id,'title',e.title,'slug',e.slug,'start_date',e.start_date,'location',e.location,'country',e.country,'cover_image',e.cover_image
    ) order by e.start_date),'[]'::jsonb) from public.events e where e.organizer_id=p.id and e.status='published' and e.start_date>pg_catalog.now()) else '[]'::jsonb end
  from public.profiles p
  where p.username=pg_catalog.lower(pg_catalog.btrim(p_username)) and p.is_discoverable
    and public.can_view_social_author(p.id);
$$;
revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated, service_role;

create function public.get_public_follow_list(p_username text,p_direction text default 'followers',p_limit integer default 30,p_offset integer default 0)
returns table(id uuid,username text,display_name text,avatar_url text)
language plpgsql stable security definer set search_path = '' as $$
declare v_target uuid;
begin
  if p_direction not in ('followers','following') or p_limit is null or p_limit<1 or p_limit>50 or p_offset is null or p_offset<0 then
    raise exception 'Invalid follow list request';
  end if;
  select p.id into v_target from public.profiles p
    where p.username=pg_catalog.lower(pg_catalog.btrim(p_username)) and p.is_discoverable;
  if v_target is null or not public.can_view_social_author(v_target) then return; end if;
  return query
    select p.id,p.username,p.full_name,p.avatar_url
    from public.user_follows f join public.profiles p on p.id=case when p_direction='followers' then f.follower_id else f.followed_id end
    where (p_direction='followers' and f.followed_id=v_target or p_direction='following' and f.follower_id=v_target)
      and public.can_view_social_author(p.id)
    order by p.full_name nulls last,p.username limit p_limit offset p_offset;
end;
$$;
revoke all on function public.get_public_follow_list(text,text,integer,integer) from public;
grant execute on function public.get_public_follow_list(text,text,integer,integer) to anon,authenticated,service_role;

create policy "Users manage own follows" on public.user_follows for select to authenticated
  using (follower_id=(select auth.uid()) or followed_id=(select auth.uid()));
create policy "Follow discoverable profiles unless blocked" on public.user_follows for insert to authenticated
  with check (follower_id=(select auth.uid()) and public.can_view_social_author(followed_id));
create policy "Users unfollow themselves" on public.user_follows for delete to authenticated
  using (follower_id=(select auth.uid()));

create policy "Users manage their own blocks" on public.user_blocks for select to authenticated
  using (blocker_id=(select auth.uid()));
create policy "Users block others" on public.user_blocks for insert to authenticated
  with check (blocker_id=(select auth.uid()));
create policy "Users unblock others" on public.user_blocks for delete to authenticated
  using (blocker_id=(select auth.uid()));

create policy "Discoverable public posts are readable" on public.social_posts for select to anon, authenticated
  using (deleted_at is null and public.can_view_social_author(author_id));
create policy "Users write their own public posts" on public.social_posts for insert to authenticated
  with check (author_id=(select auth.uid()) and public.can_view_social_author(author_id)
    and (event_id is null or exists(select 1 from public.events e where e.id=event_id and e.status='published')));
create policy "Authors edit their own posts" on public.social_posts for update to authenticated
  using (author_id=(select auth.uid()) and deleted_at is null)
  with check (author_id=(select auth.uid()) and deleted_at is null and char_length(btrim(body)) between 1 and 2000);
create policy "Authors remove their own posts" on public.social_posts for delete to authenticated
  using (author_id=(select auth.uid()));

create policy "Visible posts expose reactions for aggregate reads" on public.social_reactions for select to authenticated
  using (exists(select 1 from public.social_posts p where p.id=post_id and p.deleted_at is null and public.can_view_social_author(p.author_id)));
create policy "Users react as themselves" on public.social_reactions for insert to authenticated
  with check (user_id=(select auth.uid()) and exists(
    select 1 from public.social_posts p where p.id=post_id and p.deleted_at is null and public.can_view_social_author(p.author_id)
  ));
create policy "Users remove their own reactions" on public.social_reactions for delete to authenticated
  using (user_id=(select auth.uid()));

create policy "Visible post comments are readable" on public.social_comments for select to anon, authenticated
  using (deleted_at is null and exists(select 1 from public.social_posts p where p.id=post_id and p.deleted_at is null and public.can_view_social_author(p.author_id))
    and public.can_view_social_author(author_id));
create policy "Users comment on visible posts" on public.social_comments for insert to authenticated
  with check (author_id=(select auth.uid()) and public.can_view_social_author(author_id) and exists(
    select 1 from public.social_posts p where p.id=post_id and p.deleted_at is null and public.can_view_social_author(p.author_id)
  ));
create policy "Authors edit their own comments" on public.social_comments for update to authenticated
  using (author_id=(select auth.uid()) and deleted_at is null)
  with check (author_id=(select auth.uid()) and deleted_at is null and char_length(btrim(body)) between 1 and 1000);
create policy "Authors remove their own comments" on public.social_comments for delete to authenticated
  using (author_id=(select auth.uid()));

create policy "Community posts are publicly readable unless removed or blocked" on public.community_posts for select to anon, authenticated
  using (removed_at is null and public.can_view_social_author(author_id));
create policy "Members publish community posts" on public.community_posts for insert to authenticated
  with check (author_id=(select auth.uid()) and exists(
    select 1 from public.community_members cm where cm.community_id=public.community_posts.community_id and cm.user_id=(select auth.uid())
      and (not is_announcement or cm.role in ('owner','moderator'))
  ));
create policy "Authors edit ordinary community posts" on public.community_posts for update to authenticated
  using (author_id=(select auth.uid()) and not is_announcement and removed_at is null)
  with check (author_id=(select auth.uid()) and not is_announcement and removed_at is null);
create policy "Authors delete ordinary community posts" on public.community_posts for delete to authenticated
  using (author_id=(select auth.uid()) and not is_announcement);

create policy "Users read own notifications" on public.social_notifications for select to authenticated
  using (recipient_id=(select auth.uid()));
create policy "Users mark own notifications read" on public.social_notifications for update to authenticated
  using (recipient_id=(select auth.uid())) with check (recipient_id=(select auth.uid()));

create policy "Users submit and read own private reports" on public.content_reports for select to authenticated
  using (reporter_id=(select auth.uid()));
create policy "Users report content privately" on public.content_reports for insert to authenticated
  with check (reporter_id=(select auth.uid()));

create policy "Community moderators read their audit history" on public.community_moderation_actions for select to authenticated
  using (exists(select 1 from public.community_members cm where cm.community_id=public.community_moderation_actions.community_id and cm.user_id=(select auth.uid()) and cm.role in ('owner','moderator')));

create function public.create_social_moderation_action(p_post_id uuid,p_action text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_post public.community_posts%rowtype; v_user uuid := (select auth.uid());
begin
  if v_user is null or p_action not in ('remove_post','restore_post') then raise exception 'Invalid moderation request'; end if;
  select * into v_post from public.community_posts where id=p_post_id for update;
  if not found or not exists(select 1 from public.community_members cm where cm.community_id=v_post.community_id and cm.user_id=v_user and cm.role in ('owner','moderator')) then
    raise exception 'Moderator permission required';
  end if;
  if p_action='remove_post' then update public.community_posts set removed_at=pg_catalog.now(),updated_at=pg_catalog.now() where id=p_post_id;
  else update public.community_posts set removed_at=null,updated_at=pg_catalog.now() where id=p_post_id; end if;
  insert into public.community_moderation_actions(community_id,moderator_id,post_id,action,reason)
    values(v_post.community_id,v_user,p_post_id,p_action,pg_catalog.left(p_reason,500));
  if v_post.author_id<>v_user then
    insert into public.social_notifications(recipient_id,actor_id,kind,community_id,message,dedupe_key)
      values(v_post.author_id,v_user,'moderation',v_post.community_id,'A moderator took action on your community post.',
        'moderation:'||p_post_id::text||':'||p_action||':'||pg_catalog.gen_random_uuid()::text);
  end if;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.create_social_moderation_action(uuid,text,text) from public,anon;
grant execute on function public.create_social_moderation_action(uuid,text,text) to authenticated,service_role;

create function public.notify_social_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_recipient uuid; v_actor uuid; v_message text; v_kind text; v_post_id uuid; v_community_id uuid; v_comment_id uuid; v_dedupe text;
begin
  if tg_table_name='user_follows' then
    v_recipient:=new.followed_id; v_actor:=new.follower_id; v_kind:='follow'; v_message:='Someone followed your profile.';
    v_dedupe:='follow:'||new.follower_id::text||':'||new.followed_id::text;
  elsif tg_table_name='social_reactions' then
    select p.author_id into v_recipient from public.social_posts p where p.id=new.post_id;
    v_actor:=new.user_id;
    v_kind:='reaction'; v_message:='Someone liked your post.'; v_post_id:=new.post_id;
    v_dedupe:='reaction:'||new.post_id::text||':'||new.user_id::text;
  elsif tg_table_name='social_comments' then
    select p.author_id into v_recipient from public.social_posts p where p.id=new.post_id;
    v_actor:=new.author_id;
    v_kind:='comment'; v_message:='Someone commented on your post.'; v_post_id:=new.post_id; v_comment_id:=new.id;
    v_dedupe:='comment:'||new.id::text;
  elsif tg_table_name='community_posts' and new.is_announcement then
    insert into public.social_notifications(recipient_id,actor_id,kind,community_id,message,dedupe_key)
    select cm.user_id,new.author_id,'community_announcement',new.community_id,'A community you joined posted an announcement.',
      'announcement:'||new.id::text||':'||cm.user_id::text
    from public.community_members cm where cm.community_id=new.community_id and cm.user_id<>new.author_id
    on conflict(dedupe_key) do nothing;
    return new;
  else return new;
  end if;
  if v_recipient is not null and v_recipient<>v_actor then
    insert into public.social_notifications(recipient_id,actor_id,kind,post_id,community_id,comment_id,message,dedupe_key)
      values(v_recipient,v_actor,
        v_kind,v_post_id,v_community_id,v_comment_id,v_message,v_dedupe) on conflict(dedupe_key) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.notify_social_activity() from public,anon,authenticated;

create trigger social_follow_notification after insert on public.user_follows for each row execute function public.notify_social_activity();
create trigger social_reaction_notification after insert on public.social_reactions for each row execute function public.notify_social_activity();
create trigger social_comment_notification after insert on public.social_comments for each row execute function public.notify_social_activity();
create trigger community_announcement_notification after insert on public.community_posts for each row execute function public.notify_social_activity();

create function public.cleanup_blocked_follow_edges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.user_follows f where
    (f.follower_id=new.blocker_id and f.followed_id=new.blocked_id)
    or (f.follower_id=new.blocked_id and f.followed_id=new.blocker_id);
  delete from public.social_reactions r where r.user_id in (new.blocker_id,new.blocked_id)
    and exists(select 1 from public.social_posts p where p.id=r.post_id and p.author_id in (new.blocker_id,new.blocked_id) and p.author_id<>r.user_id);
  delete from public.social_comments c where c.author_id in (new.blocker_id,new.blocked_id)
    and exists(select 1 from public.social_posts p where p.id=c.post_id and p.author_id in (new.blocker_id,new.blocked_id) and p.author_id<>c.author_id);
  return new;
end;
$$;
revoke all on function public.cleanup_blocked_follow_edges() from public,anon,authenticated;
create trigger user_blocks_remove_follow_edges after insert on public.user_blocks
for each row execute function public.cleanup_blocked_follow_edges();

create function public.validate_content_report_target()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_exists boolean := false;
begin
  if new.target_type='profile' then select exists(select 1 from public.profiles p where p.id=new.target_id) into v_exists;
  elsif new.target_type='post' then select exists(select 1 from public.social_posts p where p.id=new.target_id and p.deleted_at is null) into v_exists;
  elsif new.target_type='comment' then select exists(select 1 from public.social_comments c where c.id=new.target_id and c.deleted_at is null) into v_exists;
  elsif new.target_type='community' then select exists(select 1 from public.communities c where c.id=new.target_id) into v_exists;
  end if;
  if not v_exists then raise exception 'Reported content does not exist'; end if;
  return new;
end;
$$;
revoke all on function public.validate_content_report_target() from public,anon,authenticated;
create trigger content_reports_validate_target before insert on public.content_reports
for each row execute function public.validate_content_report_target();

create trigger social_posts_updated_at before update on public.social_posts
for each row execute function public.set_updated_at();
create trigger social_comments_updated_at before update on public.social_comments
for each row execute function public.set_updated_at();
create trigger community_posts_updated_at before update on public.community_posts
for each row execute function public.set_updated_at();

create function public.get_social_feed(p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 20,p_author_id uuid default null)
returns table (
  id uuid, author_id uuid, username text, display_name text, avatar_url text, body text,
  event_id uuid, created_at timestamptz, updated_at timestamptz,
  reaction_count bigint, comment_count bigint, viewer_reacted boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid feed page size'; end if;
  return query
    select p.id,p.author_id,pr.username,pr.full_name,pr.avatar_url,p.body,p.event_id,p.created_at,p.updated_at,
      (select pg_catalog.count(*) from public.social_reactions r where r.post_id=p.id),
      (select pg_catalog.count(*) from public.social_comments c where c.post_id=p.id and c.deleted_at is null),
      exists(select 1 from public.social_reactions r where r.post_id=p.id and r.user_id=(select auth.uid()))
    from public.social_posts p join public.profiles pr on pr.id=p.author_id
    where p.deleted_at is null and public.can_view_social_author(p.author_id)
      and (p_author_id is null or p.author_id=p_author_id)
      and (p_before is null or (p.created_at,p.id)<(p_before,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by p.created_at desc,p.id desc limit p_limit;
end;
$$;
revoke all on function public.get_social_feed(timestamptz,uuid,integer,uuid) from public;
grant execute on function public.get_social_feed(timestamptz,uuid,integer,uuid) to anon,authenticated,service_role;

create function public.get_community_social_feed(p_community_id uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30)
returns table (
  id uuid, community_id uuid, author_id uuid, username text, display_name text, avatar_url text,
  body text, is_announcement boolean, created_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid community feed page size'; end if;
  return query select cp.id,cp.community_id,cp.author_id,
    case when pr.is_discoverable then pr.username else null end,
    case when pr.is_discoverable then pr.full_name else 'Community member' end,
    case when pr.is_discoverable then pr.avatar_url else null end,
    cp.body,cp.is_announcement,cp.created_at,cp.updated_at
  from public.community_posts cp join public.profiles pr on pr.id=cp.author_id
  where cp.community_id=p_community_id and cp.removed_at is null
    and public.can_view_social_author(cp.author_id)
    and (p_before is null or (cp.created_at,cp.id)<(p_before,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by cp.is_announcement desc,cp.created_at desc,cp.id desc limit p_limit;
end;
$$;
revoke all on function public.get_community_social_feed(uuid,timestamptz,uuid,integer) from public;
grant execute on function public.get_community_social_feed(uuid,timestamptz,uuid,integer) to anon,authenticated,service_role;

create function public.get_social_comments(p_post_id uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns table(id uuid,post_id uuid,author_id uuid,username text,display_name text,avatar_url text,body text,created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'Invalid comment page size'; end if;
  return query select c.id,c.post_id,c.author_id,pr.username,pr.full_name,pr.avatar_url,c.body,c.created_at
  from public.social_comments c join public.profiles pr on pr.id=c.author_id
  join public.social_posts p on p.id=c.post_id
  where c.post_id=p_post_id and c.deleted_at is null and p.deleted_at is null
    and public.can_view_social_author(p.author_id) and public.can_view_social_author(c.author_id)
    and (p_before is null or (c.created_at,c.id)<(p_before,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by c.created_at desc,c.id desc limit p_limit;
end;
$$;
revoke all on function public.get_social_comments(uuid,timestamptz,uuid,integer) from public;
grant execute on function public.get_social_comments(uuid,timestamptz,uuid,integer) to anon,authenticated,service_role;

grant update (body) on public.social_posts to authenticated;
grant update (body) on public.social_comments to authenticated;
grant update (body) on public.community_posts to authenticated;
grant update (read_at) on public.social_notifications to authenticated;
