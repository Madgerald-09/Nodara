import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrendingCommunities, orderTrendingEvents } from '../src/services/trendingRanking.ts'

const event = (id, rank, { status = 'published', startDate = '2027-01-01T00:00:00.000Z' } = {}) => ({
  id, status, startDate, rank,
})

test('restores aggregate rank order and removes duplicate or inaccessible event rows', () => {
  const result = orderTrendingEvents(
    [{ event_id: 'b', trending_rank: 2 }, { event_id: 'a', trending_rank: 1 }, { event_id: 'a', trending_rank: 3 }],
    [event('b', 2), event('a', 1), event('a', 1), event('missing', 4)],
    Date.parse('2026-11-27T00:00:00.000Z'),
  )
  assert.deepEqual(result.map(item => item.id), ['a', 'b'])
})

test('excludes unpublished and past events and supports empty results', () => {
  const result = orderTrendingEvents(
    [{ event_id: 'draft', trending_rank: 1 }, { event_id: 'past', trending_rank: 2 }],
    [event('draft', 1, { status: 'draft' }), event('past', 2, { startDate: '2026-11-26T00:00:00.000Z' })],
    Date.parse('2026-11-27T00:00:00.000Z'),
  )
  assert.deepEqual(result, [])
})

test('limits the number of ranked event cards', () => {
  const ranks = Array.from({ length: 10 }, (_, i) => ({ event_id: `e${i}`, trending_rank: i + 1 }))
  const events = ranks.map(row => event(row.event_id, row.trending_rank))
  assert.equal(orderTrendingEvents(ranks, events, Date.parse('2026-11-27T00:00:00.000Z'), 8).length, 8)
})

test('keeps exact safe community counts and drops duplicate or invalid aggregate rows', () => {
  const community = {
    id: 'c1', name: 'Community', slug: 'community', description: 'Public', category: 'Music',
    cover_image: null, location: null, created_at: '2026-01-01T00:00:00Z', member_count: 7,
  }
  const result = normalizeTrendingCommunities([community, community, { ...community, id: 'bad', member_count: -1 }])
  assert.equal(result.length, 1)
  assert.equal(result[0].member_count, 7)
  assert.deepEqual(normalizeTrendingCommunities([]), [])
})
