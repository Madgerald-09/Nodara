import { createClient } from 'npm:@supabase/supabase-js@2'
import { initializeBookingPayment } from '../_shared/payment_initialization.ts'
import { PAYSTACK_API, PaymentFlowError, paystackRequest } from '../_shared/paystack.ts'

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to initialize a payment.' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')
    if (!supabaseUrl || !anonKey || !serviceRoleKey || !paystackSecret) {
      return respond({ error: 'Payment service is not configured.' }, 503)
    }
    if (!paystackSecret.startsWith('sk_test_')) {
      return respond({ error: 'This deployment accepts Paystack test credentials only.' }, 503)
    }

    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in before paying for a booking.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user?.email) return respond({ error: 'Your signed-in account could not be verified.' }, 401)
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const body = await request.json().catch(() => null) as { bookingId?: unknown } | null
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) {
      return respond({ error: 'A valid booking ID is required.' }, 400)
    }

    const result = await initializeBookingPayment(bookingId, auth.user.id, auth.user.email, {
      async loadBooking(id) {
        const { data, error } = await admin.from('bookings')
          .select('id,user_id,booking_reference,status,payment_status,total_amount,currency,expires_at')
          .eq('id', id).maybeSingle()
        if (error) throw new PaymentFlowError(503, 'DATABASE_UNAVAILABLE', 'Booking could not be checked. Please try again.')
        return data
      },
      async findPendingPayment(id) {
        const { data, error } = await admin.from('payments')
          .select('id,internal_reference,provider_reference,amount_minor,currency,status,initialization_status,checkout_url')
          .eq('booking_id', id).eq('status', 'pending').maybeSingle()
        if (error) throw new PaymentFlowError(503, 'DATABASE_UNAVAILABLE', 'Payment setup could not be checked. Please try again.')
        return data
      },
      async createPendingPayment(input) {
        const { data, error } = await admin.from('payments').insert({
          booking_id: input.bookingId,
          provider: 'paystack',
          internal_reference: input.reference,
          provider_reference: input.reference,
          amount_minor: input.amountMinor,
          currency: input.currency,
          status: 'pending',
          initialization_status: 'pending',
          safe_metadata: { source: 'payment_edge_function' },
        }).select('id,internal_reference,provider_reference,amount_minor,currency,status,initialization_status,checkout_url').single()
        if (error || !data) throw error ?? new PaymentFlowError(503, 'DATABASE_UNAVAILABLE', 'Payment record could not be created.')
        return data
      },
      async initializeProvider(input) {
        const result = await paystackRequest<PaystackInitializeResponse>(`${PAYSTACK_API}/transaction/initialize`, paystackSecret, {
          method: 'POST',
          body: JSON.stringify({
            email: auth.user.email,
            amount: input.amountMinor,
            currency: input.currency,
            reference: input.reference,
          }),
        })
        if (result.httpStatus < 200 || result.httpStatus >= 300 || result.body.status !== true) {
          const status = result.httpStatus >= 400 && result.httpStatus < 500 ? 422 : 503
          throw new PaymentFlowError(status, 'PAYSTACK_INIT_REJECTED', 'Paystack did not accept the payment request.')
        }
        return result.body
      },
      async saveInitialization(paymentId, authorizationUrl) {
        const { data, error } = await admin.from('payments').update({
          initialization_status: 'initialized',
          initialization_error_code: null,
          checkout_url: authorizationUrl,
          safe_metadata: { source: 'payment_edge_function', initialization: 'accepted' },
        }).eq('id', paymentId).eq('status', 'pending').select('id').maybeSingle()
        if (error || !data) throw new PaymentFlowError(503, 'DATABASE_UPDATE_FAILED', 'Paystack accepted the payment, but checkout details could not be saved. Check payment status before retrying.')
      },
      async failInitialization(paymentId, errorCode) {
        const { error } = await admin.from('payments').update({
          status: 'failed', initialization_status: 'failed', initialization_error_code: errorCode,
        }).eq('id', paymentId).eq('status', 'pending')
        if (error) throw new PaymentFlowError(503, 'DATABASE_UPDATE_FAILED', 'Payment setup failed and needs a status check.')
      },
      async markInitializationUnknown(paymentId, errorCode) {
        const { error } = await admin.from('payments').update({
          initialization_status: 'unknown', initialization_error_code: safeErrorCode(errorCode),
        }).eq('id', paymentId).eq('status', 'pending')
        if (error) throw new PaymentFlowError(503, 'DATABASE_UPDATE_FAILED', 'Payment setup needs a status check before retrying.')
      },
    })

    return respond({
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      amountMinor: result.amountMinor,
      currency: result.currency,
      idempotent: result.idempotent,
    }, 200)
  } catch (error) {
    if (error instanceof PaymentFlowError) return respond({ error: error.message, code: error.errorCode }, error.httpStatus)
    console.error('initialize-paystack-payment: unhandled failure')
    return respond({ error: 'Payment setup could not be completed. Check your booking status before retrying.' }, 500)
  }
})

type PaystackInitializeResponse = {
  status: boolean
  data?: { authorization_url?: string; access_code?: string; reference?: string }
}

function safeErrorCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'PAYSTACK_UNAVAILABLE'
}

function respond(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers })
}
