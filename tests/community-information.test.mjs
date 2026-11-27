import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicCommunityAnnouncement, isSafeCommunityHttpsUrl } from '../src/services/communityAnnouncementPolicy.ts'

const now = Date.parse('2026-11-27T12:00:00.000Z')

test('only published announcements whose publish time has arrived are public', () => {
  assert.equal(isPublicCommunityAnnouncement({ status: 'published', published_at: '2026-11-27T11:59:00Z' }, now), true)
  assert.equal(isPublicCommunityAnnouncement({ status: 'scheduled', published_at: '2026-11-27T11:59:00Z' }, now), false)
  assert.equal(isPublicCommunityAnnouncement({ status: 'published', published_at: '2026-11-27T12:01:00Z' }, now), false)
  assert.equal(isPublicCommunityAnnouncement({ status: 'published', published_at: null }, now), false)
  assert.equal(isPublicCommunityAnnouncement({ status: 'archived', published_at: '2026-11-27T11:00:00Z' }, now), false)
})

test('official external links require HTTPS and reject embedded credentials', () => {
  assert.equal(isSafeCommunityHttpsUrl('https://community.example.org/rules'), true)
  assert.equal(isSafeCommunityHttpsUrl('http://community.example.org'), false)
  assert.equal(isSafeCommunityHttpsUrl('javascript:alert(1)'), false)
  assert.equal(isSafeCommunityHttpsUrl('https://user:pass@community.example.org'), false)
})
