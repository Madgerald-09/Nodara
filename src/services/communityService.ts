import { supabase } from '../lib/supabase'
import type { CommunityRow } from '../types/database'
import { communitySearchFilter, normalizeSearchTerm } from './searchUtils'
import { isSafeCommunityHttpsUrl } from './communityAnnouncementPolicy'

export type CommunitySearchResult = Pick<CommunityRow, 'id' | 'slug' | 'name' | 'description' | 'category' | 'cover_image' | 'location'>
export type PublicCommunityCard = CommunitySearchResult & Pick<CommunityRow, 'member_count'>
export type CommunityDetail = Pick<CommunityRow, 'id' | 'creator_id' | 'name' | 'slug' | 'description' | 'category' | 'cover_image' | 'location' | 'created_at' | 'member_count'>

export async function searchCommunities(query: string, signal?: AbortSignal) {
  const term = normalizeSearchTerm(query)
  if (!term) return { communities: [] as CommunitySearchResult[], error: null }
  if (!supabase) return { communities: [] as CommunitySearchResult[], error: new Error('Supabase is not configured.') }
  let request = supabase
    .from('communities')
    .select('id, name, slug, description, category, cover_image, location, created_at')
    .or(communitySearchFilter(term))
    .order('created_at', { ascending: false })
    .limit(8)
  if (signal) request = request.abortSignal(signal)
  const { data, error } = await request
  return { communities: (data ?? []) as CommunitySearchResult[], error }
}

export async function fetchCommunities() {
  if (!supabase) return { communities: [] as CommunityRow[], memberships: [] as string[], ownerMemberships: [] as string[], error: new Error('Supabase is not configured.') }
  const [communityResult, countsResult, userResult] = await Promise.all([
    supabase.from('communities').select('*').order('created_at', { ascending: false }).limit(12),
    supabase.rpc('get_community_member_counts'),
    supabase.auth.getUser(),
  ])
  if (communityResult.error || countsResult.error) {
    return {
      communities: [], memberships: [], ownerMemberships: [],
      error: communityResult.error ?? countsResult.error,
    }
  }
  const user = userResult.data.user
  const membershipResult = user
    ? await supabase.from('community_members').select('community_id, role').eq('user_id', user.id)
    : { data: [], error: null }
  const counts = new Map<string, number>((countsResult.data ?? []).map((row: { community_id: string; member_count: number }) => [row.community_id, Number(row.member_count)]))
  return {
    communities: (communityResult.data ?? []).map(row => ({ ...row, member_count: counts.get(row.id) ?? 0 })) as CommunityRow[],
    memberships: (membershipResult.data ?? []).map(row => row.community_id),
    ownerMemberships: (membershipResult.data ?? []).filter(row => row.role === 'owner').map(row => row.community_id),
    error: communityResult.error ?? countsResult.error ?? membershipResult.error,
  }
}

export async function fetchCommunityCard(communityId: string) {
  if (!supabase) return { community: null as PublicCommunityCard | null, role: null as string | null, error: new Error('Supabase is not configured.') }
  const [communityResult, countsResult, userResult] = await Promise.all([
    supabase.from('communities').select('id,slug,name,description,category,cover_image,location').eq('id', communityId).maybeSingle(),
    supabase.rpc('get_community_member_counts'),
    supabase.auth.getUser(),
  ])
  if (communityResult.error || countsResult.error) {
    return { community: null, role: null, error: communityResult.error ?? countsResult.error }
  }
  if (!communityResult.data) return { community: null, role: null, error: new Error('Community is no longer available.') }
  const count = (countsResult.data ?? []).find((row: { community_id: string; member_count: number }) => row.community_id === communityId)?.member_count ?? 0
  const membership = userResult.data.user
    ? await supabase.from('community_members').select('role').eq('community_id', communityId).eq('user_id', userResult.data.user.id).maybeSingle()
    : { data: null, error: null }
  if (membership.error) return { community: null, role: null, error: membership.error }
  return {
    community: { ...communityResult.data, member_count: Number(count) } as PublicCommunityCard,
    role: membership.data?.role ?? null,
    error: null,
  }
}

export async function fetchCommunityBySlug(slug: string) {
  if (!supabase) return { community: null as CommunityDetail | null, role: null as string | null, error: new Error('Supabase is not configured.') }
  const [communityResult, countsResult, userResult] = await Promise.all([
    supabase.from('communities').select('id,creator_id,name,slug,description,category,cover_image,location,created_at').eq('slug', slug).maybeSingle(),
    supabase.rpc('get_community_member_counts'),
    supabase.auth.getUser(),
  ])
  if (communityResult.error || countsResult.error) return { community: null, role: null, error: communityResult.error ?? countsResult.error }
  if (!communityResult.data) return { community: null, role: null, error: new Error('Community not found.') }
  const community = communityResult.data
  const count = (countsResult.data ?? []).find((row: { community_id: string; member_count: number }) => row.community_id === community.id)?.member_count ?? 0
  const membership = userResult.data.user
    ? await supabase.from('community_members').select('role').eq('community_id', community.id).eq('user_id', userResult.data.user.id).maybeSingle()
    : { data: null, error: null }
  if (membership.error) return { community: null, role: null, error: membership.error }
  const role = membership.data?.role ?? (userResult.data.user?.id === community.creator_id ? 'owner' : null)
  return { community: { ...community, member_count: Number(count) } as CommunityDetail, role, error: null }
}

export type CommunityAnnouncement = {
  id: string
  community_id: string
  title: string
  body: string
  status: 'draft' | 'scheduled' | 'published' | 'archived'
  scheduled_for: string | null
  published_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export async function fetchCommunityInformation(slug: string) {
  if (!supabase) return { community: null, info: null, announcements: [], highlights: [], role: null, error: new Error('Supabase is not configured.') }
  const base = await fetchCommunityBySlug(slug)
  if (base.error || !base.community) return { community: null, info: null, announcements: [], highlights: [], role: null, error: base.error }
  const [infoResult, announcementsResult, highlightsResult] = await Promise.all([
    supabase.from('community_public_info').select('official_website,official_links,guidelines,updated_at').eq('community_id', base.community.id).maybeSingle(),
    supabase.from('community_announcements').select('id,community_id,title,body,status,scheduled_for,published_at,archived_at,created_at,updated_at')
      .eq('community_id', base.community.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('community_event_highlights').select('community_id,event_id,created_at,event:events(id,title,slug,short_description,category,cover_image,location,country,start_date,end_date,status)')
      .eq('community_id', base.community.id).order('created_at', { ascending: false }).limit(20),
  ])
  const error = infoResult.error ?? announcementsResult.error ?? highlightsResult.error
  const missingSchema = [infoResult.error, announcementsResult.error, highlightsResult.error].some(value =>
    value && (value.code === '42P01' || value.code === 'PGRST205' || /relation .* does not exist/i.test(value.message)),
  )
  return {
    community: base.community,
    info: infoResult.data as { official_website: string | null; official_links: string[]; guidelines: string | null; updated_at: string } | null,
    announcements: (announcementsResult.data ?? []) as CommunityAnnouncement[],
    highlights: (highlightsResult.data ?? []).flatMap(row => {
      const related = Array.isArray(row.event) ? row.event[0] : row.event
      return related ? [{ event_id: row.event_id, event: related as unknown as Record<string, unknown> }] : []
    }),
    role: base.role,
    error: missingSchema ? null : error,
    schemaWarning: missingSchema ? 'Structured community pages are awaiting the reviewed community-information migration.' : null,
  }
}

export async function getUpcomingPublishedEvents() {
  if (!supabase) return { events: [], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.from('events').select('id,title,slug,location,country,start_date')
    .eq('status', 'published').gt('start_date', new Date().toISOString()).order('start_date').limit(100)
  return { events: data ?? [], error }
}

export async function saveCommunityPublicInfo(input: { communityId: string; website: string; links: string[]; guidelines: string }) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const website = input.website.trim()
  const links = input.links.map(link => link.trim()).filter(Boolean)
  if (website && !isSafeCommunityHttpsUrl(website)) return { error: new Error('Official website must use a valid HTTPS URL.') }
  if (links.length > 10 || links.some(link => !isSafeCommunityHttpsUrl(link))) return { error: new Error('Use up to 10 valid HTTPS links.') }
  if (input.guidelines.length > 10000) return { error: new Error('Guidelines must be 10,000 characters or fewer.') }
  const { error } = await supabase.rpc('save_community_public_info', {
    p_community_id: input.communityId, p_website: website || null, p_links: links, p_guidelines: input.guidelines,
  })
  return { error }
}

export async function createCommunityAnnouncement(communityId: string, title: string, body: string) {
  if (!supabase) return { id: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.rpc('create_community_announcement', { p_community_id: communityId, p_title: title, p_body: body })
  return { id: typeof data === 'string' ? data : null, error }
}

export async function updateCommunityAnnouncement(announcementId: string, title: string, body: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.rpc('edit_community_announcement', { p_announcement_id: announcementId, p_title: title, p_body: body })
  return { error }
}

export async function changeCommunityAnnouncementStatus(action: 'publish' | 'archive', announcementId: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const rpc = action === 'publish' ? 'publish_community_announcement' : 'archive_community_announcement'
  const { error } = await supabase.rpc(rpc, { p_announcement_id: announcementId })
  return { error }
}

export async function scheduleCommunityAnnouncement(announcementId: string, scheduledFor: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const date = new Date(scheduledFor)
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return { error: new Error('Choose a future publication date and time.') }
  const { error } = await supabase.rpc('schedule_community_announcement', { p_announcement_id: announcementId, p_scheduled_for: date.toISOString() })
  return { error }
}

export async function setCommunityEventHighlight(communityId: string, eventId: string, featured: boolean) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.rpc('set_community_event_highlight', { p_community_id: communityId, p_event_id: eventId, p_featured: featured })
  return { error }
}

export async function fetchCommunityAnnouncementHistory(announcementId: string) {
  if (!supabase) return { history: [], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.from('community_announcement_history')
    .select('id,announcement_id,community_id,action,title_snapshot,body_snapshot,status_snapshot,created_at')
    .eq('announcement_id', announcementId).order('created_at', { ascending: false }).limit(50)
  return { history: data ?? [], error }
}


export async function setCommunityMembership(userId: string, communityId: string, join: boolean) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const result = join
    ? await supabase.from('community_members').insert({ community_id: communityId, user_id: userId, role: 'member' })
    : await supabase.from('community_members').delete().eq('community_id', communityId).eq('user_id', userId).neq('role', 'owner')
  return { error: result.error }
}
