import { createClient } from 'npm:@supabase/supabase-js@2'
import { PAYSTACK_API, paystackRequest, type PaystackTransaction } from '../_shared/paystack.ts'
import { reconcilePaystackPayment } from '../_shared/payment_reconciliation.ts'
import { validatePaystackRefund, type PaystackRefund } from '../_shared/refunds.ts'

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to check a booking payment.' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return respond({ error: 'Payment status is not configured.' }, 503)
    if (paystackSecret && !paystackSecret.startsWith('sk_test_')) {
      return respond({ error: 'This deployment accepts Paystack test credentials only.' }, 503)
    }

    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to view payment status.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your signed-in account could not be verified.' }, 401)

    const body = await request.json().catch(() => null) as { bookingId?: unknown } | null
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) {
      return respond({ error: 'A valid booking ID is required.' }, 400)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: bookingRow, error: bookingError } = await admin.from('bookings')
      .select('id,user_id,status,payment_status,total_amount,currency,expires_at')
      .eq('id', bookingId).eq('user_id', auth.user.id).maybeSingle()
    if (bookingError) throw new Error('Booking status could not be loaded.')
    if (!bookingRow) return respond({ error: 'Booking was not found.' }, 404)
    let booking = bookingRow

    const paymentColumns = 'id,provider_reference,provider_transaction_id,amount_minor,currency,status,initialization_status,checkout_url,fulfillment_status,created_at,verified_at,initialization_error_code'
    const { data: successfulPayment, error: successfulPaymentError } = await admin.from('payments')
      .select(paymentColumns).eq('booking_id', bookingId).eq('status', 'successful')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (successfulPaymentError) throw new Error('Payment status could not be loaded.')
    const { data: latestPayment, error: latestPaymentError } = successfulPayment ? { data: null, error: null } : await admin.from('payments')
      .select(paymentColumns).eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (latestPaymentError) throw new Error('Payment status could not be loaded.')
    const payment = successfulPayment ?? latestPayment
    let paymentRow = payment as {
      id: string
      provider_reference: string | null
      provider_transaction_id: string | null
      amount_minor: number | string
      currency: string
      status: string
      initialization_status: string
      checkout_url: string | null
      fulfillment_status: string
      created_at: string
      verified_at: string | null
      initialization_error_code: string | null
    } | null

    // A browser return is not proof of payment. Rechecking the trusted Paystack
    // transaction here recovers missed webhooks and retries transient RPC errors.
    if (paymentRow && ['pending', 'failed'].includes(paymentRow.status)
      && paystackSecret?.startsWith('sk_test_') && paymentRow.provider_reference) {
      const providerResult = await paystackRequest<{ status: boolean; data?: PaystackTransaction }>(
        `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(paymentRow.provider_reference)}`,
        paystackSecret,
        { method: 'GET' },
      )
      if (providerResult.httpStatus >= 200 && providerResult.httpStatus < 300
        && providerResult.body.status === true && providerResult.body.data) {
        const outcome = await reconcilePaystackPayment({
          id: paymentRow.id,
          internal_reference: paymentRow.provider_reference,
          provider_reference: paymentRow.provider_reference,
          amount_minor: paymentRow.amount_minor,
          currency: paymentRow.currency,
          status: paymentRow.status,
          initialization_status: paymentRow.initialization_status as 'pending' | 'initialized' | 'failed' | 'unknown',
          checkout_url: paymentRow.checkout_url,
        }, {
          async verifyTransaction() { return providerResult.body.data! },
          async markFailed(paymentId) {
            const { error } = await admin.from('payments').update({ status: 'failed' })
              .eq('id', paymentId).eq('status', 'pending')
            if (error) throw error
          },
          async finalize(input) {
            const { error } = await admin.rpc('finalize_verified_payment', {
              p_payment_id: input.paymentId,
              p_provider_reference: input.providerReference,
              p_provider_transaction_id: input.transactionId,
              p_amount_minor: input.amountMinor,
              p_currency: input.currency,
              p_provider_fee_minor: input.providerFeeMinor,
              p_net_amount_minor: input.netAmountMinor,
              p_verified_at: new Date().toISOString(),
              p_safe_metadata: { verification_source: 'paystack_api_status_check' },
            })
            if (error) throw error
          },
        })
        if (outcome === 'finalized' || outcome === 'failed') {
          const [{ data: updatedBooking, error: updatedBookingError }, { data: updatedPayment, error: updatedPaymentError }] = await Promise.all([
            admin.from('bookings').select('id,user_id,status,payment_status,total_amount,currency,expires_at')
              .eq('id', booking.id).eq('user_id', auth.user.id).single(),
            admin.from('payments').select(paymentColumns).eq('id', paymentRow.id).single(),
          ])
          if (updatedBookingError || updatedPaymentError || !updatedBooking || !updatedPayment) {
            throw new Error('Updated payment state could not be reloaded.')
          }
          booking = updatedBooking
          paymentRow = updatedPayment as typeof paymentRow
        }
      }
    }

    const { data: refundRows, error: refundError } = paymentRow
      ? await admin.from('payment_refunds')
        .select('id,refund_reference,provider_refund_id,amount_minor,currency,status,safe_error_code,created_at,completed_at')
        .eq('payment_id', paymentRow.id).order('created_at', { ascending: false })
      : { data: [], error: null }
    if (refundError) throw new Error('Refund status could not be loaded.')
    if (paymentRow && paystackSecret?.startsWith('sk_test_')) {
      await Promise.all((refundRows ?? []).filter(refund =>
        ['pending', 'processing'].includes(refund.status) && refund.provider_refund_id && paymentRow.provider_transaction_id,
      ).map(async refund => {
        try {
          const response = await paystackRequest<{ status: boolean; data?: PaystackRefund }>(
            `${PAYSTACK_API}/refund/${encodeURIComponent(refund.provider_refund_id!)}`, paystackSecret, { method: 'GET' })
          if (response.httpStatus < 200 || response.httpStatus >= 300 || !response.body.status || !response.body.data) return
          const evidence = validatePaystackRefund(response.body.data, {
            refundReference: refund.refund_reference,
            transactionId: paymentRow.provider_transaction_id!,
            amountMinor: Number(refund.amount_minor),
            currency: refund.currency,
          })
          const { error } = await admin.rpc('finalize_verified_paystack_refund', {
            p_refund_id: refund.id,
            p_refund_reference: refund.refund_reference,
            p_provider_refund_id: evidence.providerRefundId,
            p_transaction_reference: paymentRow.provider_reference,
            p_amount_minor: Number(refund.amount_minor),
            p_currency: refund.currency,
            p_provider_status: evidence.providerStatus,
            p_verified_at: new Date().toISOString(),
          })
          if (!error) {
            refund.status = evidence.providerStatus === 'processed' ? 'succeeded'
              : evidence.providerStatus === 'failed' ? 'failed' : 'processing'
            refund.completed_at = ['processed', 'failed'].includes(evidence.providerStatus) ? new Date().toISOString() : null
          }
        } catch {
          // Keep the last trusted status visible. A later owner status check or webhook retries verification.
        }
      }))
    }
    const refundsWithTickets = await Promise.all((refundRows ?? []).map(async refund => {
      const { data: items, error } = await admin.from('payment_refund_items').select('ticket_id').eq('refund_id', refund.id)
      if (error) throw new Error('Refund ticket status could not be loaded.')
      return { refund, ticketIds: (items ?? []).map(item => item.ticket_id) }
    }))

    return respond({
      booking: {
        id: booking.id,
        status: booking.status,
        paymentStatus: booking.payment_status,
        amount: booking.total_amount,
        currency: booking.currency,
        expiresAt: booking.expires_at,
      },
      payment: paymentRow ? {
        id: paymentRow.id,
        reference: paymentRow.provider_reference,
        amountMinor: paymentRow.amount_minor,
        currency: paymentRow.currency,
        status: paymentRow.status,
        initializationStatus: paymentRow.initialization_status,
        authorizationUrl: paymentRow.status === 'pending' && paymentRow.initialization_status === 'initialized'
          ? paymentRow.checkout_url
          : null,
        fulfillmentStatus: paymentRow.fulfillment_status,
        createdAt: paymentRow.created_at,
        verifiedAt: paymentRow.verified_at,
        errorCode: paymentRow.initialization_error_code,
      } : null,
      refunds: refundsWithTickets.map(({ refund, ticketIds }) => ({
        amountMinor: refund.amount_minor,
        currency: refund.currency,
        status: refund.status,
        safeErrorCode: refund.safe_error_code,
        requestedAt: refund.created_at,
        completedAt: refund.completed_at,
        ticketIds,
      })),
    }, 200)
  } catch {
    console.error('get-payment-status: status lookup failed')
    return respond({ error: 'Payment status could not be loaded. Please try again.' }, 503)
  }
})

function respond(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers })
}
