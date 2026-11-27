export type ProfilePrivacyPreferences = {
  useInterestsForRecommendations: boolean
  useLocationForNearbyDiscovery: boolean
}

export const defaultProfilePrivacyPreferences: ProfilePrivacyPreferences = {
  // Preserve Phase 8's existing use of explicitly selected interests.
  useInterestsForRecommendations: true,
  useLocationForNearbyDiscovery: true,
}

export function readProfilePrivacyPreferences(value: unknown): ProfilePrivacyPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultProfilePrivacyPreferences }
  const record = value as Record<string, unknown>
  return {
    useInterestsForRecommendations: typeof record.useInterestsForRecommendations === 'boolean'
      ? record.useInterestsForRecommendations
      : defaultProfilePrivacyPreferences.useInterestsForRecommendations,
    useLocationForNearbyDiscovery: typeof record.useLocationForNearbyDiscovery === 'boolean'
      ? record.useLocationForNearbyDiscovery
      : defaultProfilePrivacyPreferences.useLocationForNearbyDiscovery,
  }
}
