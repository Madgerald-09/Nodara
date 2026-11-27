import type { EventView } from '../types/database'

export type RecommendationSignals = {
  interests: string[]
  savedCategories: string[]
  bookedCategories: string[]
  attendedCategories: string[]
  preferredLocation: string | null
  excludedEventIds: string[]
}

export function normalizeInterestCategories(categories: string[], allowedCategories: string[]): string[] {
  const allowed = new Set(allowedCategories)
  return Array.from(new Set(categories.filter(category => allowed.has(category)))).slice(0, allowed.size)
}

export function rankRecommendedEvents(events: EventView[], signals: RecommendationSignals, now = Date.now()): EventView[] {
  const excluded = new Set(signals.excludedEventIds)
  const interests = new Set(signals.interests)
  const savedCategories = new Set(signals.savedCategories)
  const bookedCategories = new Set(signals.bookedCategories)
  const attendedCategories = new Set(signals.attendedCategories)
  const preferredLocations = signals.preferredLocation?.toLocaleLowerCase().split(/[,;/]+/).map(part => part.trim()).filter(Boolean) ?? []

  return events
    .filter(event => event.status === 'published' && !excluded.has(event.id)
      && Number.isFinite(Date.parse(event.startDate)) && Date.parse(event.startDate) > now)
    .map((event, index) => {
      let score = 0
      if (interests.has(event.category)) score += 8
      if (savedCategories.has(event.category)) score += 5
      if (bookedCategories.has(event.category)) score += 4
      if (attendedCategories.has(event.category)) score += 6
      const eventLocation = `${event.city} ${event.country}`.toLocaleLowerCase()
      if (preferredLocations.some(location => eventLocation.includes(location) || location.split(/\s+/).some(part => part.length >= 3 && eventLocation.includes(part)))) score += 2

      const createdAt = Date.parse(event.createdAt)
      if (Number.isFinite(createdAt)) {
        const ageDays = Math.max(0, (now - createdAt) / 86_400_000)
        score += Math.max(0, 2 - ageDays / 30)
      }
      const startDate = Date.parse(event.startDate)
      return { event, score, index, startDate: Number.isFinite(startDate) ? startDate : Number.MAX_SAFE_INTEGER }
    })
    .sort((a, b) => b.score - a.score || a.startDate - b.startDate || a.index - b.index)
    .map(item => item.event)
}
