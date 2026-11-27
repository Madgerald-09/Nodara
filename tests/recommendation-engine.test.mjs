import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInterestCategories, rankRecommendedEvents } from '../src/services/recommendationEngine.ts'

const now = Date.parse('2026-11-27T12:00:00.000Z')
const event = (id, category, startDay, overrides = {}) => ({
  id, title: id, shortDescription: '', category, date: '', city: 'Lagos', country: 'Nigeria', price: 'Free',
  image: '', coverImage: null, tag: category, description: '', address: '', amount: 0, currency: 'NGN',
  status: 'published', startDate: `2026-12-${String(startDay).padStart(2, '0')}T12:00:00.000Z`,
  createdAt: '2026-11-20T12:00:00.000Z', ...overrides,
})
const blankSignals = { interests: [], savedCategories: [], bookedCategories: [], attendedCategories: [], preferredLocation: null, excludedEventIds: [] }

test('selected interests rank matching published events first', () => {
  const ranked = rankRecommendedEvents([
    event('music', 'Music', 4), event('technology', 'Technology', 5), event('art', 'Art & Culture', 3),
  ], { ...blankSignals, interests: ['Technology'] }, now)
  assert.equal(ranked[0].id, 'technology')
})

test('saved, booking, attendance, location, and recency signals affect ranking transparently', () => {
  const candidates = [
    event('saved', 'Music', 5), event('booked', 'Business', 6), event('attended', 'Sports', 7),
    event('near', 'Gaming', 8, { city: 'Lagos', country: 'Nigeria' }),
    event('recent', 'Social', 9, { createdAt: '2026-11-26T12:00:00.000Z' }),
  ]
  const ranked = rankRecommendedEvents(candidates, {
    interests: [], savedCategories: ['Music'], bookedCategories: ['Business'], attendedCategories: ['Sports'],
    preferredLocation: 'Lagos', excludedEventIds: [],
  }, now)
  assert.deepEqual(ranked.slice(0, 3).map(item => item.id), ['attended', 'saved', 'booked'])
})

test('users without interests and signed-out visitors receive general upcoming recommendations', () => {
  const ranked = rankRecommendedEvents([event('later', 'Music', 12), event('sooner', 'Business', 2)], blankSignals, now)
  assert.deepEqual(ranked.map(item => item.id), ['sooner', 'later'])
})

test('already saved, attended, and unpublished events are excluded', () => {
  const ranked = rankRecommendedEvents([
    event('saved', 'Music', 2), event('attended', 'Sports', 3), event('draft', 'Music', 1, { status: 'draft' }), event('available', 'Music', 4),
  ], { ...blankSignals, excludedEventIds: ['saved', 'attended'] }, now)
  assert.deepEqual(ranked.map(item => item.id), ['available'])
})

test('empty candidate lists stay empty and interest persistence normalization removes invalid duplicates', () => {
  assert.deepEqual(rankRecommendedEvents([], blankSignals, now), [])
  assert.deepEqual(normalizeInterestCategories(['Music', 'Music', 'unknown'], ['Music', 'Technology']), ['Music'])
})

test('past and malformed event dates are never recommended', () => {
  const ranked = rankRecommendedEvents([
    event('past', 'Music', 1, { startDate: '2026-11-26T12:00:00.000Z' }),
    event('invalid', 'Music', 2, { startDate: 'not-a-date' }),
    event('future', 'Music', 4),
  ], blankSignals, now)
  assert.deepEqual(ranked.map(item => item.id), ['future'])
})
