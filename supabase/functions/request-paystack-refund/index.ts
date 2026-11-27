import { createClient } from 'npm:@supabase/supabase-js@2'
import { PAYSTACK_API, PaymentFlowError, paystackRequest } from '../_shared/paystack.ts'
import { findPaystackRefund, type PaystackRefund } from '../_shared/refunds.ts'

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to request a refund.' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')
    if (!url || !anonKey || !serviceKey || !paystackSecret) return respond({ error: 'Refund service is not configured.' }, 503)
    if (!paystackSecret.startsWith('sk_test_')) return respond({ error: 'This deployment accepts Paystack test credentials only.' }, 503)

    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in before requesting a refund.' }, 401)
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your signed-in account could not be verified.' }, 401)

    const body = await request.json().catch(() => null) as {
      paymentId?: unknown; ticketIds?: unknown; requestKey?: unknown
    } | null
    const paymentId = typeof body?.paymentId === 'string' ? body.paymentId : ''
    const requestKey = typeof body?.requestKey === 'string' ? body.requestKey : ''
    const ticketIds = Array.isArray(body?.ticketIds) ? body.ticketIds : []
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuid.test(paymentId) || !uuid.test(requestKey) || ticketIds.length < 1 || ticketIds.length > 20
      || ticketIds.some(id => typeof id !== 'string' || !uuid.test(id))) {
      return respond({ error: 'Payment, request key and ticket IDs must be valid.' }, 400)
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: reservation, error: reservationError } = await admin.rpc('request_paystack_refund', {
      p_payment_id: paymentId,
      p_requester_id: auth.user.id,
      p_request_key: requestKey,
      p_ticket_ids: ticketIds,
    })
    if (reservationError) return respond({ error: safeRefundError(reservationError.message) }, 409)
    const refund = reservation as RefundReservation
    if (!refund?.refund_id || !refund.refund_reference) throw new Error('Refund reservation response was incomplete.')
    if (refund.status === 'succeeded' || refund.status === 'failed' || refund.status === 'cancelled') {
      return respond(safeRefund(refund), refund.status === 'failed' ? 409 : 200)
    }

    const { data: payment, error: paymentError } = await admin.from('payments')
      .select('provider_transaction_id,currency').eq('id', paymentId).maybeSingle()
    if (paymentError || !payment?.provider_transaction_id || payment.currency !== refund.currency) {
      return respond({ error: 'The verified payment details could not be loaded. The refund request remains pending for retry.' }, 503)
    }
    const expected: RefundExpectationLocal = {
      refundReference: refund.refund_reference,
      transactionId: payment.provider_transaction_id,
      amountMinor: Number(refund.amount_minor),
      currency: refund.currency,
    }

    let acceptedByProvider = false
    const create = await paystackRequest<PaystackResponse>(`${PAYSTACK_API}/refund`, paystackSecret, {
      method: 'POST',
      body: JSON.stringify({
        transaction: payment.provider_transaction_id,
        amount: expected.amountMinor,
        currency: expected.currency,
        reference: expected.refundReference,
        customer_note: 'NODARA ticket refund',
      }),
    })
    if (create.httpStatus >= 200 && create.httpStatus < 300 && create.body.status && create.body.data) {
      acceptedByProvider = true
    } else if (create.httpStatus === 409) {
      acceptedByProvider = true
    } else if (create.httpStatus >= 400 && create.httpStatus < 500) {
      await admin.rpc('fail_unsubmitted_paystack_refund', {
        p_refund_id: refund.refund_id,
        p_error_code: 'PROVIDER_REJECTED',
      })
      return respond({ error: 'Paystack rejected the refund request. The ticket remains valid; you can submit a new request.' }, 422)
    } else {
      // A timeout/server error is ambiguous. Keep the reservation and retry with
      // the same unique provider reference; Paystack will return 409 if accepted.
      return respond({ ...safeRefund(refund), retryable: true }, 503)
    }

    if (!acceptedByProvider) return respond({ ...safeRefund(refund), retryable: true }, 503)
    // Always retrieve the refund separately. The create response is only an
    // acknowledgement and is never used as verified refund status evidence.
    const providerRefund = await getRefundByReference(expected, paystackSecret)
    if (!providerRefund) return respond({ ...safeRefund(refund), retryable: true }, 503)
    const verified = findPaystackRefund([providerRefund], expected)
    const { data: savedRefund, error: saveError } = await admin.rpc('record_paystack_refund_initiation', {
      p_refund_id: refund.refund_id,
      p_refund_reference: expected.refundReference,
      p_provider_refund_id: String(verified.id),
      p_transaction_id: expected.transactionId,
      p_amount_minor: expected.amountMinor,
      p_currency: expected.currency,
      p_provider_status: verified.status,
    })
    if (saveError) return respond({ ...safeRefund(refund), retryable: true }, 503)
    const savedStatus = (savedRefund as { status?: string } | null)?.status ?? 'processing'
    return respond({ ...safeRefund(refund), status: savedStatus }, savedStatus === 'failed' ? 200 : 202)
  } catch (error) {
    if (error instanceof PaymentFlowError) return respond({ error: error.message, code: error.errorCode }, error.httpStatus)
    console.error('request-paystack-refund: refund initiation failed')
    return respond({ error: 'Refund could not be processed. Refresh its status before retrying.' }, 503)
  }
})

type RefundReservation = {
  refund_id: string
  refund_reference: string
  amount_minor: number | string
  currency: string
  status: string
  idempotent?: boolean
}
type RefundExpectationLocal = { refundReference: string; transactionId: string; amountMinor: number; currency: string }
type PaystackResponse = { status: boolean; data?: PaystackRefund }
type RefundListResponse = { status: boolean; data?: PaystackRefund[] }

async function getRefundByReference(expected: RefundExpectationLocal, secret: string) {
  const query = new URLSearchParams({ reference: expected.refundReference })
  const result = await paystackRequest<RefundListResponse>(`${PAYSTACK_API}/refund?${query}`, secret, { method: 'GET' })
  if (!result.body.status || !Array.isArray(result.body.data)) return null
  return findPaystackRefund(result.body.data, expected)
}

function safeRefund(refund: RefundReservation) {
  return { refundId: refund.refund_id, reference: refund.refund_reference, amountMinor: refund.amount_minor,
    currency: refund.currency, status: refund.status, idempotent: Boolean(refund.idempotent) }
}

function safeRefundError(message: string) {
  if (/Checked-in or cancelled/i.test(message)) return 'Checked-in or cancelled tickets cannot be refunded.'
  if (/transferred/i.test(message)) return 'Transferred tickets cannot be refunded.'
  if (/On-chain tickets/i.test(message)) return 'This ticket needs verified organiser invalidation on Solana before it can be refunded.'
  if (/refundable balance|exceeds/i.test(message)) return 'This refund would exceed the remaining refundable balance.'
  if (/access denied/i.test(message)) return 'You are not authorized to request a refund for these tickets.'
  if (/already have an active or completed refund/i.test(message)) return 'A refund is already pending or completed for one or more selected tickets.'
  if (/not eligible/i.test(message)) return 'This booking is not eligible for a refund.'
  return 'The refund request could not be validated. Refresh and try again.'
}

function respond(body: unknown, status: number) { return new Response(JSON.stringify(body), { status, headers }) }
