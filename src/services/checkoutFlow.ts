import type { BookingResult, PaymentInitialization } from './bookingService'
import { isFreeConfirmedBooking } from './paymentPresentation.ts'

export type CheckoutFlowResult =
  | { kind: 'confirmed'; booking: BookingResult }
  | { kind: 'redirecting'; booking: BookingResult; payment: PaymentInitialization }
  | { kind: 'initialization_failed'; booking: BookingResult; error: string }
  | { kind: 'failed'; error: string }

type CheckoutDependencies = {
  createBooking: (eventId: string, items: { ticket_type_id: string; quantity: number }[]) => Promise<{ booking: BookingResult | null; error: string | null }>
  initializePayment: (bookingId: string) => Promise<{ payment: PaymentInitialization | null; error: string | null }>
  rememberBooking: (reference: string, bookingId: string) => void
  redirect: (url: string) => void
}

export async function startBookingCheckout(
  eventId: string,
  items: { ticket_type_id: string; quantity: number }[],
  dependencies: CheckoutDependencies,
): Promise<CheckoutFlowResult> {
  const created = await dependencies.createBooking(eventId, items)
  if (created.error || !created.booking) return { kind: 'failed', error: created.error ?? 'Booking could not be created.' }
  const booking = created.booking
  if (isFreeConfirmedBooking(booking)) return { kind: 'confirmed', booking }
  if (booking.status !== 'payment_pending') return { kind: 'failed', error: 'The booking is not ready for payment.' }

  const initialized = await dependencies.initializePayment(booking.booking_id)
  if (initialized.error || !initialized.payment) return { kind: 'initialization_failed', booking, error: initialized.error ?? 'Checkout could not be started. Your reservation remains available until it expires.' }
  let url: URL
  try { url = new URL(initialized.payment.authorizationUrl) } catch { return { kind: 'initialization_failed', booking, error: 'Checkout returned an invalid address. Check payment status before retrying.' } }
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.paystack.com') return { kind: 'initialization_failed', booking, error: 'Checkout returned an untrusted address. Check payment status before retrying.' }

  dependencies.rememberBooking(initialized.payment.reference, booking.booking_id)
  dependencies.redirect(url.toString())
  return { kind: 'redirecting', booking, payment: initialized.payment }
}
