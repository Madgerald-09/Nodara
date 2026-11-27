import { supabase } from '../lib/supabase'
import { normalizeInterestCategories } from './recommendationEngine'

export const profileInterestCategories = [
  'Technology', 'Music', 'Business', 'Art & Culture', 'Sports',
  'Gaming', 'Education', 'Adventure', 'Social',
] as const

export type OwnProfile = {
  id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
  bio: string | null
  location: string | null
  interest_categories: string[]
  interestsAvailable: boolean
}

export type OwnProfileInput = {
  full_name: string
  username: string
  avatar_url: string
  bio: string
  location: string
  interest_categories: string[]
}

function unavailable() { return new Error('Supabase is not configured.') }

async function getOwnUser() {
  if (!supabase) return { user: null, error: unavailable() }
  const { data, error } = await supabase.auth.getUser()
  return { user: data.user, error }
}

export async function fetchOwnProfile() {
  const { user, error: authError } = await getOwnUser()
  if (!user || authError) return { profile: null as OwnProfile | null, error: authError ?? new Error('Sign in to view profile settings.') }

  const { data, error } = await supabase!.from('profiles')
    .select('id,full_name,username,avatar_url,bio,location')
    .eq('id', user.id)
    .maybeSingle()
  if (error) return { profile: null, error }
  if (!data) return { profile: null, error: new Error('Your profile is not available yet. Try again shortly.') }

  const { data: interestsData, error: interestsError } = await supabase!.from('profiles')
    .select('interest_categories')
    .eq('id', user.id)
    .maybeSingle()
  if (interestsError && interestsError.code !== '42703' && interestsError.code !== 'PGRST204') {
    return { profile: null, error: interestsError }
  }
  const interestsAvailable = !interestsError
  return {
    profile: {
      ...data,
      interest_categories: interestsData?.interest_categories ?? [],
      interestsAvailable,
    } as OwnProfile,
    error: null,
    interestsNotice: interestsError ? 'Interest preferences are unavailable until the profile interest migration is installed.' : null,
  }
}

export async function saveOwnProfile(input: OwnProfileInput, interestsAvailable: boolean) {
  const { user, error: authError } = await getOwnUser()
  if (!user || authError) return { error: authError ?? new Error('Sign in to save profile settings.') }
  if (!input.full_name.trim() || input.full_name.trim().length > 120) return { error: new Error('Display name is required and must be 120 characters or fewer.') }
  if (input.username && !/^[a-z0-9_]{3,30}$/.test(input.username)) return { error: new Error('Username must be 3–30 lowercase letters, numbers, or underscores.') }
  if (input.bio.length > 500 || input.location.length > 160) return { error: new Error('Biography or location is too long.') }
  if (input.avatar_url) {
    try {
      const url = new URL(input.avatar_url)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    } catch {
      return { error: new Error('Profile image URL must be a valid HTTPS URL without embedded credentials.') }
    }
  }
  if (!supabase) return { error: unavailable() }

  const patch: Record<string, unknown> = {
    full_name: input.full_name.trim(),
    username: input.username || null,
    avatar_url: input.avatar_url || null,
    bio: input.bio.trim() || null,
    location: input.location.trim() || null,
  }
  if (interestsAvailable) patch.interest_categories = normalizeInterestCategories([...input.interest_categories], [...profileInterestCategories])
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', user.id).select('id').maybeSingle()
  if (error) return { error }
  if (!data) return { error: new Error('Profile update was not permitted. Refresh and try again.') }
  return { error: null }
}

export async function saveOwnPrivacyPreferences(preferences: { useInterestsForRecommendations: boolean; useLocationForNearbyDiscovery: boolean }) {
  const { user, error } = await getOwnUser()
  if (!user || error) return { error: error ?? new Error('Sign in to save privacy preferences.') }
  if (!supabase) return { error: unavailable() }
  const { error: updateError } = await supabase.auth.updateUser({ data: { profile_privacy_preferences: preferences } })
  return { error: updateError }
}
