import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPersonalActivityTimeline,
  getPersonalActivityCounts,
  getPersonalBookingState,
  isConfirmedPersonalBooking,
} from '../src/services/personalActivity.ts'

const booking = (overrides = {}) => ({
  id: 'booking-1', booking_reference: 'NOD-TEST', status: 'confirmed', payment_status: 'verified',
  total_amount: 10, currency: 'USD', expires_at: null, created_at: '2026-01-01T00:00:00.000Z',
  event_id: 'event-1', event_title: 'Verified concert', event_start: '2026-12-10T18:00:00.000Z',
  event_location: 'Lagos', event_cover_image: null, ...overrides,
})

test('only confirmed, verified or free bookings count as confirmed experiences', () => {
  assert.equal(isConfirmedPersonalBooking(booking()), true)
  assert.equal(isConfirmedPersonalBooking(booking({ payment_status: 'not_required' })), true)
  assert.equal(isConfirmedPersonalBooking(booking({ status: 'payment_pending', payment_status: 'pending' })), false)
  assert.equal(isConfirmedPersonalBooking(booking({ status: 'confirmed', payment_status: 'pending' })), false)
})

test('booking state keeps pending, manual review, cancelled and refunds distinct', () => {
  assert.equal(getPersonalBookingState(booking({ status: 'payment_pending', payment_status: 'pending' }), null), 'awaiting_payment')
  assert.equal(getPersonalBookingState(booking({ status: 'payment_pending', payment_status: 'pending' }), {
    booking: { status: 'payment_pending', paymentStatus: 'pending', amount: 10, currency: 'USD', expiresAt: null },
    payment: { id: 'p1', reference: null, amountMinor: 1000, currency: 'USD', status: 'pending', initializationStatus: 'initialized', authorizationUrl: null, fulfillmentStatus: 'pending', createdAt: '', verifiedAt: null, errorCode: null }, refunds: [],
  }), 'awaiting_payment')
  assert.equal(getPersonalBookingState(booking(), {
    booking: { status: 'expired', paymentStatus: 'verified', amount: 10, currency: 'USD', expiresAt: null },
    payment: { id: 'p2', reference: null, amountMinor: 1000, currency: 'USD', status: 'successful', initializationStatus: 'initialized', authorizationUrl: null, fulfillmentStatus: 'manual_review', createdAt: '', verifiedAt: null, errorCode: null }, refunds: [],
  }), 'manual_review')
  assert.equal(getPersonalBookingState(booking({ status: 'cancelled' }), null), 'cancelled')
  assert.equal(getPersonalBookingState(booking(), {
    booking: { status: 'confirmed', paymentStatus: 'verified', amount: 10, currency: 'USD', expiresAt: null },
    payment: { id: 'p3', reference: null, amountMinor: 1000, currency: 'USD', status: 'partially_refunded', initializationStatus: 'initialized', authorizationUrl: null, fulfillmentStatus: 'fulfilled', createdAt: '', verifiedAt: null, errorCode: null }, refunds: [],
  }), 'partially_refunded')
})

test('counts exclude pending reservations from upcoming and past experiences', () => {
  const counts = getPersonalActivityCounts({
    bookings: [
      booking({ id: 'future', event_start: '2026-12-01T00:00:00.000Z' }),
      booking({ id: 'past', event_start: '2026-01-01T00:00:00.000Z' }),
      booking({ id: 'pending', status: 'payment_pending', payment_status: 'pending', event_start: '2026-12-01T00:00:00.000Z' }),
    ], savedCount: 2, collectionCount: 1, ticketCount: 1, communityCount: 3,
  }, Date.parse('2026-06-01T00:00:00.000Z'))
  assert.deepEqual(counts, { upcoming: 1, past: 1, pending: 1, saved: 2, collections: 1, tickets: 1, communities: 3 })
})

test('experience counts require a current ticket when that access evidence is supplied', () => {
  const counts = getPersonalActivityCounts({
    bookings: [booking({ id: 'future', booking_reference: 'NOD-FUTURE', event_start: '2026-12-01T00:00:00.000Z' })],
    currentTicketBookingReferences: [], savedCount: 0, collectionCount: 0, ticketCount: 0, communityCount: 0,
  }, Date.parse('2026-06-01T00:00:00.000Z'))
  assert.equal(counts.upcoming, 0)
})

test('activity timeline is chronological, skips invalid timestamps and does not attribute transferred-in ticket issuance', () => {
  const items = buildPersonalActivityTimeline({
    userId: 'user-1',
    savedEvents: [{ event: { id: 'event-1', slug: 'concert', title: 'Concert' }, savedAt: '2026-02-01T00:00:00.000Z' }],
    bookings: [booking({ created_at: '2026-01-02T00:00:00.000Z', event_title: 'Concert' })],
    tickets: [
      { ticket_id: 'ticket-own', ticket_status: 'issued', created_at: '2026-01-03T00:00:00.000Z', ticket_type: 'GA', event_title: 'Concert' },
      { ticket_id: 'ticket-transfer', ticket_status: 'issued', created_at: '2025-12-01T00:00:00.000Z', ticket_type: 'GA', event_title: 'Concert' },
      { ticket_id: 'ticket-checked', ticket_status: 'checked_in', created_at: '2026-01-04T00:00:00.000Z', ticket_type: 'GA', event_title: 'Concert' },
    ],
    ticketMetadata: [
      { id: 'ticket-own', user_id: 'user-1', status: 'issued', checked_in_at: null, created_at: '2026-01-03T00:00:00.000Z' },
      { id: 'ticket-transfer', user_id: 'previous-owner', status: 'issued', checked_in_at: null, created_at: '2025-12-01T00:00:00.000Z' },
      { id: 'ticket-checked', user_id: 'user-1', status: 'checked_in', checked_in_at: '2026-02-03T00:00:00.000Z', created_at: '2026-01-04T00:00:00.000Z' },
    ],
    checkins: [],
    memberships: [{ community_id: 'community-1', role: 'member', joined_at: '2026-01-01T00:00:00.000Z', community: { id: 'community-1', name: 'Local arts', slug: 'local-arts', category: 'Arts', location: null, cover_image: null } }],
  }, 20)
  assert.equal(items[0].kind, 'checkin')
  assert.equal(items[0].occurredAt, '2026-02-03T00:00:00.000Z')
  assert.deepEqual(items.map(item => item.kind), ['checkin', 'saved', 'ticket', 'ticket', 'booking', 'community'])
  assert.equal(items.some(item => item.id === 'ticket:ticket-transfer'), false)
  assert.equal(buildPersonalActivityTimeline({ userId: 'u', savedEvents: [], bookings: [], tickets: [], ticketMetadata: [], checkins: [], memberships: [] }, 20).length, 0)
})
