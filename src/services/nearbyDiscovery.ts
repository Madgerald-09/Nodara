import { normalizeSearchTerm } from './searchUtils.ts'
import type { EventView } from '../types/database'

export function profileLocationTerms(location: string | null | undefined): string[] {
  if (!location) return []
  return location.split(/[,;/|]+/).map(normalizeSearchTerm).filter(Boolean).slice(0, 3)
}

export function locationSearchFilter(terms: string[]): string {
  return terms.flatMap(term => [`location.ilike.%${term}%`, `country.ilike.%${term}%`]).join(',')
}

export function rankNearbyEvents(events: EventView[], terms: string[], now = Date.now(), limit = 8): EventView[] {
  if (!terms.length) return []
  const tokens = terms.map(term => term.toLocaleLowerCase())
  return events.map((event, index) => {
    const start = Date.parse(event.startDate)
    const city = event.city.toLocaleLowerCase()
    const country = event.country.toLocaleLowerCase()
    const matches = tokens.filter(term => city.includes(term) || country.includes(term)).length
    return { event, index, start, matches }
  }).filter(item => item.event.status === 'published' && Number.isFinite(item.start) && item.start > now && item.matches > 0)
    .sort((a, b) => b.matches - a.matches || a.start - b.start || a.index - b.index)
    .slice(0, Math.max(0, limit)).map(item => item.event)
}
