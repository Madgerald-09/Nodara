import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentFlowError } from '../supabase/functions/_shared/paystack.ts'
import { reconcilePaystackPayment } from '../supabase/functions/_shared/payment_reconciliation.ts'

const payment = {
  id: 'payment-1', internal_reference: 'NOD-REF-1', provider_reference: 'NOD-REF-1',
  amount_minor: 12500, currency: 'NGN', status: 'pending',
  initialization_status: 'initialized', checkout_url: 'https://checkout.paystack.com/session',
}
const transaction = (overrides = {}) => ({ id: 42, domain: 'test', status: 'success',
  reference: 'NOD-REF-1', amount: 12500, currency: 'NGN', fees: 500, ...overrides })

test('status reconciliation finalizes only a verified test-domain transaction', async () => {
  const calls = []
  const result = await reconcilePaystackPayment(payment, {
    async verifyTransaction(reference) { calls.push(['verify', reference]); return transaction() },
    async markFailed() { assert.fail('success must not mark failed') },
    async finalize(input) { calls.push(['finalize', input]) },
  })
  assert.equal(result, 'finalized')
  assert.equal(calls[0][0], 'verify')
  assert.equal(calls[1][1].transactionId, '42')
  assert.equal(calls[1][1].netAmountMinor, 12000)
})

test('mismatched provider evidence cannot reach the database finalizer', async () => {
  let finalized = false
  await assert.rejects(reconcilePaystackPayment(payment, {
    async verifyTransaction() { return transaction({ amount: 12501 }) },
    async markFailed() {},
    async finalize() { finalized = true },
  }), error => error instanceof PaymentFlowError && error.errorCode === 'AMOUNT_MISMATCH')
  assert.equal(finalized, false)
})

test('non-test transactions cannot be used to finalize a test payment', async () => {
  await assert.rejects(reconcilePaystackPayment(payment, {
    async verifyTransaction() { return transaction({ domain: 'live' }) },
    async markFailed() {}, async finalize() {},
  }), error => error instanceof PaymentFlowError && error.errorCode === 'TRANSACTION_DOMAIN_MISMATCH')
})

test('verified failure only marks the pending payment failed', async () => {
  let marked = false
  const result = await reconcilePaystackPayment(payment, {
    async verifyTransaction() { return transaction({ status: 'abandoned' }) },
    async markFailed(paymentId) { marked = paymentId === payment.id },
    async finalize() { assert.fail('failed transaction must not finalize') },
  })
  assert.equal(result, 'failed')
  assert.equal(marked, true)
})

test('temporary database failure can retry the same verified transaction', async () => {
  let attempts = 0
  const dependencies = {
    async verifyTransaction() { return transaction() },
    async markFailed() {},
    async finalize() { attempts++; if (attempts === 1) throw new Error('temporary database failure') },
  }
  await assert.rejects(reconcilePaystackPayment(payment, dependencies), /temporary database failure/)
  assert.equal(await reconcilePaystackPayment(payment, dependencies), 'finalized')
  assert.equal(attempts, 2)
})

test('successful and terminal payment rows are not redundantly reconciled', async () => {
  let verifications = 0
  const dependencies = {
    async verifyTransaction() { verifications++; return transaction() },
    async markFailed() {}, async finalize() {},
  }
  assert.equal(await reconcilePaystackPayment({ ...payment, status: 'successful' }, dependencies), 'skipped')
  assert.equal(verifications, 0)
})
