import { supabase } from '../lib/supabase'
import type { CommunityRow } from '../types/database'

export async function fetchCommunities() {
  if (!supabase) return { communities: [] as CommunityRow[], memberships: [] as string[], ownerMemberships: [] as string[], error: new Error('Supabase is not configured.') }
  const [communityResult, countsResult, userResult] = await Promise.all([
    supabase.from('communities').select('*').order('created_at', { ascending: false }),
    supabase.rpc('get_community_member_counts'),
    supabase.auth.getUser(),
  ])
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

export async function setCommunityMembership(userId: string, communityId: string, join: boolean) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const result = join
    ? await supabase.from('community_members').insert({ community_id: communityId, user_id: userId, role: 'member' })
    : await supabase.from('community_members').delete().eq('community_id', communityId).eq('user_id', userId).neq('role', 'owner')
  return { error: result.error }
}
