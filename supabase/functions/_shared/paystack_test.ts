import { processPaystackWebhook, type PaymentForWebhook, type PaystackWebhookPayload, type WebhookDependencies } from './payment_webhook.ts'
import { initializeBookingPayment } from './payment_initialization.ts'
import {
  PaymentFlowError,
  verifyPaystackSignature,
  type BookingForPayment,
  type PaystackTransaction,
  type PendingPayment,
} from './paystack.ts'

const NOW = Date.parse('2026-11-27T12:00:00.000Z')
const BOOKING_ID = 'a0000000-0000-4000-8000-000000000001'
const USER_ID = 'a0000000-0000-4000-8000-000000000002'
const REF = 'NOD-TEST-REFERENCE'
const GENERATED_REF = 'NOD-00000000000040008000000000000001'

Deno.test('Paystack initialization derives amount and currency from booking data', async () => {
  let providerCalls = 0
  const result = await initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', {
    ...initDependencies(),
    async initializeProvider(input) {
      providerCalls++
      assert(input.amountMinor === 12500, 'server should convert the database total to minor units')
      assert(input.currency === 'NGN', 'server should pass the booking currency')
      assert(input.reference === GENERATED_REF, 'provider reference should be generated server-side')
      return { status: true, data: { authorization_url: 'https://checkout.paystack.com/session', reference: input.reference } }
    },
  }, NOW)
  assert(providerCalls === 1, 'one provider initialization expected')
  assert(result.amountMinor === 12500 && result.currency === 'NGN', 'returned amounts should reflect trusted booking data')
  assert(!result.idempotent, 'first initialization should not be marked idempotent')
})

Deno.test('unauthorized owner cannot initialize another user booking', async () => {
  await expectError(initializeBookingPayment(BOOKING_ID, 'other-user', 'guest@example.test', initDependencies(), NOW), 'BOOKING_ACCESS_DENIED')
})

Deno.test('expired booking cannot initialize payment', async () => {
  const dependencies = initDependencies({ expires_at: new Date(NOW - 1000).toISOString() })
  await expectError(initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', dependencies, NOW), 'BOOKING_EXPIRED')
})

Deno.test('duplicate initialization returns the existing checkout without another Paystack call', async () => {
  let providerCalls = 0
  const existing = pendingPayment({ initialization_status: 'initialized', checkout_url: 'https://checkout.paystack.com/existing' })
  const result = await initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', initDependencies({ existing, onProvider: () => providerCalls++ }), NOW)
  assert(result.authorizationUrl === existing.checkout_url, 'existing checkout should be reused')
  assert(result.idempotent && providerCalls === 0, 'duplicate must not create another provider transaction')
})

Deno.test('concurrent initialization uniqueness race reuses an initialized payment', async () => {
  const existing = pendingPayment({ initialization_status: 'initialized', checkout_url: 'https://checkout.paystack.com/raced' })
  let reads = 0
  const dependencies = initDependencies({ existing: null })
  dependencies.createPendingPayment = async () => { throw { code: '23505' } }
  dependencies.findPendingPayment = async () => (++reads === 1 ? null : existing)
  const result = await initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', dependencies, NOW)
  assert(result.idempotent && result.authorizationUrl === existing.checkout_url, 'unique booking attempt should prevent a second charge')
})

Deno.test('unsupported currency is rejected before Paystack initialization', async () => {
  await expectError(initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', initDependencies({ currency: 'ABC' }), NOW), 'UNSUPPORTED_CURRENCY')
})

Deno.test('Paystack timeout keeps the reference pending and marked uncertain', async () => {
  let markedUnknown = 0
  const dependencies = initDependencies()
  dependencies.initializeProvider = async () => { throw new PaymentFlowError(503, 'PAYSTACK_UNAVAILABLE', 'timeout') }
  dependencies.markInitializationUnknown = async (_id, code) => {
    assert(code === 'PAYSTACK_UNAVAILABLE', 'safe timeout code should be persisted')
    markedUnknown++
  }
  await expectError(initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', dependencies, NOW), 'PAYSTACK_INIT_UNCERTAIN')
  assert(markedUnknown === 1, 'uncertain provider result must remain recoverable')
})

Deno.test('definite Paystack initialization rejection releases the active attempt', async () => {
  let markedFailed = 0
  const dependencies = initDependencies()
  dependencies.initializeProvider = async () => { throw new PaymentFlowError(422, 'PAYSTACK_INIT_REJECTED', 'rejected') }
  dependencies.failInitialization = async () => { markedFailed++ }
  await expectError(initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', dependencies, NOW), 'PAYSTACK_INIT_REJECTED')
  assert(markedFailed === 1, 'definite rejection should mark the row failed so a fresh attempt can be made')
})

Deno.test('XOF decimal ticket price is rejected', async () => {
  await expectError(initializeBookingPayment(BOOKING_ID, USER_ID, 'guest@example.test', initDependencies({ currency: 'XOF', total_amount: '12.50' }), NOW), 'INVALID_CURRENCY_PRECISION')
})

Deno.test('invalid legacy and timestamped webhook signatures are rejected', async () => {
  const raw = new TextEncoder().encode('{"event":"charge.success"}')
  assert(!await verifyPaystackSignature(raw, null, '0'.repeat(128), { secretKey: 'sk_test_fake' }, NOW / 1000), 'bad legacy signature must fail')
  assert(!await verifyPaystackSignature(raw, `t=${NOW / 1000},v1=whk_demo:${'0'.repeat(128)}`, null, { webhookSecret: 'whsec_fake' }, NOW / 1000), 'bad modern signature must fail')
})

Deno.test('valid modern Paystack timestamp signature is accepted', async () => {
  const raw = new TextEncoder().encode('{"event":"charge.success"}')
  const timestamp = Math.floor(NOW / 1000)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test_secret'), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const prefix = new TextEncoder().encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.length + raw.length)
  message.set(prefix)
  message.set(raw, prefix.length)
  const messageBuffer = new ArrayBuffer(message.byteLength)
  new Uint8Array(messageBuffer).set(message)
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, messageBuffer))
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  assert(await verifyPaystackSignature(raw, `t=${timestamp},v1=whk_test:${hex}`, null, { webhookSecret: 'whsec_test_secret' }, timestamp), 'valid raw-body signature should pass')
  assert(!await verifyPaystackSignature(raw, `t=${timestamp - 301},v1=whk_test:${hex}`, null, { webhookSecret: 'whsec_test_secret' }, timestamp), 'stale signature timestamp should fail')
})

Deno.test('duplicate webhook event is acknowledged without provider verification', async () => {
  let verifies = 0
  const deps = webhookDependencies({ claimEvent: async () => 'already_handled', verifyTransaction: async () => { verifies++; return successTransaction() } })
  const result = await processPaystackWebhook(payload(), deps)
  assert(result.outcome === 'duplicate' && verifies === 0, 'duplicate event should not verify or finalize again')
})

Deno.test('successful webhook verifies Paystack reference, transaction ID, amount and currency before finalization', async () => {
  let finalized = false
  const deps = webhookDependencies({ finalizePayment: async input => {
    finalized = true
    assert(input.providerReference === REF && input.transactionId === '501', 'reference and transaction identity should be passed to the RPC')
    assert(input.amountMinor === 12500 && input.currency === 'NGN', 'verified amount and currency should be passed to the RPC')
    return { result: 'finalized' }
  } })
  const result = await processPaystackWebhook(payload(), deps)
  assert(result.outcome === 'processed' && finalized, 'successful server verification should invoke finalization')
})

Deno.test('amount mismatch is recorded for review and never finalized', async () => {
  let finalizations = 0
  let errorCode = ''
  const deps = webhookDependencies({
    verifyTransaction: async () => ({ ...successTransaction(), amount: 12499 }),
    finalizePayment: async () => { finalizations++ },
    finishEvent: async (_id, _state, code) => { errorCode = code ?? '' },
  })
  const result = await processPaystackWebhook(payload(), deps)
  assert(result.outcome === 'ignored' && errorCode === 'AMOUNT_MISMATCH' && finalizations === 0, 'mismatch must not reach the finalizer')
})

Deno.test('currency mismatch is recorded and never finalized', async () => {
  let finalizations = 0
  const deps = webhookDependencies({ verifyTransaction: async () => ({ ...successTransaction(), currency: 'USD' }), finalizePayment: async () => { finalizations++ } })
  const result = await processPaystackWebhook(payload(), deps)
  assert(result.outcome === 'ignored' && finalizations === 0, 'currency mismatch must not reach the finalizer')
})

Deno.test('live-domain transaction is rejected by test-mode verification', async () => {
  let finalizations = 0
  let errorCode = ''
  const deps = webhookDependencies({
    verifyTransaction: async () => ({ ...successTransaction(), domain: 'live' }),
    finalizePayment: async () => { finalizations++ },
    finishEvent: async (_id, _state, code) => { errorCode = code ?? '' },
  })
  const result = await processPaystackWebhook(payload(), deps)
  assert(result.outcome === 'ignored' && errorCode === 'TRANSACTION_DOMAIN_MISMATCH' && finalizations === 0,
    'live-domain provider evidence must not finalize in the test deployment')
})

Deno.test('failed transaction updates only a pending payment', async () => {
  let markedFailed = 0
  const deps = webhookDependencies({
    verifyTransaction: async () => ({ ...successTransaction(), status: 'failed' }),
    markPaymentFailed: async () => { markedFailed++ },
  })
  const result = await processPaystackWebhook({ ...payload(), event: 'charge.failed' }, deps)
  assert(result.outcome === 'processed' && markedFailed === 1, 'verified failure should update the pending attempt')
})

Deno.test('finalization failure can be retried idempotently after Paystack verification', async () => {
  let finalizations = 0
  const deps = webhookDependencies({ finalizePayment: async () => {
    finalizations++
    if (finalizations === 1) throw new Error('temporary database failure')
    return { result: 'finalized' }
  } })
  await expectError(processPaystackWebhook(payload(), deps), 'WEBHOOK_PROCESSING_FAILED')
  const retried = await processPaystackWebhook(payload(), deps)
  assert(retried.outcome === 'processed' && finalizations === 2, 'retry must verify again and call idempotent database finalization')
})

Deno.test('late successful payment is delegated to database finalizer for manual review', async () => {
  let called = false
  const deps = webhookDependencies({ finalizePayment: async () => { called = true; return { result: 'manual_review', ticket_count: 0 } } })
  const result = await processPaystackWebhook(payload(), deps)
  assert(called && result.outcome === 'processed', 'webhook must record verified payment and let SQL decide late-payment review without issuing tickets here')
})

function initDependencies(options: {
  existing?: PendingPayment | null
  onProvider?: () => void
  currency?: string
  total_amount?: string
  expires_at?: string
} = {}) {
  let existing = options.existing ?? null
  return {
    async loadBooking(): Promise<BookingForPayment> {
      return {
        id: BOOKING_ID, user_id: USER_ID, booking_reference: 'NOD-BOOKING', status: 'payment_pending',
        payment_status: 'pending', total_amount: options.total_amount ?? '125.00',
        currency: options.currency ?? 'NGN', expires_at: options.expires_at ?? new Date(NOW + 60_000).toISOString(),
      }
    },
    async findPendingPayment() { return existing },
    async createPendingPayment(input: { bookingId: string; reference: string; amountMinor: number; currency: string }) {
      const made = pendingPayment({ internal_reference: input.reference, provider_reference: input.reference, amount_minor: input.amountMinor, currency: input.currency })
      existing = made
      return made
    },
    async initializeProvider(input: { email: string; reference: string; amountMinor: number; currency: string }) {
      options.onProvider?.()
      return { status: true, data: { authorization_url: 'https://checkout.paystack.com/session', reference: input.reference } }
    },
    async saveInitialization(_id: string, authorizationUrl: string) { existing = pendingPayment({ initialization_status: 'initialized', checkout_url: authorizationUrl }) },
    async failInitialization(paymentId: string, errorCode: string) {
      assert(paymentId.length > 0 && errorCode.length > 0, 'failure updates should identify the payment and safe code')
    },
    async markInitializationUnknown(paymentId: string, errorCode: string) {
      assert(paymentId.length > 0 && errorCode.length > 0, 'uncertain updates should identify the payment and safe code')
    },
    newReference: () => '00000000-0000-4000-8000-000000000001',
  }
}

function pendingPayment(overrides: Partial<PendingPayment> = {}): PendingPayment {
  return {
    id: 'payment-1', internal_reference: REF, provider_reference: REF, amount_minor: 12500,
    currency: 'NGN', status: 'pending', initialization_status: 'pending', checkout_url: null,
    ...overrides,
  }
}

function webhookDependencies(overrides: Partial<WebhookDependencies> = {}): WebhookDependencies {
  return {
    async claimEvent() { return 'claimed' },
    async findPaymentByReference(): Promise<PaymentForWebhook> {
      return { ...pendingPayment(), booking_id: BOOKING_ID, provider: 'paystack' }
    },
    async verifyTransaction() { return successTransaction() },
    async setEventPayment() {},
    async markPaymentFailed() {},
    async finalizePayment() {},
    async finishEvent() {},
    ...overrides,
  }
}

function payload(): PaystackWebhookPayload {
  return { event: 'charge.success', data: { id: 501, reference: REF } }
}

function successTransaction(): PaystackTransaction {
  return { id: 501, domain: 'test', status: 'success', reference: REF, amount: 12500, currency: 'NGN', fees: 200, channel: 'card' }
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    assert(error instanceof PaymentFlowError && error.errorCode === code, `expected ${code}, got ${String(error)}`)
    return
  }
  throw new Error(`Expected ${code} error.`)
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}
