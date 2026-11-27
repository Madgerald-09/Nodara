import test from 'node:test'
import assert from 'node:assert/strict'
import { startBookingCheckout } from '../src/services/checkoutFlow.ts'
import { canShowTicketQr, findPaymentBooking, getPaymentViewState, isDisplayableTicket, rememberPaymentBooking } from '../src/services/paymentPresentation.ts'
import { createSingleFlightGate } from '../src/services/singleFlightGate.ts'

const freeBooking = { booking_id: 'free-id', booking_reference: 'F-1', status: 'confirmed', payment_status: 'not_required', total_amount: 0, currency: 'NGN', expires_at: null, ticket_count: 1 }
const paidBooking = { ...freeBooking, booking_id: 'paid-id', booking_reference: 'P-1', status: 'payment_pending', payment_status: 'pending', total_amount: 1200, ticket_count: 0 }
const payment = { authorizationUrl: 'https://checkout.paystack.com/test', reference: 'pay-ref', amountMinor: 120000, currency: 'NGN', idempotent: false }
const storage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

function status(overrides = {}) {
  return { booking: { id: 'b1', status: 'payment_pending', paymentStatus: 'pending', amount: '12', currency: 'NGN', expiresAt: null }, payment: null, ...overrides }
}

test('free booking stays on existing confirmed path and never initializes checkout', async () => {
  let initialized = false
  const result = await startBookingCheckout('event', [], {
    createBooking: async () => ({ booking: freeBooking, error: null }),
    initializePayment: async () => { initialized = true; return { payment, error: null } },
    rememberBooking() {}, redirect() {},
  })
  assert.equal(result.kind, 'confirmed')
  assert.equal(initialized, false)
})

test('paid booking initializes and redirects to the trusted checkout URL', async () => {
  const calls = []
  const result = await startBookingCheckout('event', [], {
    createBooking: async () => ({ booking: paidBooking, error: null }),
    initializePayment: async bookingId => { calls.push(['initialize', bookingId]); return { payment, error: null } },
    rememberBooking: (...args) => calls.push(['remember', ...args]),
    redirect: url => calls.push(['redirect', url]),
  })
  assert.equal(result.kind, 'redirecting')
  assert.deepEqual(calls, [['initialize', 'paid-id'], ['remember', 'pay-ref', 'paid-id'], ['redirect', payment.authorizationUrl]])
})

test('failed initialization preserves the pending booking for a retry', async () => {
  const result = await startBookingCheckout('event', [], {
    createBooking: async () => ({ booking: paidBooking, error: null }),
    initializePayment: async () => ({ payment: null, error: 'backend unavailable' }),
    rememberBooking() {}, redirect() {},
  })
  assert.equal(result.kind, 'initialization_failed')
  assert.equal(result.booking.booking_id, 'paid-id')
  assert.match(result.error, /backend unavailable/)
})

test('checkout rejects non Paystack or non HTTPS redirects', async () => {
  const result = await startBookingCheckout('event', [], {
    createBooking: async () => ({ booking: paidBooking, error: null }),
    initializePayment: async () => ({ payment: { ...payment, authorizationUrl: 'http://attacker.example/checkout' }, error: null }),
    rememberBooking() {}, redirect() { assert.fail('must not redirect') },
  })
  assert.equal(result.kind, 'initialization_failed')
})

test('callback reference maps to a booking but does not establish payment success', () => {
  const local = storage()
  rememberPaymentBooking('callback-ref', 'booking-1', local)
  assert.equal(findPaymentBooking('callback-ref', local), 'booking-1')
  assert.equal(getPaymentViewState(null), 'processing')
})

test('pending callback remains processing until backend confirms fulfillment', () => {
  assert.equal(getPaymentViewState(status()), 'awaiting_payment')
  assert.equal(getPaymentViewState(status({ payment: { status: 'successful', initializationStatus: 'initialized', fulfillmentStatus: 'pending' } })), 'processing')
  assert.equal(getPaymentViewState(status({ booking: { id: 'b1', status: 'confirmed', paymentStatus: 'verified' }, payment: { status: 'successful', fulfillmentStatus: 'fulfilled' } })), 'confirmed')
})

test('expired and manual-review states are surfaced separately', () => {
  assert.equal(getPaymentViewState(status({ booking: { id: 'b1', status: 'expired', paymentStatus: 'pending' } })), 'expired')
  assert.equal(getPaymentViewState(status({ payment: { status: 'successful', fulfillmentStatus: 'manual_review' } })), 'manual_review')
})

test('failed and refunded payments receive distinct presentation states', () => {
  assert.equal(getPaymentViewState(status({ payment: { status: 'failed' } })), 'failed')
  assert.equal(getPaymentViewState(status({ payment: { status: 'refunded' } })), 'refunded')
  assert.equal(getPaymentViewState(status({ payment: { status: 'partially_refunded' } })), 'partially_refunded')
})

test('duplicate checkout clicks are rejected while one booking action is in flight', async () => {
  const gate = createSingleFlightGate()
  assert.equal(gate.tryEnter(), true)
  assert.equal(gate.tryEnter(), false)
  gate.release()
  assert.equal(gate.tryEnter(), true)
  gate.release()
})

test('My Tickets only shows issued, checked-in, confirmed and paid-or-free tickets', () => {
  const ticket = { booking_status: 'confirmed', payment_status: 'verified', ticket_status: 'issued' }
  assert.equal(isDisplayableTicket(ticket), true)
  assert.equal(isDisplayableTicket({ ...ticket, payment_status: 'pending' }), false)
  assert.equal(isDisplayableTicket({ ...ticket, ticket_status: 'cancelled' }), false)
  assert.equal(isDisplayableTicket({ ...ticket, booking_status: 'payment_pending' }), false)
  assert.equal(isDisplayableTicket({ ...ticket, payment_status: 'not_required' }), true)
})

test('ticket QR waits for trusted payment state and is hidden during an active refund', () => {
  const ticket = { ticket_id: 'ticket-1', booking_status: 'confirmed', payment_status: 'verified', ticket_status: 'issued' }
  const paidStatus = { booking: { status: 'confirmed', paymentStatus: 'verified' },
    payment: { status: 'successful', fulfillmentStatus: 'fulfilled' }, refunds: [] }
  assert.equal(canShowTicketQr(ticket, null), false)
  assert.equal(canShowTicketQr(ticket, paidStatus), true)
  assert.equal(canShowTicketQr(ticket, { ...paidStatus, refunds: [{ status: 'processing', ticketIds: ['ticket-1'] }] }), false)
  assert.equal(canShowTicketQr(ticket, { ...paidStatus, refunds: [{ status: 'succeeded', ticketIds: ['ticket-1'] }] }), false)
  assert.equal(canShowTicketQr(ticket, { ...paidStatus, refunds: [{ status: 'failed', ticketIds: ['ticket-1'] }] }), true)
  assert.equal(canShowTicketQr({ ...ticket, payment_status: 'not_required' }, null), true)
  assert.equal(canShowTicketQr({ ...ticket, ticket_status: 'checked_in' }, paidStatus), false)
})
