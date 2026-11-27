import type { BookingPaymentStatus, BookingResult, TicketView } from './bookingService'

export type PaymentViewState = 'awaiting_payment' | 'processing' | 'confirmed' | 'failed' | 'expired' | 'manual_review' | 'refunded' | 'partially_refunded'

export function getPaymentViewState(status: BookingPaymentStatus | null): PaymentViewState {
  if (!status) return 'processing'
  const booking = status.booking
  const payment = status.payment
  if (booking.paymentStatus === 'refunded' || payment?.status === 'refunded') return 'refunded'
  if (payment?.status === 'partially_refunded') return 'partially_refunded'
  if (payment?.fulfillmentStatus === 'manual_review') return 'manual_review'
  if (booking.status === 'expired' || payment?.status === 'expired') return 'expired'
  if (payment?.status === 'failed' || booking.paymentStatus === 'failed') return 'failed'
  if (booking.status === 'confirmed' && (booking.paymentStatus === 'not_required' || (booking.paymentStatus === 'verified' && payment?.status === 'successful' && payment.fulfillmentStatus === 'fulfilled'))) return 'confirmed'
  if (payment?.status === 'successful' || booking.paymentStatus === 'verified' || payment?.initializationStatus === 'unknown') return 'processing'
  return 'awaiting_payment'
}

export function getRefundStatusLabel(status: string, safeErrorCode?: string | null) {
  if (safeErrorCode === 'PROVIDER_NEEDS_ATTENTION') return 'needs attention'
  return status.replaceAll('_', ' ')
}

const RETURN_BOOKINGS_KEY = 'nodara-payment-return-bookings'

export function rememberPaymentBooking(reference: string, bookingId: string, storage: Storage = window.localStorage) {
  try {
    const current = JSON.parse(storage.getItem(RETURN_BOOKINGS_KEY) ?? '{}') as Record<string, string>
    current[reference] = bookingId
    const entries = Object.entries(current).slice(-20)
    storage.setItem(RETURN_BOOKINGS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* Storage can be unavailable in private browsing; the callback still is not trusted. */ }
}

export function findPaymentBooking(reference: string, storage: Storage = window.localStorage): string | null {
  try {
    const current = JSON.parse(storage.getItem(RETURN_BOOKINGS_KEY) ?? '{}') as Record<string, unknown>
    const bookingId = current[reference]
    return typeof bookingId === 'string' ? bookingId : null
  } catch { return null }
}

export function isFreeConfirmedBooking(booking: BookingResult) {
  return booking.status === 'confirmed' && booking.payment_status === 'not_required'
}

export function isDisplayableTicket(ticket: TicketView) {
  return ticket.booking_status === 'confirmed'
    && (ticket.payment_status === 'verified' || ticket.payment_status === 'not_required')
    && (ticket.ticket_status === 'issued' || ticket.ticket_status === 'checked_in')
}

/**
 * Only expose a ticket QR after the trusted payment endpoint has confirmed
 * fulfillment. A pending/succeeded refund temporarily removes the QR while
 * synchronization is in progress; the server remains the final check-in gate.
 */
export function canShowTicketQr(ticket: TicketView, status: BookingPaymentStatus | null) {
  if (!isDisplayableTicket(ticket) || ticket.ticket_status !== 'issued') return false
  if (ticket.payment_status === 'not_required') return true
  if (!status || status.booking.status !== 'confirmed' || status.booking.paymentStatus !== 'verified'
    || !status.payment || !['successful', 'partially_refunded'].includes(status.payment.status)
    || status.payment.fulfillmentStatus !== 'fulfilled') return false
  const refund = status.refunds.find(item => item.ticketIds.includes(ticket.ticket_id))
  return !refund || ['failed', 'cancelled'].includes(refund.status)
}
