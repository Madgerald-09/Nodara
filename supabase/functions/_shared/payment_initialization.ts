import {
  getReusableCheckout,
  isSafePaystackCheckoutUrl,
  PaymentFlowError,
  validateBookingForInitialization,
  type BookingForPayment,
  type PendingPayment,
} from './paystack.ts'

export type InitializationDependencies = {
  loadBooking: (bookingId: string) => Promise<BookingForPayment | null>
  findPendingPayment: (bookingId: string) => Promise<PendingPayment | null>
  createPendingPayment: (input: { bookingId: string; reference: string; amountMinor: number; currency: string }) => Promise<PendingPayment>
  initializeProvider: (input: { email: string; reference: string; amountMinor: number; currency: string }) => Promise<unknown>
  saveInitialization: (paymentId: string, authorizationUrl: string) => Promise<void>
  failInitialization: (paymentId: string, errorCode: string) => Promise<void>
  markInitializationUnknown: (paymentId: string, errorCode: string) => Promise<void>
  newReference?: () => string
}

export type InitializationResult = {
  authorizationUrl: string
  reference: string
  amountMinor: number
  currency: string
  idempotent: boolean
}

export async function initializeBookingPayment(
  bookingId: string,
  userId: string,
  email: string,
  dependencies: InitializationDependencies,
  nowMs = Date.now(),
): Promise<InitializationResult> {
  if (!bookingId || !userId || !email || email.length > 254) {
    throw new PaymentFlowError(400, 'INVALID_REQUEST', 'Booking and account information are required.')
  }
  const booking = await dependencies.loadBooking(bookingId)
  if (!booking) throw new PaymentFlowError(404, 'BOOKING_NOT_FOUND', 'Booking was not found.')
  const amountMinor = validateBookingForInitialization(booking, userId, nowMs)

  const existing = await dependencies.findPendingPayment(bookingId)
  const reusable = getReusableCheckout(existing)
  if (reusable) return { ...reusable, idempotent: true }
  if (existing) {
    if (existing.initialization_status === 'unknown') {
      throw new PaymentFlowError(503, 'INITIALIZATION_UNCERTAIN', 'Payment setup is being checked. Please check the booking status before trying again.')
    }
    throw new PaymentFlowError(409, 'INITIALIZATION_IN_PROGRESS', 'Payment setup is already in progress for this booking.')
  }

  const reference = `NOD-${(dependencies.newReference ?? (() => crypto.randomUUID()))().replaceAll('-', '').toUpperCase()}`
  let payment: PendingPayment
  try {
    payment = await dependencies.createPendingPayment({
      bookingId,
      reference,
      amountMinor,
      currency: booking.currency,
    })
  } catch (error) {
    if (databaseCode(error) === '23505') {
      const racedPayment = await dependencies.findPendingPayment(bookingId)
      const racedCheckout = getReusableCheckout(racedPayment)
      if (racedCheckout) return { ...racedCheckout, idempotent: true }
      throw new PaymentFlowError(409, 'INITIALIZATION_IN_PROGRESS', 'Payment setup is already in progress for this booking.')
    }
    throw error
  }

  let response: unknown
  try {
    response = await dependencies.initializeProvider({ email, reference, amountMinor, currency: booking.currency })
  } catch (error) {
    const safeError = error instanceof PaymentFlowError ? error.errorCode : 'PAYSTACK_UNAVAILABLE'
    const definiteRejection = error instanceof PaymentFlowError && error.httpStatus >= 400 && error.httpStatus < 500
    if (definiteRejection) {
      await dependencies.failInitialization(payment.id, 'PAYSTACK_INIT_REJECTED')
      throw new PaymentFlowError(502, 'PAYSTACK_INIT_REJECTED', 'Paystack rejected payment setup. You can retry from your booking.')
    }
    await dependencies.markInitializationUnknown(payment.id, safeError)
    throw new PaymentFlowError(503, 'PAYSTACK_INIT_UNCERTAIN', 'Payment setup could not be confirmed. Check the booking status before retrying.')
  }

  const authorizationUrl = extractAuthorizationUrl(response, reference)
  if (!authorizationUrl || !isSafePaystackCheckoutUrl(authorizationUrl)) {
    await dependencies.markInitializationUnknown(payment.id, 'PAYSTACK_INVALID_RESPONSE')
    throw new PaymentFlowError(503, 'PAYSTACK_INVALID_RESPONSE', 'Paystack returned an unexpected checkout response. The payment reference was kept for review.')
  }

  try {
    await dependencies.saveInitialization(payment.id, authorizationUrl)
  } catch {
    try {
      await dependencies.markInitializationUnknown(payment.id, 'DATABASE_UPDATE_FAILED')
    } catch {
      // The pending record and provider reference remain available for webhook reconciliation.
    }
    throw new PaymentFlowError(503, 'DATABASE_UPDATE_FAILED', 'Paystack accepted the payment, but checkout details could not be saved. Check payment status before retrying.')
  }
  return { authorizationUrl, reference, amountMinor, currency: booking.currency, idempotent: false }
}

export function extractAuthorizationUrl(value: unknown, expectedReference: string): string | null {
  if (!isRecord(value) || value.status !== true || !isRecord(value.data)) return null
  if (value.data.reference !== expectedReference) return null
  return typeof value.data.authorization_url === 'string' ? value.data.authorization_url : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function databaseCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}
