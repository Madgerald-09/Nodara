import test from 'node:test'
import assert from 'node:assert/strict'
import { locationSearchFilter, profileLocationTerms, rankNearbyEvents } from '../src/services/nearbyDiscovery.ts'

const event = (id, city, country, startDate, status = 'published') => ({ id, city, country, startDate, status })

test('profile location is split into safe city and country terms for database matching', () => {
  const terms = profileLocationTerms('Lagos, Nigeria')
  assert.deepEqual(terms, ['Lagos', 'Nigeria'])
  assert.equal(locationSearchFilter(terms), 'location.ilike.%Lagos%,country.ilike.%Lagos%,location.ilike.%Nigeria%,country.ilike.%Nigeria%')
  assert.deepEqual(profileLocationTerms(null), [])
})

test('nearby rankings prioritize matching locations and keep only upcoming published events', () => {
  const now = Date.parse('2026-11-27T00:00:00.000Z')
  const ranked = rankNearbyEvents([
    event('country-only', 'Abuja', 'Nigeria', '2026-12-01T00:00:00.000Z'),
    event('city-country', 'Lagos', 'Nigeria', '2026-12-04T00:00:00.000Z'),
    event('past', 'Lagos', 'Nigeria', '2026-11-26T00:00:00.000Z'),
    event('draft', 'Lagos', 'Nigeria', '2026-12-02T00:00:00.000Z', 'draft'),
  ], ['Lagos', 'Nigeria'], now)
  assert.deepEqual(ranked.map(item => item.id), ['city-country', 'country-only'])
})

test('guests without saved locations and empty nearby queries have no fabricated results', () => {
  const events = [event('elsewhere', 'Tokyo', 'Japan', '2026-12-01T00:00:00.000Z')]
  assert.deepEqual(rankNearbyEvents(events, profileLocationTerms(null)), [])
  assert.deepEqual(rankNearbyEvents([], ['Lagos']), [])
})
