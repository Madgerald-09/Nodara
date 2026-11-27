import { supabase } from '../lib/supabase'
import { mapEvent } from './eventService'
import { normalizeTrendingCommunities, orderTrendingEvents } from './trendingRanking'
import type { EventRow, EventView } from '../types/database'

export type TrendingPeriod = 'week' | 'month' | 'all_time'
export type TrendingCommunity = {
  id: string
  name: string
  slug: string
  description: string
  category: string
  cover_image: string | null
  location: string | null
  created_at: string
  member_count: number
}

export async function fetchTrendingEvents(period: TrendingPeriod) {
  if (!supabase) return { events: [] as EventView[], error: new Error('Supabase is not configured.') }
  const { data: ranks, error: rankingError } = await supabase.rpc('get_trending_event_ranks', { p_period: period })
  if (rankingError) return { events: [] as EventView[], error: rankingError }
  const rankRows = (ranks ?? []) as { event_id: string; trending_rank: number }[]
  const orderedIds = [...rankRows].sort((a, b) => a.trending_rank - b.trending_rank).map(row => row.event_id)
  if (!orderedIds.length) return { events: [] as EventView[], error: null }
  const { data, error } = await supabase.from('events').select('*').in('id', orderedIds)
    .eq('status', 'published').gt('start_date', new Date().toISOString())
  if (error) return { events: [] as EventView[], error }
  const events = (data ?? []).map(row => mapEvent(row as EventRow))
  return { events: orderTrendingEvents(rankRows, events), error: null }
}

export async function fetchTrendingCommunities(period: Exclude<TrendingPeriod, 'all_time'>) {
  if (!supabase) return { communities: [] as TrendingCommunity[], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.rpc('get_trending_communities', { p_period: period })
  return { communities: normalizeTrendingCommunities(data ?? []), error }
}
