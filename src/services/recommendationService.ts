import { supabase } from '../lib/supabase'
import type { EventRow, EventView } from '../types/database'
import { mapEvent } from './eventService'
import { locationSearchFilter, profileLocationTerms, rankNearbyEvents } from './nearbyDiscovery'
import { normalizeInterestCategories, rankRecommendedEvents, type RecommendationSignals } from './recommendationEngine'
import { readProfilePrivacyPreferences } from './profilePrivacyPreferences'

export type RecommendationResult = {
  events: EventView[]
  nearbyEvents: EventView[]
  interests: string[]
  profileLocation: string | null
  nearbyError: string | null
  error: string | null
  activityWarning: boolean
}

const emptySignals = (): RecommendationSignals => ({
  interests: [], savedCategories: [], bookedCategories: [], attendedCategories: [], preferredLocation: null, excludedEventIds: [],
})

export async function loadRecommendedEvents(allowedCategories: string[]): Promise<RecommendationResult> {
  if (!supabase) return { events: [], nearbyEvents: [], interests: [], profileLocation: null, nearbyError: null, error: 'Supabase is not configured.', activityWarning: false }
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) return { events: [], nearbyEvents: [], interests: [], profileLocation: null, nearbyError: null, error: authError.message, activityWarning: false }

  const now = new Date()
  const candidateRequest = supabase.from('events').select('*').eq('status', 'published')
    .gte('start_date', now.toISOString()).order('start_date', { ascending: true }).limit(100)
  if (!authData.user) {
    const { data, error } = await candidateRequest
    if (error) return { events: [], nearbyEvents: [], interests: [], profileLocation: null, nearbyError: null, error: error.message, activityWarning: false }
    return {
      events: rankRecommendedEvents(((data ?? []) as EventRow[]).map(mapEvent), emptySignals(), now.getTime()).slice(0, 8),
      nearbyEvents: [], interests: [], profileLocation: null, nearbyError: null, error: null, activityWarning: false,
    }
  }

  const userId = authData.user.id
  const privacyPreferences = readProfilePrivacyPreferences(authData.user.user_metadata?.profile_privacy_preferences)
  const [profileResult, savedResult, bookingResult, attendanceResult, candidatesResult] = await Promise.all([
    supabase.from('profiles').select('interest_categories, location').eq('id', userId).maybeSingle(),
    supabase.from('saved_events').select('event_id').eq('user_id', userId).limit(100),
    supabase.from('bookings').select('event_id').eq('user_id', userId).eq('status', 'confirmed').limit(100),
    supabase.from('tickets').select('event_id').eq('holder_user_id', userId).eq('status', 'checked_in').limit(100),
    candidateRequest,
  ])

  if (candidatesResult.error) return { events: [], nearbyEvents: [], interests: [], profileLocation: null, nearbyError: null, error: candidatesResult.error.message, activityWarning: false }
  const savedIds = (savedResult.data ?? []).map(row => row.event_id)
  const bookedIds = (bookingResult.data ?? []).map(row => row.event_id)
  const attendedIds = (attendanceResult.data ?? []).map(row => row.event_id)
  const signalIds = [...new Set([...savedIds, ...bookedIds, ...attendedIds])].slice(0, 200)
  const locationTerms = privacyPreferences.useLocationForNearbyDiscovery
    ? profileLocationTerms(profileResult.data?.location)
    : []
  const activityRequest = signalIds.length
    ? supabase.from('events').select('id, category').in('id', signalIds)
    : { data: [], error: null }
  const nearbyRequest = locationTerms.length
    ? supabase.from('events').select('*').eq('status', 'published').gt('start_date', now.toISOString())
      .or(locationSearchFilter(locationTerms)).order('start_date', { ascending: true }).limit(48)
    : Promise.resolve({ data: [], error: null })
  const [activityQuery, nearbyResult] = await Promise.all([activityRequest, nearbyRequest])
  const activityCategories = new Map<string, string>((activityQuery.data ?? []).map(row => [row.id, row.category]))
  const interests = privacyPreferences.useInterestsForRecommendations
    ? normalizeInterestCategories(profileResult.data?.interest_categories ?? [], allowedCategories)
    : []
  const signals: RecommendationSignals = {
    interests,
    savedCategories: savedIds.flatMap(id => activityCategories.has(id) ? [activityCategories.get(id)!] : []),
    bookedCategories: bookedIds.flatMap(id => activityCategories.has(id) ? [activityCategories.get(id)!] : []),
    attendedCategories: attendedIds.flatMap(id => activityCategories.has(id) ? [activityCategories.get(id)!] : []),
    preferredLocation: privacyPreferences.useLocationForNearbyDiscovery ? profileResult.data?.location ?? null : null,
    excludedEventIds: signalIds,
  }
  const events = rankRecommendedEvents(((candidatesResult.data ?? []) as EventRow[]).map(mapEvent), signals, now.getTime()).slice(0, 8)
  const nearbyEvents = rankNearbyEvents(((nearbyResult.data ?? []) as EventRow[]).map(mapEvent), locationTerms, now.getTime())
  return {
    events,
    nearbyEvents,
    interests,
    profileLocation: privacyPreferences.useLocationForNearbyDiscovery ? profileResult.data?.location ?? null : null,
    nearbyError: nearbyResult.error?.message ?? null,
    error: null,
    activityWarning: Boolean(profileResult.error || savedResult.error || bookingResult.error || attendanceResult.error || activityQuery.error),
  }
}

export async function saveRecommendationInterests(categories: string[], allowedCategories: string[]) {
  if (!supabase) return { interests: [] as string[], error: 'Supabase is not configured.' }
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) return { interests: [] as string[], error: authError.message }
  if (!authData.user) return { interests: [] as string[], error: 'Sign in to save your interests.' }
  const interests = normalizeInterestCategories(categories, allowedCategories)
  const { data, error } = await supabase.from('profiles').update({ interest_categories: interests }).eq('id', authData.user.id).select('id').maybeSingle()
  if (error) return { interests, error: error.message }
  return { interests, error: data ? null : 'Profile not found or preference update was not permitted.' }
}
