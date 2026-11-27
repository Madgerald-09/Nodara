import { supabase } from '../lib/supabase'

export type PublicProfile = {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  location: string | null
  interest_categories: string[]
  follower_count: number
  following_count: number
  followed_by_viewer: boolean
  communities: { id: string; name: string; slug: string; category: string; cover_image: string | null }[]
  upcoming_events: { id: string; title: string; slug: string; start_date: string; location: string; country: string; cover_image: string | null }[]
}

export type SocialPost = {
  id: string
  author_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  body: string
  event_id: string | null
  created_at: string
  updated_at: string
  reaction_count: number
  comment_count: number
  viewer_reacted: boolean
}

export type CommunityPost = {
  id: string
  community_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  body: string
  is_announcement: boolean
  created_at: string
  updated_at: string
}

export type SocialComment = {
  id: string
  post_id: string
  author_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  body: string
  created_at: string
}

export type SocialNotification = {
  id: string
  actor_id: string | null
  kind: string
  post_id: string | null
  community_id: string | null
  comment_id: string | null
  message: string
  created_at: string
  read_at: string | null
}

function unavailable() { return new Error('Supabase is not configured.') }
async function currentUser() {
  if (!supabase) return { id: null, error: unavailable() }
  const { data, error } = await supabase.auth.getUser()
  return { id: data.user?.id ?? null, error }
}

export async function searchPublicProfiles(query: string, offset = 0) {
  if (!supabase) return { profiles: [] as PublicProfile[], error: unavailable() }
  const { data, error } = await supabase.rpc('get_public_profiles', { p_query: query.trim().slice(0, 80), p_limit: 20, p_offset: offset })
  return { profiles: (data ?? []) as PublicProfile[], error }
}

export async function getPublicProfile(username: string) {
  if (!supabase) return { profile: null as PublicProfile | null, error: unavailable() }
  const { data, error } = await supabase.rpc('get_public_profile', { p_username: username.toLowerCase().trim() })
  return { profile: ((data ?? [])[0] ?? null) as PublicProfile | null, error }
}

export async function getPublicFollowList(username: string, direction: 'followers' | 'following', offset = 0) {
  if (!supabase) return { profiles: [] as Pick<PublicProfile, 'id' | 'username' | 'display_name' | 'avatar_url'>[], error: unavailable() }
  const { data, error } = await supabase.rpc('get_public_follow_list', { p_username: username, p_direction: direction, p_limit: 30, p_offset: offset })
  return { profiles: (data ?? []) as Pick<PublicProfile, 'id' | 'username' | 'display_name' | 'avatar_url'>[], error }
}

export async function updateSocialProfile(input: {
  full_name: string
  username: string
  avatar_url: string | null
  bio: string
  location: string
  interest_categories: string[]
  is_discoverable: boolean
  show_location: boolean
  show_interests: boolean
  show_hosted_events: boolean
}) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to edit your profile.') }
  if (!/^[a-z0-9_]{3,30}$/.test(input.username)) return { error: new Error('Username must be 3–30 lowercase letters, numbers or underscores.') }
  if (input.full_name.trim().length > 120 || input.bio.length > 500 || input.location.length > 160) return { error: new Error('One or more profile fields are too long.') }
  if (input.avatar_url && (!/^https:\/\//i.test(input.avatar_url) || input.avatar_url.length > 2048)) return { error: new Error('Profile image must use a valid HTTPS URL.') }
  const { error } = await supabase.from('profiles').update({
    full_name: input.full_name.trim() || null, username: input.username, avatar_url: input.avatar_url,
    bio: input.bio.trim() || null, location: input.location.trim() || null,
    interest_categories: input.interest_categories, is_discoverable: input.is_discoverable,
    show_location: input.show_location, show_interests: input.show_interests, show_hosted_events: input.show_hosted_events,
  }).eq('id', id)
  return { error }
}

export async function createSocialPost(body: string, eventId: string | null = null) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to post.') }
  if (!body.trim() || body.trim().length > 2000) return { error: new Error('Posts must be between 1 and 2,000 characters.') }
  const { error } = await supabase.from('social_posts').insert({ author_id: id, body: body.trim(), event_id: eventId })
  return { error }
}

export async function fetchSocialFeed(options: { before?: string; beforeId?: string; authorId?: string; limit?: number } = {}) {
  if (!supabase) return { posts: [] as SocialPost[], error: unavailable() }
  const { data, error } = await supabase.rpc('get_social_feed', {
    p_before: options.before ?? null, p_before_id: options.beforeId ?? null,
    p_limit: options.limit ?? 20, p_author_id: options.authorId ?? null,
  })
  return { posts: (data ?? []) as SocialPost[], error }
}

export async function editSocialPost(postId: string, body: string) {
  if (!supabase) return { error: unavailable() }
  if (!body.trim() || body.trim().length > 2000) return { error: new Error('Posts must be between 1 and 2,000 characters.') }
  const { error } = await supabase.from('social_posts').update({ body: body.trim() }).eq('id', postId)
  return { error }
}

export async function deleteSocialPost(postId: string) {
  if (!supabase) return { error: unavailable() }
  const { error } = await supabase.from('social_posts').delete().eq('id', postId)
  return { error }
}

export async function setPostReaction(postId: string, reacted: boolean) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to react.') }
  if (reacted) {
    const { error } = await supabase.from('social_reactions').delete().eq('post_id', postId).eq('user_id', id)
    return { error }
  }
  const { error } = await supabase.from('social_reactions').insert({ post_id: postId, user_id: id })
  return { error: error?.code === '23505' ? null : error }
}

export async function fetchSocialComments(postId: string, before?: string, beforeId?: string) {
  if (!supabase) return { comments: [] as SocialComment[], error: unavailable() }
  const { data, error } = await supabase.rpc('get_social_comments', {
    p_post_id: postId, p_before: before ?? null, p_before_id: beforeId ?? null, p_limit: 50,
  })
  return { comments: (data ?? []) as SocialComment[], error }
}

export async function createSocialComment(postId: string, body: string) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to comment.') }
  if (!body.trim() || body.trim().length > 1000) return { error: new Error('Comments must be between 1 and 1,000 characters.') }
  const { error } = await supabase.from('social_comments').insert({ post_id: postId, author_id: id, body: body.trim() })
  return { error }
}

export async function editSocialComment(commentId: string, body: string) {
  if (!supabase) return { error: unavailable() }
  if (!body.trim() || body.trim().length > 1000) return { error: new Error('Comments must be between 1 and 1,000 characters.') }
  const { error } = await supabase.from('social_comments').update({ body: body.trim() }).eq('id', commentId)
  return { error }
}

export async function deleteSocialComment(commentId: string) {
  if (!supabase) return { error: unavailable() }
  const { error } = await supabase.from('social_comments').delete().eq('id', commentId)
  return { error }
}

export async function fetchCommunitySocialFeed(communityId: string, before?: string, beforeId?: string) {
  if (!supabase) return { posts: [] as CommunityPost[], error: unavailable() }
  const { data, error } = await supabase.rpc('get_community_social_feed', {
    p_community_id: communityId, p_before: before ?? null, p_before_id: beforeId ?? null, p_limit: 30,
  })
  return { posts: (data ?? []) as CommunityPost[], error }
}

export async function createCommunityPost(communityId: string, body: string, announcement = false) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to post in a community.') }
  if (!body.trim() || body.trim().length > 4000) return { error: new Error('Community posts must be between 1 and 4,000 characters.') }
  const { error } = await supabase.from('community_posts').insert({ community_id: communityId, author_id: id, body: body.trim(), is_announcement: announcement })
  return { error }
}

export async function moderateCommunityPost(postId: string, action: 'remove_post' | 'restore_post', reason = '') {
  if (!supabase) return { error: unavailable() }
  const { error } = await supabase.rpc('create_social_moderation_action', { p_post_id: postId, p_action: action, p_reason: reason })
  return { error }
}

export async function setFollow(targetUserId: string, following: boolean) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to follow profiles.') }
  if (id === targetUserId) return { error: new Error('You cannot follow yourself.') }
  const result = following
    ? await supabase.from('user_follows').insert({ follower_id: id, followed_id: targetUserId })
    : await supabase.from('user_follows').delete().eq('follower_id', id).eq('followed_id', targetUserId)
  return { error: result.error?.code === '23505' ? null : result.error }
}

export async function setUserBlock(targetUserId: string, blocked: boolean) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to manage blocks.') }
  if (id === targetUserId) return { error: new Error('You cannot block your own account.') }
  const result = blocked
    ? await supabase.from('user_blocks').insert({ blocker_id: id, blocked_id: targetUserId })
    : await supabase.from('user_blocks').delete().eq('blocker_id', id).eq('blocked_id', targetUserId)
  return { error: result.error?.code === '23505' ? null : result.error }
}

export async function createContentReport(input: { type: 'profile' | 'post' | 'comment' | 'community'; id: string; category: string; description?: string }) {
  if (!supabase) return { error: unavailable() }
  const { id, error: authError } = await currentUser()
  if (!id || authError) return { error: authError ?? new Error('Sign in to report content.') }
  const { error } = await supabase.from('content_reports').insert({
    reporter_id: id, target_type: input.type, target_id: input.id,
    category: input.category, description: input.description?.trim().slice(0, 1000) || null,
  })
  return { error: error?.code === '23505' ? null : error }
}

export async function fetchSocialNotifications() {
  if (!supabase) return { notifications: [] as SocialNotification[], error: unavailable() }
  const { data, error } = await supabase.from('social_notifications').select('id,actor_id,kind,post_id,community_id,comment_id,message,created_at,read_at')
    .order('created_at', { ascending: false }).limit(50)
  return { notifications: (data ?? []) as SocialNotification[], error }
}

export async function markNotificationRead(id: string | null = null) {
  if (!supabase) return { error: unavailable() }
  let query = supabase.from('social_notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
  if (id) query = query.eq('id', id)
  const { error } = await query
  return { error }
}
