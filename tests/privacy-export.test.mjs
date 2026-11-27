import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonalExport } from '../supabase/functions/_shared/personal_export.mjs'

const owner = 'user-a'

test('export includes supported owner data and excludes secrets', () => {
  const result = buildPersonalExport(owner, {
    email: 'a@example.invalid', profile: { full_name: 'A User', bio: 'Private' },
    profilePrivacyPreferences: { useInterestsForRecommendations: false, injectedField: 'must-not-export' },
    savedEvents: [{ user_id: owner, event_id: 'event-1', created_at: '2026-01-01', event: { id: 'event-1', title: 'Public', status: 'published', organizer_id: 'organizer-id' } }],
    bookings: [{ user_id: owner, id: 'booking-1', booking_reference: 'NOD-1', status: 'confirmed', total_amount: '20.00', provider_reference: 'must-not-export' }],
    tickets: [{ user_id: owner, holder_user_id: owner, id: 'ticket-1', qr_token: 'must-not-export', status: 'issued', wallet_address: 'must-not-export' }],
    memberships: [{ user_id: owner, community_id: 'community-1', role: 'member', community: { name: 'Public group', email: 'must-not-export' } }],
    collections: [{ id: 'collection-1', user_id: owner, name: 'Saved ideas' }],
    collectionItems: [{ collection_id: 'collection-1', event_id: 'event-1' }],
  }, '2026-11-27T00:00:00Z')

  assert.equal(result.account.email, 'a@example.invalid')
  assert.equal(result.preferences.profilePrivacyPreferences.injectedField, undefined)
  assert.equal(result.savedEvents[0].event.title, 'Public')
  assert.equal(result.collections.collections.length, 1)
  assert.equal(result.collections.items.length, 1)
  assert.equal(result.bookings[0].id, 'booking-1')
  assert.equal(result.tickets[0].id, 'ticket-1')
  assert.equal(result.tickets[0].qr_token, undefined)
  assert.equal(result.tickets[0].wallet_address, undefined)
  assert.equal(result.bookings[0].provider_reference, undefined)
  assert.equal(result.communityMemberships[0].community.email, undefined)
})

test('export filters every private collection by authenticated owner', () => {
  const result = buildPersonalExport(owner, {
    savedEvents: [{ user_id: 'user-b', event_id: 'private-event' }],
    bookings: [{ user_id: 'user-b', id: 'private-booking' }],
    tickets: [{ user_id: 'user-b', holder_user_id: 'user-b', id: 'private-ticket' }],
    memberships: [{ user_id: 'user-b', community_id: 'private-membership' }],
    collections: [{ id: 'private-collection', user_id: 'user-b' }],
    collectionItems: [{ collection_id: 'private-collection', event_id: 'private-event' }],
    reports: [{ reporter_id: 'user-b', id: 'private-report' }],
    deletionRequests: [{ user_id: 'user-b', id: 'private-deletion' }],
  })
  assert.deepEqual(result.savedEvents, [])
  assert.deepEqual(result.bookings, [])
  assert.deepEqual(result.tickets, [])
  assert.deepEqual(result.communityMemberships, [])
  assert.deepEqual(result.collections, { collections: [], items: [] })
  assert.deepEqual(result.privateReports, [])
  assert.deepEqual(result.accountDeletionRequests, [])
})

test('transferred ticket appears only for purchaser or current holder and does not include QR credentials', () => {
  const result = buildPersonalExport(owner, { tickets: [
    { user_id: owner, holder_user_id: 'user-b', id: 'purchased-ticket', qr_token: 'secret' },
    { user_id: 'user-b', holder_user_id: owner, id: 'received-ticket', qr_token: 'secret' },
    { user_id: 'user-b', holder_user_id: 'user-c', id: 'unrelated-ticket', qr_token: 'secret' },
  ] })
  assert.deepEqual(result.tickets.map(ticket => ticket.id), ['purchased-ticket', 'received-ticket'])
  assert.equal(result.tickets[0].currentUserIsHolder, false)
  assert.equal(result.tickets[1].currentUserIsHolder, true)
  assert.ok(result.tickets.every(ticket => !('qr_token' in ticket)))
})

test('unpublished event details are not copied into the personal export', () => {
  const result = buildPersonalExport(owner, { savedEvents: [
    { user_id: owner, event_id: 'draft', event: { id: 'draft', title: 'Draft', status: 'draft', private_note: 'hidden' } },
  ] })
  assert.equal(result.savedEvents[0].event, null)
})
