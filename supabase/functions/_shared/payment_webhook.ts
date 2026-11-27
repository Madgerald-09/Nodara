import {
  PaymentFlowError,
  validateSuccessfulTransaction,
  validateTransactionIdentity,
  type PaystackTransaction,
  type PendingPayment,
} from './paystack.ts'

export type PaystackWebhookPayload = {
  event?: unknown
  data?: { id?: unknown; reference?: unknown }
}

export type PaymentForWebhook = PendingPayment & { booking_id: string; provider: string }

export type WebhookDependencies = {
  claimEvent: (providerEventId: string, eventType: string) => Promise<'claimed' | 'already_handled' | 'busy'>
  findPaymentByReference: (reference: string) => Promise<PaymentForWebhook | null>
  verifyTransaction: (reference: string) => Promise<PaystackTransaction>
  setEventPayment: (providerEventId: string, paymentId: string) => Promise<void>
  markPaymentFailed: (paymentId: string) => Promise<void>
  finalizePayment: (input: {
    paymentId: string
    providerReference: string
    transactionId: string
    amountMinor: number
    currency: string
    providerFeeMinor: number | null
    netAmountMinor: number | null
    safeMetadata: Record<string, string>
  }) => Promise<unknown>
  finishEvent: (providerEventId: string, status: 'processed' | 'failed' | 'ignored', errorCode?: string | null) => Promise<void>
}

export type WebhookResult = { outcome: 'processed' | 'ignored' | 'duplicate'; paymentId?: string }

export async function processPaystackWebhook(
  payload: PaystackWebhookPayload,
  dependencies: WebhookDependencies,
): Promise<WebhookResult> {
  const eventType = typeof payload.event === 'string' ? payload.event : ''
  const transactionId = payload.data?.id === undefined || payload.data.id === null ? '' : String(payload.data.id)
  const reference = typeof payload.data?.reference === 'string' ? payload.data.reference : ''
  if (!/^[a-z0-9_.-]{1,128}$/i.test(eventType) || !/^[A-Za-z0-9_-]{1,120}$/.test(transactionId)) {
    throw new PaymentFlowError(400, 'INVALID_WEBHOOK', 'Paystack event identity is invalid.')
  }
  const eventId = `${eventType}:${transactionId}`
  const claim = await dependencies.claimEvent(eventId, eventType)
  if (claim === 'already_handled') return { outcome: 'duplicate' }
  if (claim === 'busy') throw new PaymentFlowError(503, 'WEBHOOK_ALREADY_PROCESSING', 'This Paystack event is already being processed.')

  try {
    if (eventType !== 'charge.success' && eventType !== 'charge.failed') {
      await dependencies.finishEvent(eventId, 'ignored', 'EVENT_NOT_HANDLED')
      return { outcome: 'ignored' }
    }
    if (!reference || reference.length > 128) {
      await dependencies.finishEvent(eventId, 'failed', 'REFERENCE_INVALID')
      throw new PaymentFlowError(503, 'REFERENCE_INVALID', 'Signed payment event has no usable provider reference.')
    }
    const payment = await dependencies.findPaymentByReference(reference)
    if (!payment) {
      await dependencies.finishEvent(eventId, 'failed', 'PAYMENT_NOT_FOUND')
      throw new PaymentFlowError(503, 'PAYMENT_NOT_FOUND', 'Payment record is not available yet. The event can be retried.')
    }
    if (payment.provider !== 'paystack') {
      await dependencies.finishEvent(eventId, 'ignored', 'PROVIDER_MISMATCH')
      return { outcome: 'ignored', paymentId: payment.id }
    }
    await dependencies.setEventPayment(eventId, payment.id)

    const transaction = await dependencies.verifyTransaction(reference)
    if (String(transaction.id) !== transactionId || transaction.reference !== reference) {
      await dependencies.finishEvent(eventId, 'ignored', 'TRANSACTION_ID_MISMATCH')
      return { outcome: 'ignored', paymentId: payment.id }
    }
    if (transaction.status === 'success') {
      let verified
      try {
        verified = validateSuccessfulTransaction(transaction, payment)
      } catch (error) {
        if (!(error instanceof PaymentFlowError)) throw error
        await dependencies.finishEvent(eventId, 'ignored', error.errorCode)
        return { outcome: 'ignored', paymentId: payment.id }
      }
      await dependencies.finalizePayment({
        paymentId: payment.id,
        providerReference: payment.provider_reference ?? payment.internal_reference,
        transactionId: verified.transactionId,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        providerFeeMinor: verified.providerFeeMinor,
        netAmountMinor: verified.netAmountMinor,
        safeMetadata: {
          verification_source: 'paystack_api',
          webhook_event_type: eventType,
          ...(transaction.channel && /^[a-z0-9_-]{1,40}$/i.test(transaction.channel)
            ? { channel: transaction.channel }
            : {}),
        },
      })
      await dependencies.finishEvent(eventId, 'processed')
      return { outcome: 'processed', paymentId: payment.id }
    }

    if (transaction.status === 'failed' || transaction.status === 'abandoned') {
      try {
        validateTransactionIdentity(transaction, payment)
      } catch (error) {
        if (!(error instanceof PaymentFlowError)) throw error
        await dependencies.finishEvent(eventId, 'ignored', error.errorCode)
        return { outcome: 'ignored', paymentId: payment.id }
      }
      await dependencies.markPaymentFailed(payment.id)
      await dependencies.finishEvent(eventId, 'processed')
      return { outcome: 'processed', paymentId: payment.id }
    }

    await dependencies.finishEvent(eventId, 'failed', 'PROVIDER_NOT_FINAL')
    throw new PaymentFlowError(503, 'PROVIDER_NOT_FINAL', 'Paystack has not returned a final transaction status. The event can be retried.')
  } catch (error) {
    if (!(error instanceof PaymentFlowError) || error.httpStatus >= 500) {
      try {
        const code = error instanceof PaymentFlowError ? error.errorCode : 'PROCESSING_FAILED'
        await dependencies.finishEvent(eventId, 'failed', code)
      } catch {
        // Paystack retry will reclaim stale processing state if the database is unavailable.
      }
      if (error instanceof PaymentFlowError) throw error
      throw new PaymentFlowError(503, 'WEBHOOK_PROCESSING_FAILED', 'Payment verification could not be saved. Paystack may retry this event.')
    }
    throw error
  }
}

