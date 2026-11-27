import { createClient } from 'npm:@supabase/supabase-js@2'
import { processPaystackWebhook, type PaymentForWebhook, type PaystackWebhookPayload } from '../_shared/payment_webhook.ts'
import { PAYSTACK_API, PaymentFlowError, paystackRequest, verifyPaystackSignature, type PaystackTransaction } from '../_shared/paystack.ts'
import { processPaystackRefundWebhook, type PaystackRefund, type PaystackRefundWebhookPayload } from '../_shared/refunds.ts'

const headers = { 'content-type': 'application/json' }
const PROCESSING_STALE_MS = 5 * 60 * 1000

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maximumBytes) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumBytes) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: { ...headers, 'access-control-allow-origin': '*' } })
  if (request.method !== 'POST') return respond({ error: 'Use POST for Paystack webhooks.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')
  const webhookSecret = Deno.env.get('PAYSTACK_WEBHOOK_SECRET')
  if (!supabaseUrl || !serviceRoleKey || !paystackSecret) return respond({ error: 'Webhook processing is not configured.' }, 503)
  if (!paystackSecret.startsWith('sk_test_')) return respond({ error: 'This deployment accepts Paystack test credentials only.' }, 503)

  try {
    const rawBody = await readBoundedBody(request, 256_000)
    if (!rawBody || rawBody.length === 0) return respond({ error: 'Webhook payload size is invalid.' }, 400)
    const validSignature = await verifyPaystackSignature(
      rawBody,
      request.headers.get('paystack-signature'),
      request.headers.get('x-paystack-signature'),
      { webhookSecret, secretKey: paystackSecret },
    )
    if (!validSignature) return respond({ error: 'Webhook signature is invalid.' }, 401)

    let payload: PaystackWebhookPayload
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as PaystackWebhookPayload
    } catch {
      return respond({ error: 'Webhook JSON is invalid.' }, 400)
    }
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    if (typeof payload === 'object' && payload !== null && typeof (payload as { event?: unknown }).event === 'string'
      && String((payload as { event: string }).event).startsWith('refund.')) {
      const result = await processPaystackRefundWebhook(payload as PaystackRefundWebhookPayload, {
        claimEvent: (eventId, eventType) => claimWebhookEvent(admin, eventId, eventType),
        async setEventPayment(eventId, paymentId) {
          const { error } = await admin.from('payment_webhook_events').update({ payment_id: paymentId })
            .eq('provider', 'paystack').eq('provider_event_id', eventId)
          if (error) throw error
        },
        async loadRefund(reference) {
          let { data, error } = await admin.from('payment_refunds')
            .select('id,refund_reference,provider_refund_id,payment_id,amount_minor,currency,status')
            .eq('provider', 'paystack').eq('provider_refund_reference', reference).maybeSingle()
          if (!data && !error) {
            const fallback = await admin.from('payment_refunds')
              .select('id,refund_reference,provider_refund_id,payment_id,amount_minor,currency,status')
              .eq('refund_reference', reference).maybeSingle()
            data = fallback.data
            error = fallback.error
          }
          if (error) throw error
          if (!data) return null
          const { data: payment, error: paymentError } = await admin.from('payments')
            .select('provider_reference,provider_transaction_id').eq('id', data.payment_id).maybeSingle()
          if (paymentError || !payment) throw paymentError ?? new Error('Refund payment could not be loaded.')
          return { ...data, payment }
        },
        async retrieveRefund(reference) {
          const query = new URLSearchParams({ reference })
          const response = await paystackRequest<{ status: boolean; data?: PaystackRefund[] }>(
            `${PAYSTACK_API}/refund?${query}`, paystackSecret, { method: 'GET' })
          if (response.httpStatus < 200 || response.httpStatus >= 300 || !response.body.status || !Array.isArray(response.body.data)) {
            throw new PaymentFlowError(503, 'PAYSTACK_REFUND_VERIFY_UNAVAILABLE', 'Paystack refund verification is temporarily unavailable.')
          }
          return response.body.data
        },
        async finalize(input) {
          const { error } = await admin.rpc('finalize_verified_paystack_refund', {
            p_refund_id: input.refundId,
            p_refund_reference: input.refundReference,
            p_provider_refund_id: input.providerRefundId,
            p_transaction_reference: input.transactionReference,
            p_amount_minor: input.amountMinor,
            p_currency: input.currency,
            p_provider_status: input.providerStatus,
            p_verified_at: new Date().toISOString(),
          })
          if (error) throw error
        },
        finishEvent: (eventId, status, errorCode) => finishWebhookEvent(admin, eventId, status, errorCode),
      })
      return respond({ received: true, outcome: result }, 200)
    }

    const result = await processPaystackWebhook(payload, {
      async claimEvent(providerEventId, eventType) {
        const startedAt = new Date().toISOString()
        const inserted = await admin.from('payment_webhook_events').insert({
          provider: 'paystack', provider_event_id: providerEventId, event_type: eventType,
          processing_status: 'processing', processing_started_at: startedAt,
        }).select('id').maybeSingle()
        if (!inserted.error && inserted.data) return 'claimed'
        if (inserted.error?.code !== '23505') throw inserted.error ?? new Error('Webhook event could not be recorded.')

        const { data: existing, error } = await admin.from('payment_webhook_events')
          .select('id,processing_status,processing_started_at')
          .eq('provider', 'paystack').eq('provider_event_id', providerEventId).maybeSingle()
        if (error || !existing) throw error ?? new Error('Webhook event could not be loaded.')
        if (existing.processing_status === 'processed' || existing.processing_status === 'ignored') return 'already_handled'
        if (existing.processing_status === 'processing') {
          const started = existing.processing_started_at ? Date.parse(existing.processing_started_at) : Number.NaN
          if (!Number.isFinite(started) || Date.now() - started < PROCESSING_STALE_MS) return 'busy'
        }

        let retry = admin.from('payment_webhook_events').update({
          processing_status: 'processing', processing_started_at: startedAt,
          processed_at: null, safe_error_code: null,
        }).eq('id', existing.id).eq('processing_status', existing.processing_status)
        if (existing.processing_status === 'processing') {
          retry = retry.lt('processing_started_at', new Date(Date.now() - PROCESSING_STALE_MS).toISOString())
        }
        const { data: claimed, error: claimError } = await retry.select('id').maybeSingle()
        if (claimError) throw claimError
        return claimed ? 'claimed' : 'busy'
      },
      async findPaymentByReference(reference) {
        const { data, error } = await admin.from('payments')
          .select('id,booking_id,provider,internal_reference,provider_reference,amount_minor,currency,status,initialization_status,checkout_url')
          .eq('provider', 'paystack').eq('provider_reference', reference).maybeSingle()
        if (error) throw error
        return data as PaymentForWebhook | null
      },
      async verifyTransaction(reference) {
        const result = await paystackRequest<PaystackVerifyResponse>(
          `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
          paystackSecret,
          { method: 'GET' },
        )
        if (result.httpStatus < 200 || result.httpStatus >= 300 || result.body.status !== true || !result.body.data) {
          throw new PaymentFlowError(503, 'PAYSTACK_VERIFY_UNAVAILABLE', 'Paystack transaction verification is temporarily unavailable.')
        }
        return result.body.data
      },
      async setEventPayment(providerEventId, paymentId) {
        const { error } = await admin.from('payment_webhook_events').update({ payment_id: paymentId })
          .eq('provider', 'paystack').eq('provider_event_id', providerEventId)
        if (error) throw error
      },
      async markPaymentFailed(paymentId) {
        const { error } = await admin.from('payments').update({ status: 'failed' })
          .eq('id', paymentId).eq('status', 'pending')
        if (error) throw error
      },
      async finalizePayment(input) {
        const { error } = await admin.rpc('finalize_verified_payment', {
          p_payment_id: input.paymentId,
          p_provider_reference: input.providerReference,
          p_provider_transaction_id: input.transactionId,
          p_amount_minor: input.amountMinor,
          p_currency: input.currency,
          p_provider_fee_minor: input.providerFeeMinor,
          p_net_amount_minor: input.netAmountMinor,
          p_verified_at: new Date().toISOString(),
          p_safe_metadata: input.safeMetadata,
        })
        if (error) throw error
      },
      async finishEvent(providerEventId, status, errorCode = null) {
        const { error } = await admin.from('payment_webhook_events').update({
          processing_status: status,
          processed_at: status === 'processed' ? new Date().toISOString() : null,
          safe_error_code: errorCode,
        }).eq('provider', 'paystack').eq('provider_event_id', providerEventId)
        if (error) throw error
      },
    })
    return respond({ received: true, outcome: result.outcome }, 200)
  } catch (error) {
    if (error instanceof PaymentFlowError) return respond({ error: error.message, code: error.errorCode }, error.httpStatus)
    console.error('paystack-webhook: processing failed')
    return respond({ error: 'Webhook processing could not be saved and may be retried.' }, 503)
  }
})

type PaystackVerifyResponse = { status: boolean; data?: PaystackTransaction }

async function claimWebhookEvent(admin: ReturnType<typeof createClient>, providerEventId: string, eventType: string) {
  const startedAt = new Date().toISOString()
  const inserted = await admin.from('payment_webhook_events').insert({
    provider: 'paystack', provider_event_id: providerEventId, event_type: eventType,
    processing_status: 'processing', processing_started_at: startedAt,
  }).select('id').maybeSingle()
  if (!inserted.error && inserted.data) return 'claimed' as const
  if (inserted.error?.code !== '23505') throw inserted.error ?? new Error('Webhook event could not be recorded.')
  const { data: existing, error } = await admin.from('payment_webhook_events')
    .select('id,processing_status,processing_started_at').eq('provider', 'paystack')
    .eq('provider_event_id', providerEventId).maybeSingle()
  if (error || !existing) throw error ?? new Error('Webhook event could not be loaded.')
  if (existing.processing_status === 'processed' || existing.processing_status === 'ignored') return 'already_handled' as const
  if (existing.processing_status === 'processing') {
    const started = existing.processing_started_at ? Date.parse(existing.processing_started_at) : Number.NaN
    if (!Number.isFinite(started) || Date.now() - started < PROCESSING_STALE_MS) return 'busy' as const
  }
  let retry = admin.from('payment_webhook_events').update({ processing_status: 'processing',
    processing_started_at: startedAt, processed_at: null, safe_error_code: null })
    .eq('id', existing.id).eq('processing_status', existing.processing_status)
  if (existing.processing_status === 'processing') retry = retry.lt('processing_started_at', new Date(Date.now() - PROCESSING_STALE_MS).toISOString())
  const { data: claimed, error: claimError } = await retry.select('id').maybeSingle()
  if (claimError) throw claimError
  return claimed ? 'claimed' as const : 'busy' as const
}

async function finishWebhookEvent(admin: ReturnType<typeof createClient>, providerEventId: string,
  status: 'processed' | 'failed' | 'ignored', errorCode?: string) {
  const { error } = await admin.from('payment_webhook_events').update({
    processing_status: status, processed_at: status === 'processed' ? new Date().toISOString() : null,
    safe_error_code: errorCode ?? null,
  }).eq('provider', 'paystack').eq('provider_event_id', providerEventId)
  if (error) throw error
}

function respond(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers })
}
