import { PaymentFlowError } from './paystack.ts'

export type PaystackRefund = {
  id: number | string
  domain: string
  reference: string
  transaction: number | string | { id?: number | string; reference?: string }
  amount: number | string
  currency: string
  status: string
}

export type RefundExpectation = {
  refundReference: string
  transactionId: string
  amountMinor: number
  currency: string
}

export type RefundTicketEligibility = {
  id: string
  status: string
  blockchainStatus: string
  holderUserId: string | null
  unitPriceMinor: number
  currency: string
  checkedIn: boolean
  transferred: boolean
}

export function calculateRefundAmount(input: {
  paymentStatus: string
  paymentAmountMinor: number
  paymentCurrency: string
  requesterId: string
  bookingOwnerId: string
  organizerId: string
  ticketIds: string[]
  tickets: RefundTicketEligibility[]
  alreadyReservedMinor: number
}) {
  if (!['successful', 'partially_refunded'].includes(input.paymentStatus)) {
    throw new PaymentFlowError(409, 'PAYMENT_NOT_REFUNDABLE', 'This payment is not eligible for a refund.')
  }
  if (input.requesterId !== input.bookingOwnerId && input.requesterId !== input.organizerId) {
    throw new PaymentFlowError(403, 'REFUND_ACCESS_DENIED', 'You are not authorized to request this refund.')
  }
  if (!input.ticketIds.length || new Set(input.ticketIds).size !== input.ticketIds.length) {
    throw new PaymentFlowError(422, 'REFUND_TICKETS_INVALID', 'Select a unique set of tickets to refund.')
  }
  const byId = new Map(input.tickets.map(ticket => [ticket.id, ticket]))
  let amountMinor = 0
  for (const id of input.ticketIds) {
    const ticket = byId.get(id)
    if (!ticket) throw new PaymentFlowError(422, 'REFUND_TICKET_NOT_FOUND', 'A selected ticket is not part of this booking.')
    if (ticket.status !== 'issued' || ticket.checkedIn) {
      throw new PaymentFlowError(409, 'REFUND_TICKET_USED', 'Checked-in or cancelled tickets cannot be refunded.')
    }
    if (ticket.transferred) throw new PaymentFlowError(409, 'REFUND_TICKET_TRANSFERRED', 'Transferred tickets cannot be refunded.')
    if (ticket.blockchainStatus !== 'off_chain') {
      throw new PaymentFlowError(409, 'REFUND_ONCHAIN_INVALIDATION_REQUIRED', 'On-chain tickets require verified organiser invalidation before refund.')
    }
    if (input.requesterId === input.bookingOwnerId && ticket.holderUserId !== input.requesterId) {
      throw new PaymentFlowError(403, 'REFUND_HOLDER_REQUIRED', 'Only the current ticket holder can request this refund.')
    }
    if (!Number.isSafeInteger(ticket.unitPriceMinor) || ticket.unitPriceMinor <= 0 || ticket.currency !== input.paymentCurrency) {
      throw new PaymentFlowError(422, 'REFUND_TICKET_PRICE_INVALID', 'Ticket price or currency is invalid for refund.')
    }
    amountMinor += ticket.unitPriceMinor
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor + input.alreadyReservedMinor > input.paymentAmountMinor) {
    throw new PaymentFlowError(409, 'REFUND_BALANCE_EXCEEDED', 'Refund exceeds the remaining refundable balance.')
  }
  return { amountMinor, currency: input.paymentCurrency, ticketIds: [...input.ticketIds] }
}

export function mapPaystackRefundStatus(status: string): 'processing' | 'succeeded' | 'failed' {
  if (status === 'processed') return 'succeeded'
  if (status === 'failed') return 'failed'
  if (['pending', 'processing', 'needs-attention'].includes(status)) return 'processing'
  throw new PaymentFlowError(503, 'REFUND_STATUS_UNKNOWN', 'Paystack returned an unsupported refund status.')
}

export function validatePaystackRefund(
  refund: PaystackRefund,
  expected: RefundExpectation,
): { providerRefundId: string; providerStatus: 'pending' | 'processing' | 'needs-attention' | 'processed' | 'failed' } {
  if (refund?.domain !== 'test') {
    throw new PaymentFlowError(503, 'REFUND_DOMAIN_MISMATCH', 'Paystack refund is not from the test environment.')
  }
  const providerRefundId = String(refund?.id ?? '')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerRefundId)) {
    throw new PaymentFlowError(503, 'REFUND_ID_INVALID', 'Paystack refund identity is invalid.')
  }
  if (refund.reference !== expected.refundReference) {
    throw new PaymentFlowError(503, 'REFUND_REFERENCE_MISMATCH', 'Paystack refund reference does not match the request.')
  }
  const transactionId = typeof refund.transaction === 'object' && refund.transaction !== null
    ? String(refund.transaction.id ?? '')
    : String(refund.transaction)
  if (transactionId !== expected.transactionId) {
    throw new PaymentFlowError(503, 'REFUND_TRANSACTION_MISMATCH', 'Paystack refund does not reference the stored payment.')
  }
  const amount = typeof refund.amount === 'string' && /^\d+$/.test(refund.amount)
    ? Number(refund.amount)
    : refund.amount
  if (!Number.isSafeInteger(amount) || amount !== expected.amountMinor) {
    throw new PaymentFlowError(503, 'REFUND_AMOUNT_MISMATCH', 'Paystack refund amount does not match the approved request.')
  }
  if (refund.currency !== expected.currency) {
    throw new PaymentFlowError(503, 'REFUND_CURRENCY_MISMATCH', 'Paystack refund currency does not match the payment.')
  }
  if (!['pending', 'processing', 'needs-attention', 'processed', 'failed'].includes(refund.status)) {
    throw new PaymentFlowError(503, 'REFUND_STATUS_UNKNOWN', 'Paystack returned an unsupported refund status.')
  }
  return { providerRefundId, providerStatus: refund.status as 'pending' | 'processing' | 'needs-attention' | 'processed' | 'failed' }
}

export function findPaystackRefund(
  refunds: PaystackRefund[],
  expected: RefundExpectation,
): PaystackRefund {
  const exact = refunds.filter(refund => refund.reference === expected.refundReference)
  if (exact.length !== 1) {
    throw new PaymentFlowError(503, 'REFUND_NOT_UNIQUE', 'Paystack refund could not be matched unambiguously.')
  }
  validatePaystackRefund(exact[0], expected)
  return exact[0]
}

export type PaystackRefundWebhookPayload = {
  event?: unknown
  data?: {
    refund_reference?: unknown
    transaction_reference?: unknown
    amount?: unknown
    currency?: unknown
  }
}

export type RefundWebhookDependencies = {
  claimEvent: (eventId: string, eventType: string) => Promise<'claimed' | 'already_handled' | 'busy'>
  setEventPayment: (eventId: string, paymentId: string) => Promise<void>
  loadRefund: (reference: string) => Promise<{
    id: string
    refund_reference: string
    provider_refund_id: string | null
    payment_id: string
    amount_minor: number | string
    currency: string
    status: string
    payment: { provider_reference: string | null; provider_transaction_id: string | null }
  } | null>
  retrieveRefund: (reference: string) => Promise<PaystackRefund[]>
  finalize: (input: {
    refundId: string
    refundReference: string
    providerRefundId: string
    transactionReference: string
    amountMinor: number
    currency: string
    providerStatus: string
  }) => Promise<void>
  finishEvent: (eventId: string, status: 'processed' | 'failed' | 'ignored', errorCode?: string) => Promise<void>
}

const refundEvents = new Set([
  'refund.pending', 'refund.processing', 'refund.needs-attention', 'refund.failed', 'refund.processed',
])

export async function processPaystackRefundWebhook(
  payload: PaystackRefundWebhookPayload,
  dependencies: RefundWebhookDependencies,
): Promise<'processed' | 'ignored' | 'duplicate'> {
  const eventType = typeof payload.event === 'string' ? payload.event : ''
  if (!refundEvents.has(eventType)) return 'ignored'
  const reference = typeof payload.data?.refund_reference === 'string' ? payload.data.refund_reference : ''
  const transactionReference = typeof payload.data?.transaction_reference === 'string' ? payload.data.transaction_reference : ''
  const amount = payload.data?.amount
  const currency = typeof payload.data?.currency === 'string' ? payload.data.currency : ''
  if (!reference && eventType !== 'refund.processed') return 'ignored'
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(reference) || !transactionReference || transactionReference.length > 128
    || !(typeof amount === 'string' || typeof amount === 'number') || !currency) {
    throw new PaymentFlowError(400, 'REFUND_WEBHOOK_INVALID', 'Paystack refund event identity is invalid.')
  }
  const eventId = `${eventType}:${reference}`
  const claim = await dependencies.claimEvent(eventId, eventType)
  if (claim === 'already_handled') return 'duplicate'
  if (claim === 'busy') throw new PaymentFlowError(503, 'REFUND_WEBHOOK_BUSY', 'This refund event is already being processed.')
  try {
    const local = await dependencies.loadRefund(reference)
    if (!local) {
      await dependencies.finishEvent(eventId, 'failed', 'REFUND_NOT_FOUND')
      throw new PaymentFlowError(503, 'REFUND_NOT_FOUND', 'Refund record is not available yet. The event can be retried.')
    }
    await dependencies.setEventPayment(eventId, local.payment_id)
    if (local.payment.provider_reference !== transactionReference) {
      await dependencies.finishEvent(eventId, 'ignored', 'TRANSACTION_REFERENCE_MISMATCH')
      return 'ignored'
    }
    const amountMinor = typeof amount === 'string' && /^\d+$/.test(amount) ? Number(amount) : amount
    if (!Number.isSafeInteger(amountMinor) || amountMinor !== Number(local.amount_minor) || currency !== local.currency) {
      await dependencies.finishEvent(eventId, 'ignored', 'AMOUNT_OR_CURRENCY_MISMATCH')
      return 'ignored'
    }
    const providerRows = await dependencies.retrieveRefund(reference)
    const verified = findPaystackRefund(providerRows, {
      refundReference: reference,
      transactionId: local.payment.provider_transaction_id ?? '',
      amountMinor: Number(local.amount_minor),
      currency: local.currency,
    })
    const evidence = validatePaystackRefund(verified, {
      refundReference: reference,
      transactionId: local.payment.provider_transaction_id ?? '',
      amountMinor: Number(local.amount_minor),
      currency: local.currency,
    })
    await dependencies.finalize({
      refundId: local.id,
      refundReference: reference,
      providerRefundId: evidence.providerRefundId,
      transactionReference,
      amountMinor: Number(local.amount_minor),
      currency: local.currency,
      providerStatus: evidence.providerStatus,
    })
    await dependencies.finishEvent(eventId, 'processed')
    return 'processed'
  } catch (error) {
    if (error instanceof PaymentFlowError && error.httpStatus < 500) throw error
    try { await dependencies.finishEvent(eventId, 'failed', error instanceof PaymentFlowError ? error.errorCode : 'REFUND_VERIFY_FAILED') } catch { /* retry can reclaim the event */ }
    if (error instanceof PaymentFlowError) throw error
    throw new PaymentFlowError(503, 'REFUND_VERIFY_FAILED', 'Refund verification could not be saved and can be retried.')
  }
}
