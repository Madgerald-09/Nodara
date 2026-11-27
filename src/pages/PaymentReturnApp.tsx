import { useCallback, useEffect, useState } from 'react'
import type { NavigateFunction } from './OrganiserApp'
import { NodaraLogo } from '../components/NodaraLogo'
import { supabase, supabaseConfigError } from '../lib/supabase'
import { getBookingPaymentStatus } from '../services/bookingService'
import type { BookingPaymentStatus } from '../services/bookingService'
import { findPaymentBooking, getPaymentViewState } from '../services/paymentPresentation'
import '../Organiser.css'
import '../Payment.css'

const POLL_INTERVAL_MS = 5000
const MAX_POLLS = 12

export function PaymentReturnApp({ navigate }: { navigate: NavigateFunction }) {
  const [bookingId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search)
    // Paystack callback parameters are used only to look up our local booking. They do not prove payment.
    const reference = params.get('reference') ?? params.get('trxref') ?? ''
    return reference ? findPaymentBooking(reference) : null
  })
  const [status, setStatus] = useState<BookingPaymentStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pollCount, setPollCount] = useState(0)
  const [signedIn, setSignedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => { if (active) { setSignedIn(Boolean(data.session?.user)); setAuthLoading(false) } })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session?.user)); setAuthLoading(false) })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [])

  const refresh = useCallback(async () => {
    if (!bookingId || !signedIn) return
    setLoading(true)
    setError('')
    const result = await getBookingPaymentStatus(bookingId)
    if (result.error || !result.status) setError(result.error ?? 'Payment status is not available yet.')
    else { setStatus(result.status); setPollCount(count => count + 1) }
    setLoading(false)
  }, [bookingId, signedIn])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const viewState = getPaymentViewState(status)
  useEffect(() => {
    if (!status || pollCount >= MAX_POLLS || ['confirmed', 'failed', 'expired', 'manual_review', 'refunded'].includes(viewState)) return
    const timer = window.setTimeout(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [pollCount, refresh, status, viewState])

  const heading: Record<string, string> = {
    awaiting_payment: 'Payment has not been confirmed.', processing: 'Checking your payment.', confirmed: 'Your booking is confirmed.',
    failed: 'Payment was not completed.', expired: 'This reservation has expired.', manual_review: 'Your payment needs a review.', refunded: 'Payment refunded.',
  }
  const description: Record<string, string> = {
    awaiting_payment: 'The payment provider has not confirmed this booking yet. You can check again shortly.',
    processing: 'We are waiting for the verified payment and booking update. Keep this page open or return to My Tickets later.',
    confirmed: 'The server has verified the payment and finalized the booking. Any issued tickets are available in My Tickets.',
    failed: 'No confirmed booking was created. Check My Tickets for the latest reservation status.',
    expired: 'The ticket reservation window ended before the booking could be finalized.',
    manual_review: 'The payment was received, but ticket fulfillment needs help from the NODARA team. Please contact support with your booking reference.',
    refunded: 'This payment has been refunded. No active tickets are shown for this payment.',
  }

  return <div className="organiser-page payment-page"><header className="organiser-topbar"><button className="brand organiser-brand" onClick={() => navigate('/')}><NodaraLogo/><small>PAYMENT STATUS</small></button><button className="organiser-quiet" onClick={() => navigate('/my-tickets')}>My tickets →</button></header><main className="payment-return-content">
    <div className="tiny-label">SECURE BOOKING UPDATE</div>
    <section className="organiser-panel payment-state-panel" aria-live="polite">
      {supabaseConfigError ? <><span className="payment-state-icon">!</span><h1>Payment status unavailable</h1><p>{supabaseConfigError}</p></> : authLoading ? <><span className="payment-state-icon"><span className="organiser-spinner"/></span><h1>Checking your NODARA session.</h1><p>Retrieving your account state before checking the booking.</p></> : !signedIn ? <><span className="payment-state-icon">↗</span><h1>Sign in to check your booking.</h1><p>We need your NODARA account to retrieve the private booking status. The payment return link itself is not proof of payment.</p><button className="organiser-button organiser-button-primary" onClick={() => navigate('/my-tickets')}>Sign in to My Tickets</button></> : !bookingId ? <><span className="payment-state-icon">?</span><h1>Booking details not found on this device.</h1><p>Open My Tickets while signed in to check your payment. No ticket is issued from this return link.</p><button className="organiser-button organiser-button-primary" onClick={() => navigate('/my-tickets')}>Open My Tickets</button></> : <>
        <span className={`payment-state-icon state-${viewState}`}>{loading && !status ? <span className="organiser-spinner"/> : viewState === 'confirmed' ? '✓' : viewState === 'failed' || viewState === 'expired' ? '!' : '·'}</span>
        <span className={`status-badge ${viewState === 'confirmed' ? 'status-published' : viewState === 'failed' || viewState === 'expired' ? 'status-cancelled' : 'status-draft'}`}>{viewState.replace('_', ' ').toUpperCase()}</span>
        <h1>{heading[viewState]}</h1><p>{description[viewState]}</p>
        {status && <div className="payment-booking-summary"><span>{status.booking.id === bookingId ? `Booking ${bookingId.slice(0, 8).toUpperCase()}` : 'Booking'}</span><strong>{new Intl.NumberFormat('en', { style: 'currency', currency: status.booking.currency }).format(Number(status.booking.amount))}</strong></div>}
        {error && <div className="form-error" role="alert">{error}</div>}
        {viewState === 'manual_review' && status?.booking && <p className="payment-reference">Booking ID: {status.booking.id}</p>}
        {(error || ['awaiting_payment', 'processing'].includes(viewState)) && <button className="organiser-button organiser-button-primary" onClick={() => void refresh()} disabled={loading}>{loading ? 'Checking…' : 'Check status again'}</button>}
        <button className="organiser-quiet payment-tickets-link" onClick={() => navigate('/my-tickets')}>Go to My Tickets</button>
      </>}
    </section>
  </main></div>
}
