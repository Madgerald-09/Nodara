import { supabase } from '../lib/supabase'
import type { CommunityRow } from '../types/database'
import { communitySearchFilter, normalizeSearchTerm } from './searchUtils'

export type CommunitySearchResult = Pick<CommunityRow, 'id' | 'name' | 'description' | 'category' | 'cover_image' | 'location'>
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
    supabase.from('communities').select('id,name,description,category,cover_image,location').eq('id', communityId).maybeSingle(),
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
  return { community: { ...community, member_count: Number(count) } as CommunityDetail, role: membership.data?.role ?? null, error: null }
}

export async function setCommunityMembership(userId: string, communityId: string, join: boolean) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const result = join
    ? await supabase.from('community_members').insert({ community_id: communityId, user_id: userId, role: 'member' })
    : await supabase.from('community_members').delete().eq('community_id', communityId).eq('user_id', userId).neq('role', 'owner')
  return { error: result.error }
}
