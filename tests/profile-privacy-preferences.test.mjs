import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultProfilePrivacyPreferences, readProfilePrivacyPreferences } from '../src/services/profilePrivacyPreferences.ts'

test('missing privacy metadata preserves existing personal recommendation behavior', () => {
  assert.deepEqual(readProfilePrivacyPreferences(undefined), defaultProfilePrivacyPreferences)
})

test('valid opt-out choices are read independently', () => {
  assert.deepEqual(readProfilePrivacyPreferences({
    useInterestsForRecommendations: false,
    useLocationForNearbyDiscovery: true,
  }), {
    useInterestsForRecommendations: false,
    useLocationForNearbyDiscovery: true,
  })
})

test('invalid metadata fields fall back to safe defaults', () => {
  assert.deepEqual(readProfilePrivacyPreferences({
    useInterestsForRecommendations: 'yes',
    useLocationForNearbyDiscovery: false,
    publicProfile: true,
  }), {
    useInterestsForRecommendations: true,
    useLocationForNearbyDiscovery: false,
  })
})
