import type { EventView } from '../types/database'
import type { TrendingCommunity } from './trendingService'

export type EventRank = { event_id: string; trending_rank: number }

/** Restore the RPC order after the RLS-protected event detail query. */
export function orderTrendingEvents(
  ranks: EventRank[],
  events: EventView[],
  now = Date.now(),
  limit = 8,
): EventView[] {
  const validRanks = new Map<string, number>()
  for (const row of ranks) {
    if (row && typeof row.event_id === 'string' && Number.isInteger(row.trending_rank) && row.trending_rank > 0) {
      validRanks.set(row.event_id, Math.min(validRanks.get(row.event_id) ?? Infinity, row.trending_rank))
    }
  }
  const byId = new Map<string, EventView>()
  for (const event of events) {
    if (event.status === 'published' && Date.parse(event.startDate) > now && validRanks.has(event.id) && !byId.has(event.id)) {
      byId.set(event.id, event)
    }
  }
  return [...byId.values()]
    .sort((a, b) => validRanks.get(a.id)! - validRanks.get(b.id)!)
    .slice(0, Math.max(0, limit))
}

/** Sanitize public aggregate rows and keep their database ranking order. */
export function normalizeTrendingCommunities(rows: unknown[]): TrendingCommunity[] {
  const seen = new Set<string>()
  const communities: TrendingCommunity[] = []
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue
    const row = value as Partial<TrendingCommunity>
    if (typeof row.id !== 'string' || seen.has(row.id)
      || typeof row.name !== 'string' || typeof row.slug !== 'string'
      || typeof row.description !== 'string' || typeof row.category !== 'string'
      || typeof row.created_at !== 'string' || typeof row.member_count !== 'number'
      || !Number.isSafeInteger(row.member_count) || row.member_count < 0
      || (row.cover_image !== null && typeof row.cover_image !== 'string')
      || (row.location !== null && typeof row.location !== 'string')) continue
    seen.add(row.id)
    communities.push(row as TrendingCommunity)
  }
  return communities
}
