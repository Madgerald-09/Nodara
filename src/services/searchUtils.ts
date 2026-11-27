/** Normalize user input before interpolating it into PostgREST's .or() filter syntax. */
export function normalizeSearchTerm(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function eventSearchFilter(value: string): string {
  const term = normalizeSearchTerm(value)
  return term ? ['title', 'short_description', 'description', 'category', 'location', 'country']
    .map(column => `${column}.ilike.%${term}%`).join(',') : ''
}

export function communitySearchFilter(value: string): string {
  const term = normalizeSearchTerm(value)
  return term ? ['name', 'description'].map(column => `${column}.ilike.%${term}%`).join(',') : ''
}

export type DiscoverySort = 'recommended' | 'upcoming' | 'recent' | 'alphabetical' | 'price'
export type DiscoveryPrice = 'all' | 'free' | 'paid'

export type DiscoveryFilters = {
  query: string
  category: string
  country: string
  location: string
  currency: string
  dateFrom: string
  dateTo: string
  price: DiscoveryPrice
  sort: DiscoverySort
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  query: '', category: 'All', country: '', location: '', currency: '', dateFrom: '', dateTo: '', price: 'all', sort: 'recommended',
}

export function clearDiscoveryFilters(filters: DiscoveryFilters): DiscoveryFilters {
  return { ...DEFAULT_DISCOVERY_FILTERS, query: filters.query }
}

const discoveryKeys = ['q', 'category', 'country', 'city', 'currency', 'from', 'to', 'price', 'sort'] as const

function readDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : ''
}

export function readDiscoveryFilters(search: string, allowedCategories?: string[]): DiscoveryFilters {
  const params = new URLSearchParams(search)
  const price = params.get('price')
  const sort = params.get('sort')
  const currency = (params.get('currency') ?? '').trim().toUpperCase()
  const parsedSort = sort === 'upcoming' || sort === 'recent' || sort === 'alphabetical' || sort === 'price' ? sort : 'recommended'
  const dateFrom = readDate(params.get('from'))
  const parsedDateTo = readDate(params.get('to'))
  return {
    query: normalizeSearchTerm(params.get('q') ?? ''),
    category: (() => {
      const value = (params.get('category') ?? 'All').slice(0, 60)
      return value === 'All' || !allowedCategories || allowedCategories.includes(value) ? value : 'All'
    })(),
    country: (params.get('country') ?? '').trim().slice(0, 100),
    location: (params.get('city') ?? '').trim().slice(0, 180),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : '',
    dateFrom,
    dateTo: dateFrom && parsedDateTo && parsedDateTo < dateFrom ? '' : parsedDateTo,
    price: price === 'free' || price === 'paid' ? price : 'all',
    sort: parsedSort === 'price' && !/^[A-Z]{3}$/.test(currency) ? 'recommended' : parsedSort,
  }
}

export function writeDiscoveryFilters(search: string, filters: DiscoveryFilters): string {
  const params = new URLSearchParams(search)
  for (const key of discoveryKeys) params.delete(key)
  const query = normalizeSearchTerm(filters.query)
  if (query) params.set('q', query)
  if (filters.category !== 'All') params.set('category', filters.category)
  if (filters.country.trim()) params.set('country', filters.country.trim())
  if (filters.location.trim()) params.set('city', filters.location.trim())
  if (/^[A-Z]{3}$/.test(filters.currency)) params.set('currency', filters.currency)
  if (filters.dateFrom) params.set('from', filters.dateFrom)
  if (filters.dateTo) params.set('to', filters.dateTo)
  if (filters.price !== 'all') params.set('price', filters.price)
  if (filters.sort !== 'recommended') params.set('sort', filters.sort)
  return params.toString()
}

export function getDiscoverySort(sort: DiscoverySort): { column: 'start_date' | 'created_at' | 'title' | 'price'; ascending: boolean } {
  if (sort === 'recent') return { column: 'created_at', ascending: false }
  if (sort === 'alphabetical') return { column: 'title', ascending: true }
  if (sort === 'price') return { column: 'price', ascending: true }
  return { column: 'start_date', ascending: true }
}

