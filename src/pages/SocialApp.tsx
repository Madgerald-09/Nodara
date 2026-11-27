import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { FormEvent } from 'react'
import './Social.css'
import { supabase } from '../lib/supabase'
import { fetchCommunityBySlug, setCommunityMembership } from '../services/communityService'
import type { CommunityDetail } from '../services/communityService'
import {
  createCommunityPost, createContentReport, createSocialComment, createSocialPost, deleteSocialPost, deleteSocialComment,
  fetchCommunitySocialFeed, fetchSocialComments, fetchSocialFeed,
  fetchSocialNotifications, getPublicProfile, markNotificationRead, moderateCommunityPost,
  getPublicFollowList, searchPublicProfiles, setFollow, setPostReaction, setUserBlock, updateSocialProfile, editSocialPost, editSocialComment,
} from '../services/socialService'
import type { CommunityPost, PublicProfile, SocialComment, SocialNotification, SocialPost } from '../services/socialService'
import type { NavigateFunction } from './OrganiserApp'

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const displayName = (name: string | null | undefined, username?: string | null) => name?.trim() || (username ? `@${username}` : 'NODARA member')

function SocialHeader({ navigate, userId }: { navigate: NavigateFunction; userId: string | null }) {
  return <header className="social-header"><a className="social-brand" href="/" onClick={event => { event.preventDefault(); navigate('/') }}>NODARA <span>Discover. Connect. Experience.</span></a><nav aria-label="Social navigation"><button onClick={() => navigate('/feed')}>Feed</button><button onClick={() => navigate('/people')}>People</button>{userId && <><button onClick={() => navigate('/notifications')}>Notifications</button><button onClick={() => navigate('/profile/settings')}>Profile settings</button></>}</nav><button className="social-back" onClick={() => navigate('/')}>Discover experiences</button></header>
}

function ProfileImage({ url, name }: { url: string | null; name: string }) {
  return <span className="social-avatar">{url ? <img src={url} alt="" onError={event => { event.currentTarget.hidden = true }}/> : name.slice(0,1).toUpperCase()}</span>
}

function SocialPostCard({ post, userId, navigate, onRefresh }: { post: SocialPost; userId: string | null; navigate: NavigateFunction; onRefresh: () => void }) {
  const [comments, setComments] = useState<SocialComment[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reactionCount, setReactionCount] = useState(Number(post.reaction_count))
  const [reacted, setReacted] = useState(post.viewer_reacted)
  const [commentCount, setCommentCount] = useState(Number(post.comment_count))

  const toggleReaction = async () => {
    if (!userId) { setError('Sign in to like posts.'); return }
    setBusy(true); setError('')
    const result = await setPostReaction(post.id, reacted)
    if (result.error) setError(messageOf(result.error))
    else { setReacted(!reacted); setReactionCount(value => Math.max(0,value+(reacted?-1:1))) }
    setBusy(false)
  }
  const toggleComments = async () => {
    const next = !commentsOpen; setCommentsOpen(next)
    if (!next) return
    const result = await fetchSocialComments(post.id)
    if (result.error) setError(messageOf(result.error)); else setComments(result.comments)
  }
  const submitComment = async (event: FormEvent) => {
    event.preventDefault(); if (!commentBody.trim()) return
    setBusy(true); setError('')
    const result = await createSocialComment(post.id,commentBody)
    if (result.error) setError(messageOf(result.error))
    else { setCommentBody(''); setCommentCount(value => value+1); const refreshed=await fetchSocialComments(post.id); if (!refreshed.error) setComments(refreshed.comments) }
    setBusy(false)
  }
  const share = async () => {
    const url = new URL(`/feed?post=${post.id}`,window.location.origin).toString()
    try { if (navigator.share) await navigator.share({title:'NODARA post',url}); else { await navigator.clipboard.writeText(url); setError('Link copied.') } }
    catch { setError('Could not share this post.') }
  }
  const removePost = async () => {
    if (!window.confirm('Delete this post? This also removes its comments and reactions.')) return
    const result=await deleteSocialPost(post.id); if (result.error) setError(messageOf(result.error)); else onRefresh()
  }
  const updatePost = async () => {
    const nextBody = window.prompt('Edit your post', post.body)
    if (nextBody === null || nextBody === post.body) return
    const result = await editSocialPost(post.id, nextBody)
    if (result.error) setError(messageOf(result.error)); else onRefresh()
  }
  const editComment = async (comment: SocialComment) => {
    const nextBody = window.prompt('Edit your comment', comment.body)
    if (nextBody === null || nextBody === comment.body) return
    const result = await editSocialComment(comment.id, nextBody)
    if (result.error) setError(messageOf(result.error)); else {
      const refreshed = await fetchSocialComments(post.id)
      if (!refreshed.error) setComments(refreshed.comments)
    }
  }
  const removeComment = async (comment: SocialComment) => {
    if (!window.confirm('Delete your comment?')) return
    const result = await deleteSocialComment(comment.id)
    if (result.error) setError(messageOf(result.error)); else {
      setCommentCount(value => Math.max(0, value - 1))
      const refreshed = await fetchSocialComments(post.id)
      if (!refreshed.error) setComments(refreshed.comments)
    }
  }
  const report = async () => {
    const result=await createContentReport({type:'post',id:post.id,category:'other'})
    setError(result.error ? messageOf(result.error) : 'Report sent privately to the moderation team.')
  }
  return <article className="social-card" id={`post-${post.id}`}>
    <div className="social-post-author"><ProfileImage url={post.avatar_url} name={displayName(post.display_name,post.username)}/><div><button className="social-author-name" onClick={() => navigate(`/profile/${post.username}`)}>{displayName(post.display_name,post.username)}</button><small>{new Date(post.created_at).toLocaleString()}</small></div>{userId===post.author_id ? <><button className="social-text-button" onClick={() => void updatePost()}>Edit</button><button className="social-text-button" onClick={() => void removePost()}>Delete</button></> : <button className="social-text-button" onClick={() => void report()}>Report</button>}</div>
    <p className="social-post-body">{post.body}</p>
    {post.event_id && <button className="social-event-link" onClick={() => { navigate('/'); window.setTimeout(() => document.querySelector('#discover')?.scrollIntoView({behavior:'smooth'}),50) }}>Related event · Open discovery</button>}
    <div className="social-post-actions"><button aria-pressed={reacted} disabled={busy} onClick={() => void toggleReaction()}>{reacted ? '♥ Liked' : '♡ Like'} · {reactionCount}</button><button aria-expanded={commentsOpen} onClick={() => void toggleComments()}>Comments · {commentCount}</button><button onClick={() => void share()}>Share</button></div>
    {error && <p className="social-inline-note" role="status">{error}</p>}
    {commentsOpen && <div className="social-comments">{comments.map(comment=><div className="social-comment" key={comment.id}><ProfileImage url={comment.avatar_url} name={displayName(comment.display_name,comment.username)}/><p><strong>{displayName(comment.display_name,comment.username)}</strong> {comment.body}<small>{new Date(comment.created_at).toLocaleString()}</small></p>{userId===comment.author_id&&<span><button className="social-text-button" onClick={()=>void editComment(comment)}>Edit</button><button className="social-text-button" onClick={()=>void removeComment(comment)}>Delete</button></span>}</div>)}{!comments.length && <p className="social-muted">No comments yet.</p>}{userId && <form className="social-comment-form" onSubmit={event=>void submitComment(event)}><input value={commentBody} onChange={event=>setCommentBody(event.target.value)} maxLength={1000} placeholder="Write a thoughtful comment…" aria-label="Write a comment"/><button disabled={busy||!commentBody.trim()}>Comment</button></form>}{!userId && <p className="social-muted">Sign in to join the conversation.</p>}</div>}
  </article>
}

export function SocialApp({ pathname, navigate }: { pathname: string; navigate: NavigateFunction }) {
  const [userId,setUserId]=useState<string|null>(null)
  useEffect(()=>{if(!supabase)return; let active=true; supabase.auth.getUser().then(({data})=>{if(active)setUserId(data.user?.id??null)}); const {data}=supabase.auth.onAuthStateChange((_event,session)=>setUserId(session?.user.id??null)); return()=>{active=false;data.subscription.unsubscribe()}},[])
  const common={navigate,userId}
  if(pathname==='/people') return <PeoplePage {...common}/>
  if(pathname==='/profile/settings') return <ProfileSettingsPage {...common}/>
  if(pathname==='/notifications') return <NotificationsPage {...common}/>
  if(pathname.startsWith('/profile/')) return <PublicProfilePage {...common} username={decodeURIComponent(pathname.slice('/profile/'.length))}/>
  if(pathname.startsWith('/community/')) return <CommunityPage {...common} slug={decodeURIComponent(pathname.slice('/community/'.length))}/>
  return <FeedPage {...common}/>
}

function SocialShell({navigate,userId,children}:{navigate:NavigateFunction;userId:string|null;children:ReactNode}) {
  return <div className="social-shell"><SocialHeader navigate={navigate} userId={userId}/><main className="social-main">{children}</main><footer className="social-footer">NODARA · Discover. Connect. Experience.</footer></div>
}

function FeedPage({navigate,userId}:{navigate:NavigateFunction;userId:string|null}) {
  const [posts,setPosts]=useState<SocialPost[]>([]); const [body,setBody]=useState(''); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [reload,setReload]=useState(0)
  useEffect(()=>{let active=true;fetchSocialFeed().then(result=>{if(!active)return;setPosts(result.posts);setError(result.error?messageOf(result.error):'');setLoading(false)}).catch(err=>{if(active){setError(messageOf(err));setLoading(false)}});return()=>{active=false}},[reload])
  const submit=async(event:FormEvent)=>{event.preventDefault();setError('');const result=await createSocialPost(body);if(result.error)setError(messageOf(result.error));else{setBody('');setReload(v=>v+1)}}
  return <SocialShell {...{navigate,userId}}><div className="social-heading"><span className="social-kicker">PUBLIC ACTIVITY</span><h1>Community feed<span>.</span></h1><p>Posts from people who chose to make their profiles discoverable.</p></div>
    {userId?<form className="social-composer" onSubmit={event=>void submit(event)}><label htmlFor="social-post-body">Share an update</label><textarea id="social-post-body" value={body} onChange={event=>setBody(event.target.value)} maxLength={2000} placeholder="What are you discovering?"/><div><small>{body.length}/2000 · Public to discoverable profiles</small><button disabled={!body.trim()}>Publish post</button></div></form>:<div className="social-callout">Sign in to post, react, and comment. Public posts remain visible to visitors.</div>}
    {error&&<p className="social-error" role="alert">{error}</p>}{loading?<div className="social-loading">Loading public posts…</div>:posts.length?<div className="social-feed">{posts.map(post=><SocialPostCard key={post.id} post={post} userId={userId} navigate={navigate} onRefresh={()=>setReload(v=>v+1)}/>)}</div>:<div className="social-empty"><h2>No public posts yet</h2><p>Posts from discoverable profiles will appear here.</p></div>}
  </SocialShell>
}

function PeoplePage({navigate,userId}:{navigate:NavigateFunction;userId:string|null}) {
  const [query,setQuery]=useState('');const [profiles,setProfiles]=useState<PublicProfile[]>([]);const [loading,setLoading]=useState(false);const [error,setError]=useState('')
  useEffect(()=>{if(!query.trim())return;let active=true;const timer=window.setTimeout(()=>{setLoading(true);searchPublicProfiles(query).then(result=>{if(!active)return;setProfiles(result.profiles);setError(result.error?messageOf(result.error):'');setLoading(false)}).catch(err=>{if(active){setError(messageOf(err));setLoading(false)}})},250);return()=>{active=false;window.clearTimeout(timer)}},[query])
  return <SocialShell {...{navigate,userId}}><div className="social-heading"><span className="social-kicker">OPT-IN PROFILE DISCOVERY</span><h1>Find your people<span>.</span></h1><p>Only profiles with discovery enabled appear here. Private contact details are never shown.</p></div><label className="social-search"><span>Search by display name or username</span><input value={query} onChange={event=>setQuery(event.target.value)} maxLength={80} placeholder="Try a name or @username"/></label>{error&&<p className="social-error" role="alert">{error}</p>}{loading?<div className="social-loading">Searching profiles…</div>:query.trim()?profiles.length?<div className="social-profile-grid">{profiles.map(profile=><ProfileCard key={profile.id} profile={profile} navigate={navigate}/>)}</div>:<div className="social-empty">No discoverable profiles match that search.</div>:<div className="social-empty">Enter a name or username to search public profiles.</div>}</SocialShell>
}

function ProfileCard({profile,navigate}:{profile:Pick<PublicProfile,'id'|'username'|'display_name'|'avatar_url'|'bio'|'location'|'follower_count'>;navigate:NavigateFunction}) {
  return <article className="social-profile-card"><ProfileImage url={profile.avatar_url} name={displayName(profile.display_name,profile.username)}/><div><button className="social-author-name" onClick={()=>navigate(`/profile/${profile.username}`)}>{displayName(profile.display_name,profile.username)}</button><small>@{profile.username} · {profile.follower_count} followers</small>{profile.location&&<small>{profile.location}</small>}<p>{profile.bio||'A NODARA community member.'}</p></div></article>
}

function ProfileSettingsPage({navigate,userId}:{navigate:NavigateFunction;userId:string|null}) {
  const [form,setForm]=useState({full_name:'',username:'',avatar_url:'',bio:'',location:'',interest_categories:[] as string[],is_discoverable:false,show_location:false,show_interests:false,show_hosted_events:false})
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [message,setMessage]=useState('')
  useEffect(()=>{if(!supabase||!userId)return;let active=true;supabase.from('profiles').select('full_name,username,avatar_url,bio,location,interest_categories,is_discoverable,show_location,show_interests,show_hosted_events').eq('id',userId).maybeSingle().then(({data,error})=>{if(!active)return;if(error)setMessage(error.message);if(data)setForm({full_name:data.full_name??'',username:data.username??'',avatar_url:data.avatar_url??'',bio:data.bio??'',location:data.location??'',interest_categories:data.interest_categories??[],is_discoverable:data.is_discoverable??false,show_location:data.show_location??false,show_interests:data.show_interests??false,show_hosted_events:data.show_hosted_events??false});setLoading(false)});return()=>{active=false}},[userId])
  const update=(key:string,value:unknown)=>setForm(current=>({...current,[key]:value}))
  const submit=async(event:FormEvent)=>{event.preventDefault();setSaving(true);setMessage('');const result=await updateSocialProfile({...form,avatar_url:form.avatar_url.trim()||null});setSaving(false);setMessage(result.error?messageOf(result.error):'Profile saved. Public details follow the visibility switches above.')}
  return <SocialShell {...{navigate,userId}}><div className="social-heading"><span className="social-kicker">YOUR SOCIAL IDENTITY</span><h1>Profile settings<span>.</span></h1><p>Your profile starts private. Turn on discoverability before sharing posts or appearing in profile search.</p></div>{!userId?<div className="social-callout">Sign in to manage your profile.</div>:loading?<div className="social-loading">Loading your profile…</div>:<form className="social-settings" onSubmit={event=>void submit(event)}><label>Display name<input value={form.full_name} onChange={event=>update('full_name',event.target.value)} maxLength={120}/></label><label>Username<input value={form.username} onChange={event=>update('username',event.target.value.toLowerCase().replace(/[^a-z0-9_]/g,''))} minLength={3} maxLength={30} required/><small>3–30 lowercase letters, numbers or underscores.</small></label><label>Profile image URL<input type="url" value={form.avatar_url} onChange={event=>update('avatar_url',event.target.value)} placeholder="https://…"/><small>HTTPS image URLs only. Uploads aren’t enabled in this project.</small></label><label>Biography<textarea value={form.bio} onChange={event=>update('bio',event.target.value)} maxLength={500}/></label><label>City and country<input value={form.location} onChange={event=>update('location',event.target.value)} maxLength={160} placeholder="Optional"/></label><fieldset><legend>Public visibility</legend>{([['is_discoverable','Show my profile in public search'],['show_location','Show my city and country'],['show_interests','Show my interests'],['show_hosted_events','Show my upcoming public events']] as const).map(([key,label])=><label className="social-check" key={key}><input type="checkbox" checked={form[key]} onChange={event=>update(key,event.target.checked)}/>{label}</label>)}</fieldset><div className="social-interest-setting"><strong>Interests</strong><p>Manage interests in recommendations. Choose which categories to show publicly above.</p><span>{form.interest_categories.join(' · ')||'No interests saved yet'}</span></div>{message&&<p className={message==='Profile saved. Public details follow the visibility switches above.'?'social-success':'social-error'} role="status">{message}</p>}<div className="social-form-actions"><button disabled={saving}>{saving?'Saving…':'Save profile'}</button>{form.username&&<button type="button" className="social-secondary" onClick={()=>navigate(`/profile/${form.username}`)}>Preview public profile</button>}</div></form>}</SocialShell>
}

function PublicProfilePage({navigate,userId,username}:{navigate:NavigateFunction;userId:string|null;username:string}) {
  const [profile,setProfile]=useState<PublicProfile|null>(null);const [posts,setPosts]=useState<SocialPost[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [reload,setReload]=useState(0);const [list,setList]=useState<'followers'|'following'|null>(null);const [listProfiles,setListProfiles]=useState<{id:string;username:string;display_name:string|null;avatar_url:string|null}[]>([])
  useEffect(()=>{let active=true;getPublicProfile(username).then(result=>{if(!active)return;setProfile(result.profile);setError(result.error?messageOf(result.error):'');setLoading(false)}).catch(err=>{if(active){setError(messageOf(err));setLoading(false)}});return()=>{active=false}},[username,reload])
  const profileId=profile?.id
  useEffect(()=>{if(!profileId)return;let active=true;fetchSocialFeed({authorId:profileId}).then(result=>{if(active)setPosts(result.posts)});return()=>{active=false}},[profileId,reload])
  const follow=async()=>{if(!profile)return;if(!userId){setError('Sign in to follow public profiles.');return}const result=await setFollow(profile.id,!profile.followed_by_viewer);if(result.error)setError(messageOf(result.error));else setReload(v=>v+1)}
  const showList=async(direction:'followers'|'following')=>{if(!profile)return;setList(direction);const result=await getPublicFollowList(profile.username,direction);setListProfiles(result.profiles);if(result.error)setError(messageOf(result.error))}
  const share=async()=>{const url=window.location.href;try{if(navigator.share)await navigator.share({title:displayName(profile?.display_name,profile?.username),url});else{await navigator.clipboard.writeText(url);setError('Profile link copied.')}}catch{setError('Could not share this profile.')}}
  const block=async()=>{if(!profile||!userId)return;if(!window.confirm('Block this profile? Their posts and interactions will be hidden from you, and existing follows between you will be removed.'))return;const result=await setUserBlock(profile.id,true);setError(result.error?messageOf(result.error):'Profile blocked.')}
  const report=async()=>{if(!profile)return;const result=await createContentReport({type:'profile',id:profile.id,category:'other'});setError(result.error?messageOf(result.error):'Report sent privately to the moderation team.')}
  return <SocialShell {...{navigate,userId}}>{loading?<div className="social-loading">Loading public profile…</div>:!profile?<div className="social-empty"><h1>Profile unavailable</h1><p>This profile is private, blocked, or no longer available.</p></div>:<><section className="social-profile-hero"><ProfileImage url={profile.avatar_url} name={displayName(profile.display_name,profile.username)}/><div><span className="social-kicker">PUBLIC PROFILE</span><h1>{displayName(profile.display_name,profile.username)}</h1><p>@{profile.username}</p>{profile.bio&&<p className="social-profile-bio">{profile.bio}</p>}{profile.location&&<p>{profile.location}</p>}{profile.interest_categories.length>0&&<p className="social-interest-tags">{profile.interest_categories.join(' · ')}</p>}<div className="social-profile-counts"><button onClick={()=>void showList('followers')}>{profile.follower_count} followers</button><button onClick={()=>void showList('following')}>{profile.following_count} following</button><span>{profile.communities.length} communities</span></div><div className="social-form-actions">{userId!==profile.id&&<button onClick={()=>void follow()}>{profile.followed_by_viewer?'Unfollow':'Follow'}</button>}<button className="social-secondary" onClick={()=>void share()}>Share profile</button>{userId&&userId!==profile.id&&<><button className="social-secondary" onClick={()=>void report()}>Report</button><button className="social-secondary" onClick={()=>void block()}>Block</button></>}</div></div></section>
    {list&&<section className="social-card"><div className="social-card-title"><h2>{list==='followers'?'Followers':'Following'}</h2><button className="social-secondary" onClick={()=>setList(null)}>Close</button></div>{listProfiles.map(item=><ProfileCard key={item.id} profile={{...item,bio:null,location:null,follower_count:0}} navigate={navigate}/>)}</section>}
    {profile.communities.length>0&&<section className="social-card"><h2>Communities</h2><div className="social-link-row">{profile.communities.map(community=><button key={community.id} onClick={()=>navigate(`/community/${community.slug}`)}>{community.name} · {community.category}</button>)}</div></section>}
    {profile.upcoming_events.length>0&&<section className="social-card"><h2>Upcoming events</h2>{profile.upcoming_events.map(event=><div className="social-list-row" key={event.id}><strong>{event.title}</strong><span>{new Date(event.start_date).toLocaleDateString()} · {event.location}, {event.country}</span></div>)}</section>}
    <section><div className="social-section-title"><h2>Public posts</h2></div>{posts.length?posts.map(post=><SocialPostCard key={post.id} post={post} userId={userId} navigate={navigate} onRefresh={()=>setReload(v=>v+1)}/>):<div className="social-empty">No public posts yet.</div>}</section>
  </>}{error&&<p className="social-inline-note" role="status">{error}</p>}</SocialShell>
}

function CommunityPage({navigate,userId,slug}:{navigate:NavigateFunction;userId:string|null;slug:string}) {
  const [community,setCommunity]=useState<CommunityDetail|null>(null);const [role,setRole]=useState<string|null>(null);const [posts,setPosts]=useState<CommunityPost[]>([]);const [body,setBody]=useState('');const [announcement,setAnnouncement]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [reload,setReload]=useState(0)
  useEffect(()=>{let active=true;fetchCommunityBySlug(slug).then(async result=>{if(!active)return;setCommunity(result.community);setRole(result.role);if(result.error){setError(messageOf(result.error));setLoading(false);return}if(result.community){const feed=await fetchCommunitySocialFeed(result.community.id);if(active){setPosts(feed.posts);if(feed.error)setError(messageOf(feed.error))}}setLoading(false)}).catch(err=>{if(active){setError(messageOf(err));setLoading(false)}});return()=>{active=false}},[slug,reload])
  const membership=async(join:boolean)=>{if(!userId||!community){setError('Sign in to join this community.');return}const result=await setCommunityMembership(userId,community.id,join);if(result.error)setError(messageOf(result.error));else setReload(v=>v+1)}
  const submit=async(event:FormEvent)=>{event.preventDefault();if(!community)return;const result=await createCommunityPost(community.id,body,announcement);if(result.error)setError(messageOf(result.error));else{setBody('');setAnnouncement(false);setReload(v=>v+1)}}
  const moderate=async(post:CommunityPost)=>{if(!window.confirm('Remove this community post and record a moderation action?'))return;const result=await moderateCommunityPost(post.id,'remove_post','Community rules');if(result.error)setError(messageOf(result.error));else setReload(v=>v+1)}
  const report=async()=>{if(!community)return;const result=await createContentReport({type:'community',id:community.id,category:'other'});setError(result.error?messageOf(result.error):'Report sent privately to the moderation team.')}
  const share=async()=>{if(!community)return;const url=window.location.href;try{if(navigator.share)await navigator.share({title:community.name,url});else{await navigator.clipboard.writeText(url);setError('Community link copied.')}}catch{setError('Could not share this community.')}}
  return <SocialShell {...{navigate,userId}}>{loading?<div className="social-loading">Loading community…</div>:!community?<div className="social-empty"><h1>Community unavailable</h1><p>{error||'This community could not be found.'}</p></div>:<><section className="social-community-hero">{community.cover_image&&<img src={community.cover_image} alt="" onError={image=>{image.currentTarget.hidden=true}}/>}<div><span className="social-kicker">{community.category.toUpperCase()} · COMMUNITY</span><h1>{community.name}</h1><p>{community.description}</p><small>{community.location||'Global'} · {community.member_count} members</small><div className="social-form-actions">{userId&&<button onClick={()=>void membership(Boolean(role))}>{role?'Leave community':'Join community'}</button>}<button className="social-secondary" onClick={()=>void share()}>Share</button><button className="social-secondary" onClick={()=>void report()}>Report</button></div></div></section>
    {userId&&<form className="social-composer" onSubmit={event=>void submit(event)}><label htmlFor="community-post">Post to the community</label><textarea id="community-post" value={body} onChange={event=>setBody(event.target.value)} maxLength={4000}/>{(role==='owner'||role==='moderator')&&<label className="social-check"><input type="checkbox" checked={announcement} onChange={event=>setAnnouncement(event.target.checked)}/> Publish as an official announcement</label>}<div><small>Members can post. Only owners and moderators can announce.</small><button disabled={!body.trim()}>Publish</button></div></form>}
    <section className="social-community-posts"><h2>Community posts</h2>{posts.length?posts.map(post=><article className="social-card" key={post.id}><div className="social-post-author"><ProfileImage url={post.avatar_url} name={displayName(post.display_name,post.username)}/><div><strong>{post.is_announcement?'Official announcement':displayName(post.display_name,post.username)}</strong><small>{new Date(post.created_at).toLocaleString()}</small></div>{(role==='owner'||role==='moderator')&&<button className="social-text-button" onClick={()=>void moderate(post)}>Moderate</button>}</div><p className="social-post-body">{post.body}</p></article>):<div className="social-empty">No community posts yet.</div>}</section>
  </>}{error&&<p className="social-inline-note" role="status">{error}</p>}</SocialShell>
}

function NotificationsPage({navigate,userId}:{navigate:NavigateFunction;userId:string|null}) {
  const [notifications,setNotifications]=useState<SocialNotification[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true)
  useEffect(()=>{let active=true;fetchSocialNotifications().then(result=>{if(!active)return;setNotifications(result.notifications);setError(result.error?messageOf(result.error):'');setLoading(false)});return()=>{active=false}},[])
  const mark=async(id:string|null)=>{const result=await markNotificationRead(id);if(result.error)setError(messageOf(result.error));else{setNotifications(current=>current.map(item=>!id||item.id===id?{...item,read_at:new Date().toISOString()}:item))}}
  const open=async(notification:SocialNotification)=>{if(!notification.read_at)await mark(notification.id);if(notification.community_id){const {data}=await supabase!.from('communities').select('slug').eq('id',notification.community_id).maybeSingle();if(data?.slug)navigate(`/community/${data.slug}`);return}if(notification.post_id){navigate(`/feed?post=${notification.post_id}`);return}if(notification.actor_id){const {data}=await supabase!.from('profiles').select('username').eq('id',notification.actor_id).maybeSingle();if(data?.username)navigate(`/profile/${data.username}`)}}
  return <SocialShell {...{navigate,userId}}><div className="social-heading"><span className="social-kicker">YOUR UPDATES</span><h1>Notifications<span>.</span></h1><p>Only you can view your social notifications.</p></div>{!userId?<div className="social-callout">Sign in to view notifications.</div>:<><div className="social-notification-tools"><span>{notifications.filter(item=>!item.read_at).length} unread</span><button onClick={()=>void mark(null)} disabled={!notifications.some(item=>!item.read_at)}>Mark all as read</button></div>{error&&<p className="social-error">{error}</p>}{loading?<div className="social-loading">Loading notifications…</div>:notifications.length?notifications.map(item=><button className={item.read_at?'social-notification':'social-notification unread'} key={item.id} onClick={()=>void open(item)}><span className="notification-dot"/><span><strong>{item.message}</strong><small>{new Date(item.created_at).toLocaleString()}</small></span></button>):<div className="social-empty">No notifications yet.</div>}</>}</SocialShell>
}
