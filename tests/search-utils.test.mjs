import test from 'node:test'
import assert from 'node:assert/strict'
import { clearDiscoveryFilters, communitySearchFilter, DEFAULT_DISCOVERY_FILTERS, eventSearchFilter, getDiscoverySort, normalizeSearchTerm, readDiscoveryFilters, writeDiscoveryFilters } from '../src/services/searchUtils.ts'

test('global search normalization trims whitespace and bounds query length', () => {
  assert.equal(normalizeSearchTerm('  Lagos  music  '), 'Lagos music')
  assert.equal(normalizeSearchTerm(''), '')
  assert.equal(normalizeSearchTerm('x'.repeat(200)).length, 120)
})

test('global search normalization neutralizes PostgREST filter syntax characters', () => {
  assert.equal(normalizeSearchTerm('jazz, 100% * live (Lagos)'), 'jazz 100 live Lagos')
  assert.equal(normalizeSearchTerm('東京の音楽'), '東京の音楽')
})

test('event and community search use case-insensitive partial-match filters on supported fields', () => {
  assert.equal(eventSearchFilter(' jazz '), 'title.ilike.%jazz%,short_description.ilike.%jazz%,description.ilike.%jazz%,category.ilike.%jazz%,location.ilike.%jazz%,country.ilike.%jazz%')
  assert.equal(communitySearchFilter(' jazz '), 'name.ilike.%jazz%,description.ilike.%jazz%')
  assert.equal(eventSearchFilter(''), '')
  assert.equal(communitySearchFilter(''), '')
})

test('discovery URL restores multiple filters and preserves unrelated query parameters', () => {
  const filters = readDiscoveryFilters('?campaign=spring&q=jazz&category=Music&country=Nigeria&city=Lagos&currency=NGN&from=2026-12-01&to=2026-12-31&price=paid&sort=price')
  assert.deepEqual(filters, {
    query: 'jazz', category: 'Music', country: 'Nigeria', location: 'Lagos', currency: 'NGN',
    dateFrom: '2026-12-01', dateTo: '2026-12-31', price: 'paid', sort: 'price',
  })
  const params = new URLSearchParams(writeDiscoveryFilters('?campaign=spring', filters))
  assert.equal(params.get('campaign'), 'spring')
  assert.equal(params.get('q'), 'jazz')
  assert.equal(params.get('city'), 'Lagos')
  assert.equal(params.get('currency'), 'NGN')
  assert.equal(params.get('sort'), 'price')
})

test('clearing discovery filters removes every discovery parameter', () => {
  const params = new URLSearchParams(writeDiscoveryFilters('?q=jazz&category=Music&country=Nigeria&city=Lagos&currency=NGN&from=2026-12-01&to=2026-12-31&price=free&sort=recent', DEFAULT_DISCOVERY_FILTERS))
  assert.equal(params.has('q'), false)
  assert.equal(params.has('category'), false)
  assert.equal(params.has('country'), false)
  assert.equal(params.has('city'), false)
  assert.equal(params.has('currency'), false)
  assert.equal(params.has('from'), false)
  assert.equal(params.has('to'), false)
  assert.equal(params.has('price'), false)
  assert.equal(params.has('sort'), false)
})

test('clear all filters preserves the current search term', () => {
  const filters = readDiscoveryFilters('?q=jazz&category=Music&city=Lagos&price=paid', ['Music', 'Technology'])
  const cleared = clearDiscoveryFilters(filters)
  assert.equal(cleared.query, 'jazz')
  assert.equal(cleared.category, 'All')
  assert.equal(cleared.location, '')
  assert.equal(cleared.price, 'all')
})

test('URL restoration discards unsupported categories and normalizes unsafe or overlong query terms', () => {
  const restored = readDiscoveryFilters(`?category=Unknown&q=${encodeURIComponent('music,% '.repeat(30))}`, ['Music', 'Technology'])
  assert.equal(restored.category, 'All')
  assert.equal(restored.query.length <= 120, true)
  assert.equal(restored.query.includes(','), false)
})

test('invalid date ranges are discarded and sort modes map to supported columns', () => {
  assert.equal(readDiscoveryFilters('?from=2026-02-31&price=bogus&sort=unsupported').dateFrom, '')
  assert.equal(readDiscoveryFilters('?from=2026-12-20&to=2026-12-01').dateTo, '')
  assert.equal(readDiscoveryFilters('?price=bogus').price, 'all')
  assert.equal(readDiscoveryFilters('?sort=price').sort, 'recommended')
  assert.equal(readDiscoveryFilters('?currency=ngn&sort=price').sort, 'price')
  assert.equal(readDiscoveryFilters('?currency=ngn&sort=price').currency, 'NGN')
  assert.deepEqual(getDiscoverySort('recent'), { column: 'created_at', ascending: false })
  assert.deepEqual(getDiscoverySort('alphabetical'), { column: 'title', ascending: true })
  assert.deepEqual(getDiscoverySort('price'), { column: 'price', ascending: true })
  assert.deepEqual(getDiscoverySort('upcoming'), { column: 'start_date', ascending: true })
})
