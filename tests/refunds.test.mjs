import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentFlowError } from '../supabase/functions/_shared/paystack.ts'
import {
  calculateRefundAmount,
  mapPaystackRefundStatus,
  processPaystackRefundWebhook,
  validatePaystackRefund,
} from '../supabase/functions/_shared/refunds.ts'

const actor = 'customer-1'
const ticket = (overrides = {}) => ({
  id: 'ticket-1', status: 'issued', blockchainStatus: 'off_chain', holderUserId: actor,
  unitPriceMinor: 2500, currency: 'NGN', checkedIn: false, transferred: false, ...overrides,
})
const plan = (overrides = {}) => calculateRefundAmount({
  paymentStatus: 'successful', paymentAmountMinor: 5000, paymentCurrency: 'NGN',
  requesterId: actor, bookingOwnerId: actor, organizerId: 'organizer-1',
  ticketIds: ['ticket-1'], tickets: [ticket()], alreadyReservedMinor: 0, ...overrides,
})

test('full and partial refunds are calculated from selected stored ticket prices', () => {
  assert.deepEqual(plan(), { amountMinor: 2500, currency: 'NGN', ticketIds: ['ticket-1'] })
  const full = calculateRefundAmount({
    paymentStatus: 'successful', paymentAmountMinor: 5000, paymentCurrency: 'NGN',
    requesterId: actor, bookingOwnerId: actor, organizerId: 'organizer-1',
    ticketIds: ['ticket-1', 'ticket-2'], tickets: [ticket(), ticket({ id: 'ticket-2' })], alreadyReservedMinor: 0,
  })
  assert.equal(full.amountMinor, 5000)
})

test('duplicate ticket selections and excessive refunds are rejected', () => {
  assert.throws(() => plan({ ticketIds: ['ticket-1', 'ticket-1'] }), PaymentFlowError)
  assert.throws(() => plan({ alreadyReservedMinor: 3000 }), error => error.errorCode === 'REFUND_BALANCE_EXCEEDED')
})

test('checked-in, transferred and on-chain tickets are ineligible', () => {
  assert.throws(() => plan({ tickets: [ticket({ status: 'checked_in', checkedIn: true })] }), error => error.errorCode === 'REFUND_TICKET_USED')
  assert.throws(() => plan({ tickets: [ticket({ transferred: true })] }), error => error.errorCode === 'REFUND_TICKET_TRANSFERRED')
  assert.throws(() => plan({ tickets: [ticket({ blockchainStatus: 'verified' })] }), error => error.errorCode === 'REFUND_ONCHAIN_INVALIDATION_REQUIRED')
})

test('organiser may request eligible ticket refunds, but another user may not', () => {
  assert.equal(plan({ requesterId: 'organizer-1' }).amountMinor, 2500)
  assert.throws(() => plan({ requesterId: 'other-user' }), error => error.errorCode === 'REFUND_ACCESS_DENIED')
})

test('Paystack provider states map to safe internal states', () => {
  assert.equal(mapPaystackRefundStatus('processed'), 'succeeded')
  assert.equal(mapPaystackRefundStatus('failed'), 'failed')
  assert.equal(mapPaystackRefundStatus('needs-attention'), 'processing')
  assert.equal(mapPaystackRefundStatus('pending'), 'processing')
  assert.throws(() => mapPaystackRefundStatus('unknown'), error => error.errorCode === 'REFUND_STATUS_UNKNOWN')
})

test('refund identity, transaction, amount and currency must all match Paystack', () => {
  const expected = { refundReference: 'rf_abcdefgh123456', transactionId: '987654', amountMinor: 2500, currency: 'NGN' }
  assert.deepEqual(validatePaystackRefund({ id: 77, domain: 'test', reference: expected.refundReference, transaction: 987654, amount: 2500, currency: 'NGN', status: 'processed' }, expected), {
    providerRefundId: '77', providerStatus: 'processed',
  })
  for (const changed of [
    { reference: 'rf_anotherref12345' }, { transaction: 12 }, { amount: 2000 }, { currency: 'USD' },
  ]) {
    assert.throws(() => validatePaystackRefund({ id: 77, domain: 'test', reference: expected.refundReference, transaction: 987654,
      amount: 2500, currency: 'NGN', status: 'processed', ...changed }, expected), PaymentFlowError)
  }
  assert.throws(() => validatePaystackRefund({ id: 77, domain: 'live', reference: expected.refundReference,
    transaction: 987654, amount: 2500, currency: 'NGN', status: 'processed' }, expected),
  error => error.errorCode === 'REFUND_DOMAIN_MISMATCH')
})

test('duplicate refund webhooks do not finalize twice', async () => {
  const handled = new Set()
  let finalized = 0
  const deps = {
    async claimEvent(id) { if (handled.has(id)) return 'already_handled'; handled.add(id); return 'claimed' },
    async setEventPayment() {},
    async loadRefund() { return { id: 'refund-1', refund_reference: 'rf_abcdefgh123456', provider_refund_id: null,
      payment_id: 'payment-1', amount_minor: 2500, currency: 'NGN', status: 'processing',
      payment: { provider_reference: 'charge-ref', provider_transaction_id: '987654' } } },
    async retrieveRefund() { return [{ id: 77, domain: 'test', reference: 'rf_abcdefgh123456', transaction: 987654,
      amount: 2500, currency: 'NGN', status: 'processed' }] },
    async finalize() { finalized++ }, async finishEvent() {},
  }
  const payload = { event: 'refund.processed', data: { refund_reference: 'rf_abcdefgh123456',
    transaction_reference: 'charge-ref', amount: '2500', currency: 'NGN' } }
  assert.equal(await processPaystackRefundWebhook(payload, deps), 'processed')
  assert.equal(await processPaystackRefundWebhook(payload, deps), 'duplicate')
  assert.equal(finalized, 1)
})

test('verification failures are retryable and do not report success', async () => {
  let eventStatus = ''
  let attempt = 0
  const deps = {
    async claimEvent() { return 'claimed' }, async setEventPayment() {},
    async loadRefund() { return { id: 'refund-1', refund_reference: 'rf_abcdefgh123456', provider_refund_id: null,
      payment_id: 'payment-1', amount_minor: 2500, currency: 'NGN', status: 'processing',
      payment: { provider_reference: 'charge-ref', provider_transaction_id: '987654' } } },
    async retrieveRefund() { attempt++; if (attempt === 1) throw new Error('temporary provider outage'); return [{ id: 77,
      domain: 'test', reference: 'rf_abcdefgh123456', transaction: 987654, amount: 2500, currency: 'NGN', status: 'processing' }] },
    async finalize(input) { eventStatus = input.providerStatus },
    async finishEvent(_id, status) { if (status === 'failed') eventStatus = 'failed_event' },
  }
  const payload = { event: 'refund.processing', data: { refund_reference: 'rf_abcdefgh123456',
    transaction_reference: 'charge-ref', amount: '2500', currency: 'NGN' } }
  await assert.rejects(processPaystackRefundWebhook(payload, deps), error => error.errorCode === 'REFUND_VERIFY_FAILED')
  assert.equal(eventStatus, 'failed_event')
  assert.equal(await processPaystackRefundWebhook(payload, deps), 'processed')
  assert.equal(eventStatus, 'processing')
})
