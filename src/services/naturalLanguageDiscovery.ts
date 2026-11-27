import type { EventFilters } from './eventService'

const categories = ['Technology', 'Music', 'Business', 'Art & Culture', 'Sports', 'Gaming', 'Education', 'Adventure', 'Social']
const isoDay = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (date: Date, amount: number) => { const next = new Date(date); next.setUTCDate(next.getUTCDate() + amount); return next }

export function parseNaturalLanguageDiscovery(input: string, now = new Date()): EventFilters {
  const original = input.trim()
  if (!original || original.length > 240) return { sort: 'upcoming' }
  let remaining = original.toLowerCase()
  const filters: EventFilters = { sort: 'upcoming' }
  const category = categories.find(item => new RegExp(`\\b${item.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(remaining))
  if (category) {
    filters.category = category
    remaining = remaining.replace(new RegExp(`\\b${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i'), ' ')
  }
  if (/\bfree\b/.test(remaining)) { filters.price = 'free'; remaining = remaining.replace(/\bfree\b/g, ' ') }
  else if (/\b(paid|ticketed)\b/.test(remaining)) { filters.price = 'paid'; remaining = remaining.replace(/\b(paid|ticketed)\b/g, ' ') }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (/\bthis\s+weekend\b/.test(remaining)) {
    const toSaturday = (6 - today.getUTCDay() + 7) % 7 || 7
    const saturday = addDays(today, toSaturday)
    filters.dateFrom = isoDay(saturday); filters.dateTo = isoDay(addDays(saturday, 1))
    remaining = remaining.replace(/\bthis\s+weekend\b/g, ' ')
  } else if (/\bnext\s+month\b/.test(remaining)) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    filters.dateFrom = isoDay(first); filters.dateTo = isoDay(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)))
    remaining = remaining.replace(/\bnext\s+month\b/g, ' ')
  } else if (/\bthis\s+month\b/.test(remaining)) {
    filters.dateFrom = isoDay(today); filters.dateTo = isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)))
    remaining = remaining.replace(/\bthis\s+month\b/g, ' ')
  } else if (/\bnext\s+week\b/.test(remaining)) {
    filters.dateFrom = isoDay(addDays(today, 7)); filters.dateTo = isoDay(addDays(today, 13))
    remaining = remaining.replace(/\bnext\s+week\b/g, ' ')
  } else if (/\b(today|tomorrow|upcoming|coming\s+up|next\s+events?)\b/.test(remaining)) {
    if (/\btomorrow\b/.test(remaining)) filters.dateFrom = filters.dateTo = isoDay(addDays(today, 1))
    remaining = remaining.replace(/\b(today|tomorrow|upcoming|coming\s+up|next\s+events?)\b/g, ' ')
  }
  const locationMatch = remaining.match(/\b(?:in|near|around|from)\s+([\p{L}][\p{L}\s'-]{1,48}?)(?=\s+(?:next|this|today|tomorrow|free|paid|for)\b|[,.!?]|$)/iu)
  if (locationMatch) {
    filters.location = locationMatch[1].trim()
    remaining = remaining.replace(locationMatch[0], ' ')
  }
  const query = remaining.replace(/\b(find|show|search|list|tell me|what|are|the|events?|experiences?|available|please|in|near|around|from|for)\b/gi, ' ').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (query) filters.query = query.slice(0, 120)
  return filters
}

export function buildGroundedDiscoveryAnswer(events: Array<{ title: string; city: string; country: string; price: string; startDate: string }>, filters: EventFilters) {
  if (!events.length) return 'I could not find published events matching those filters. Try a broader location, category, or date range.'
  const intro = `I found ${events.length} published event${events.length === 1 ? '' : 's'}${filters.category ? ` in ${filters.category}` : ''}${filters.location ? ` near ${filters.location}` : ''}.`
  const items = events.slice(0, 4).map(event => {
    const when = event.startDate && Number.isFinite(new Date(event.startDate).getTime()) ? new Date(event.startDate).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) : 'date not listed'
    const place = [event.city, event.country].filter(Boolean).join(', ') || 'location not listed'
    const price = event.price || 'price not listed'
    return `${event.title}: ${when}, ${place}, ${price}.`
  })
  return `${intro} ${items.join(' ')}`
}
