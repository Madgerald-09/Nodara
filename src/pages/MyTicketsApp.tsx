import { useEffect, useRef, useState } from 'react'
import type { NavigateFunction } from './OrganiserApp'
import { supabase, supabaseConfigError } from '../lib/supabase'
import { getBookingPaymentStatus, getMyBookings, getMyTickets, initializePaystackPayment, requestPaystackRefund } from '../services/bookingService'
import type { BookingPaymentStatus, TicketView } from '../services/bookingService'
import { canShowTicketQr, getPaymentViewState, getRefundStatusLabel, isDisplayableTicket, rememberPaymentBooking } from '../services/paymentPresentation'
import { signIn } from '../services/authService'
import { SolanaWalletControl } from '../components/SolanaWalletControl'
import { ChainTicketCheck } from '../components/ChainTicketCheck'
import { OnChainTicketTransfer } from '../components/OnChainTicketTransfer'
import { ClaimTransferredTicket } from '../components/ClaimTransferredTicket'
import '../Organiser.css'
import '../Payment.css'

const ticketPageNow = Date.now()

type BookingRow = { id: string; booking_reference: string; status: string; payment_status: string; total_amount: number; currency: string; expires_at: string | null; created_at: string; event_id: string; event_title: string; event_start: string; event_location: string; event_cover_image: string | null }

export function MyTicketsApp({ navigate }: { navigate: NavigateFunction }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [tickets, setTickets] = useState<TicketView[]>([])
  const [ticketReload, setTicketReload] = useState(0)
  const [transferNotice, setTransferNotice] = useState('')
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [paymentStatuses, setPaymentStatuses] = useState<Record<string, BookingPaymentStatus>>({})
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({})
  const [paymentBusy, setPaymentBusy] = useState<Record<string, boolean>>({})
  const paymentBusyRef = useRef<Record<string, boolean>>({})
  const refundKeys = useRef<Record<string, string>>({})
  const [refundBusy, setRefundBusy] = useState<Record<string, boolean>>({})
  const [refundMessages, setRefundMessages] = useState<Record<string, string>>({})
  const [qrImages, setQrImages] = useState<Record<string, string>>({})
  const [error, setError] = useState(supabase ? '' : 'Supabase is not configured.')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => { if (active) { setUserId(data.session?.user.id ?? null); setLoading(Boolean(data.session?.user)) } })
    const { data } = supabase.auth.onAuthStateChange((event, session) => { setUserId(session?.user.id ?? null); if (event === 'SIGNED_IN') setLoading(true); if (event === 'SIGNED_OUT') setLoading(false) })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (!userId) return
    let active = true
    Promise.all([getMyTickets(), getMyBookings()]).then(([ticketResult, bookingResult]) => {
      if (!active) return
      setTickets(ticketResult.tickets)
      const nextBookings = bookingResult.bookings as BookingRow[]
      setBookings(nextBookings)
      setPaymentStatuses({})
      setPaymentErrors({})
      setError(ticketResult.error ?? bookingResult.error ?? '')
      setLoading(false)
      const payableBookings = nextBookings.filter(booking => booking.payment_status !== 'not_required' || booking.status !== 'confirmed')
      void Promise.all(payableBookings.map(async booking => {
        const result = await getBookingPaymentStatus(booking.id)
        return [booking.id, result] as const
      })).then(results => {
        if (!active) return
        const statuses: Record<string, BookingPaymentStatus> = {}
        const errors: Record<string, string> = {}
        for (const [id, result] of results) {
          if (result.status) statuses[id] = result.status
          if (result.error) errors[id] = result.error
        }
        setPaymentStatuses(statuses)
        setPaymentErrors(errors)
      })
    })
    return () => { active = false }
  }, [userId, ticketReload])
  useEffect(() => {
    if (!tickets.length) return
    let active = true
    void import('qrcode').then(({ default: QRCode }) => Promise.all(tickets.map(async ticket => [ticket.ticket_id, await QRCode.toDataURL(`NODARA:TICKET:${ticket.qr_token}`, { width: 240, margin: 1, color: { dark: '#0a0e0b', light: '#ffffff' } })] as const)))
      .then(entries => { if (active) setQrImages(Object.fromEntries(entries)) })
      .catch(() => { if (active) setError('A ticket QR code could not be displayed. Refresh and try again.') })
    return () => { active = false }
  }, [tickets])
  const validTickets = tickets.filter(isDisplayableTicket)
  const upcomingTickets = validTickets.filter(ticket => new Date(ticket.event_start).getTime() >= ticketPageNow)
  const pastTickets = validTickets.filter(ticket => new Date(ticket.event_start).getTime() < ticketPageNow)
  const refreshPayment = async (bookingId: string) => {
    const result = await getBookingPaymentStatus(bookingId)
    if (result.status) setPaymentStatuses(current => ({ ...current, [bookingId]: result.status! }))
    setPaymentErrors(current => ({ ...current, [bookingId]: result.error ?? '' }))
  }
  const requestTicketRefund = async (paymentId: string, ticket: TicketView) => {
    if (refundBusy[ticket.ticket_id]) return
    const key = `${paymentId}:${ticket.ticket_id}`
    refundKeys.current[key] ??= crypto.randomUUID()
    setRefundBusy(current => ({ ...current, [ticket.ticket_id]: true }))
    setRefundMessages(current => ({ ...current, [ticket.ticket_id]: '' }))
    try {
      const result = await requestPaystackRefund(paymentId, [ticket.ticket_id], refundKeys.current[key])
      if (result.error) {
        if (!result.retryable) delete refundKeys.current[key]
        throw new Error(result.error)
      }
      if (result.refund?.status === 'failed' || result.refund?.status === 'cancelled') delete refundKeys.current[key]
      setRefundMessages(current => ({ ...current, [ticket.ticket_id]: `Refund ${result.refund?.status ?? 'processing'}.` }))
      const booking = bookings.find(item => item.booking_reference === ticket.booking_reference)
      if (booking) await refreshPayment(booking.id)
    } catch (cause) {
      setRefundMessages(current => ({ ...current, [ticket.ticket_id]: cause instanceof Error ? cause.message : 'Refund request could not be submitted.' }))
    } finally { setRefundBusy(current => ({ ...current, [ticket.ticket_id]: false })) }
  }
  const continueCheckout = async (booking: BookingRow) => {
    if (paymentBusyRef.current[booking.id]) return
    paymentBusyRef.current[booking.id] = true
    setPaymentBusy(current => ({ ...current, [booking.id]: true }))
    setPaymentErrors(current => ({ ...current, [booking.id]: '' }))
    try {
      let authorizationUrl = paymentStatuses[booking.id]?.payment?.authorizationUrl ?? null
      let reference = paymentStatuses[booking.id]?.payment?.reference ?? ''
      if (!authorizationUrl) {
        const initialized = await initializePaystackPayment(booking.id)
        authorizationUrl = initialized.payment?.authorizationUrl ?? null
        reference = initialized.payment?.reference ?? reference
        if (initialized.error) throw new Error(initialized.error)
      }
      const url = authorizationUrl ? new URL(authorizationUrl) : null
      if (!url || url.protocol !== 'https:' || url.hostname !== 'checkout.paystack.com') throw new Error('Secure checkout is not available yet. Refresh the payment status and retry.')
      if (reference) rememberPaymentBooking(reference, booking.id)
      window.location.assign(url.toString())
    } catch (cause) {
      setPaymentErrors(current => ({ ...current, [booking.id]: cause instanceof Error ? cause.message : 'Checkout could not be opened.' }))
    } finally {
      paymentBusyRef.current[booking.id] = false
      setPaymentBusy(current => ({ ...current, [booking.id]: false }))
    }
  }
  if (supabaseConfigError) return <div className="organiser-page"><div className="organiser-center-card"><h1>Tickets need setup</h1><p>{supabaseConfigError}</p><button className="organiser-button" onClick={() => navigate('/')}>Back to discovery</button></div></div>
  if (loading) return <div className="organiser-page"><div className="organiser-loading"><span className="organiser-spinner"/>Loading your tickets…</div></div>
  return <div className="organiser-page tickets-page"><header className="organiser-topbar"><button className="brand organiser-brand" onClick={() => navigate('/')}><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span><small>MY TICKETS</small></button><div className="organiser-top-actions"><SolanaWalletControl/><button className="organiser-quiet" onClick={() => navigate('/')}>Back to discovery</button></div></header><main className="tickets-content"><div className="tiny-label">YOUR NODARA WALLET</div><h1>My tickets</h1><p className="ticket-page-intro">Your confirmed tickets and current booking requests.</p>{!userId ? <section className="organiser-panel ticket-signin"><span className="tiny-label">ACCOUNT ACCESS</span><h2>Sign in to view your tickets.</h2><p>Tickets are linked to your NODARA account.</p><form onSubmit={event => { event.preventDefault(); setError(''); setSigningIn(true); void signIn(email.trim(), password).then(result => { setSigningIn(false); if (result.error) setError(result.error.message) }) }}><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email"/></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password"/></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="organiser-button organiser-button-primary" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}</button></form></section> : error ? <div className="form-error" role="alert">{error}</div> : loading ? null : <>
    <ClaimTransferredTicket userId={userId} onClaimed={() => setTicketReload(value => value + 1)}/>
    {transferNotice && <div className="form-success transfer-complete-notice" role="status">{transferNotice}</div>}
    {bookings.filter(booking => booking.payment_status !== 'not_required' || booking.status !== 'confirmed').map(booking => {
      const paymentStatus = paymentStatuses[booking.id] ?? null
      const viewState = getPaymentViewState(paymentStatus)
      const labels = { awaiting_payment: 'Awaiting payment', processing: 'Payment processing', confirmed: 'Confirmed', failed: 'Payment failed', expired: 'Reservation expired', manual_review: 'Manual review required', refunded: 'Refunded', partially_refunded: 'Partially refunded' }
      const canContinue = viewState === 'awaiting_payment' && booking.expires_at !== null && new Date(booking.expires_at).getTime() > Date.now()
      const explanations = {
        awaiting_payment: 'No payment has been verified yet. Tickets are issued only after server-side confirmation.',
        processing: 'Payment is being checked. Refresh this status; do not start another booking.',
        confirmed: 'Payment and booking fulfillment are confirmed. Any issued tickets appear below.',
        failed: 'Payment was not completed. Check the status again if you believe this is incorrect.',
        expired: 'The ticket reservation window ended before the booking was finalized.',
        manual_review: 'Payment needs review before tickets can be issued. Contact NODARA support with this booking reference.',
        refunded: 'This payment has been refunded. Refunded tickets are no longer usable.',
        partially_refunded: 'Some tickets in this booking were refunded. Remaining issued tickets stay valid.',
      }
      return <article className="pending-booking-card payment-booking-card" key={booking.id}>
        <div><span className={`status-badge ${viewState === 'confirmed' ? 'status-published' : viewState === 'failed' || viewState === 'expired' || viewState === 'refunded' ? 'status-cancelled' : 'status-draft'}`}>{labels[viewState]}</span><h2>{booking.event_title}</h2><p>Reference {booking.booking_reference} · Created {new Date(booking.created_at).toLocaleString()}</p></div>
        <strong>{new Intl.NumberFormat('en', { style: 'currency', currency: booking.currency }).format(booking.total_amount)}</strong>
        <small>{paymentErrors[booking.id] ? `Status lookup: ${paymentErrors[booking.id]}` : explanations[viewState]}</small>
        {(paymentStatus?.refunds ?? []).map((refund, index) => <small className="refund-status-line" key={`${booking.id}-refund-${index}`}>
          Refund {new Intl.NumberFormat('en', { style: 'currency', currency: refund.currency }).format(Number(refund.amountMinor) / 100)} · {getRefundStatusLabel(refund.status, refund.safeErrorCode)} · {new Date(refund.completedAt ?? refund.requestedAt).toLocaleString()}
        </small>)}
        <div className="payment-card-actions">{canContinue && <button className="organiser-button organiser-button-primary" onClick={() => void continueCheckout(booking)} disabled={Boolean(paymentBusy[booking.id])}>{paymentBusy[booking.id] ? 'Opening checkout…' : paymentStatus?.payment?.authorizationUrl ? 'Continue checkout' : 'Retry checkout setup'}</button>}<button className="organiser-button" onClick={() => void refreshPayment(booking.id)}>Refresh status</button></div>
      </article>
    })}
    <section>
      <div className="ticket-section-heading"><h2>Upcoming tickets</h2><span>{upcomingTickets.length} {upcomingTickets.length === 1 ? 'ticket' : 'tickets'}</span></div>
      {upcomingTickets.length ? <div className="digital-ticket-list">{upcomingTickets.map(ticket => {
        const booking = bookings.find(item => item.booking_reference === ticket.booking_reference)
        const paymentStatus = booking ? paymentStatuses[booking.id] : null
        const payment = paymentStatus?.payment ?? null
        const ticketRefund = paymentStatus?.refunds.find(refund => refund.ticketIds.includes(ticket.ticket_id))
        const refundActive = Boolean(ticketRefund && !['failed', 'cancelled'].includes(ticketRefund.status))
        const showQr = canShowTicketQr(ticket, paymentStatus)
        const qrBlockedMessage = ticket.ticket_status === 'checked_in' ? 'Already checked in.'
          : refundActive ? 'Refund is pending. This ticket is temporarily unavailable.'
          : !paymentStatus && ticket.payment_status !== 'not_required' ? 'Checking payment and refund status…'
          : !showQr ? 'Ticket status could not be confirmed.' : undefined
        const canRefund = Boolean(payment && ['successful', 'partially_refunded'].includes(payment.status)
          && ticket.ticket_status === 'issued' && ticket.blockchain_status === 'off_chain' && !refundActive)
        return <TicketCard key={ticket.ticket_id} ticket={ticket} qrImage={qrImages[ticket.ticket_id]} canShowQr={showQr} qrBlockedMessage={qrBlockedMessage}
          canRefund={canRefund} refundBusy={Boolean(refundBusy[ticket.ticket_id])}
          refundMessage={refundMessages[ticket.ticket_id]}
          onRequestRefund={() => {
            if (payment && window.confirm('Request a refund for this ticket? The amount will be calculated from the recorded ticket price.')) {
              void requestTicketRefund(payment.id, ticket)
            }
          }}
          onTransferred={notice => {
            setTransferNotice(notice)
            setTickets(current => current.filter(item => item.ticket_id !== ticket.ticket_id))
            setTicketReload(value => value + 1)
          }}/>
      })}</div> : <div className="organiser-panel organiser-empty"><span className="empty-diamond">✳</span><h2>No upcoming tickets.</h2><p>When you book a free event, your ticket will appear here. Paid bookings remain pending until payment is verified.</p><button className="organiser-button" onClick={() => navigate('/')}>Discover experiences →</button></div>}
      {pastTickets.length > 0 && <><div className="ticket-section-heading"><h2>Past tickets</h2><span>{pastTickets.length}</span></div><div className="digital-ticket-list">{pastTickets.map(ticket => { const booking = bookings.find(item => item.booking_reference === ticket.booking_reference); const paymentStatus = booking ? paymentStatuses[booking.id] : null; const showQr = canShowTicketQr(ticket, paymentStatus); return <TicketCard key={ticket.ticket_id} ticket={ticket} qrImage={qrImages[ticket.ticket_id]} canShowQr={showQr} qrBlockedMessage={ticket.ticket_status === 'checked_in' ? 'Already checked in.' : !showQr ? 'Ticket status could not be confirmed.' : undefined} canRefund={false} refundBusy={false} onRequestRefund={() => {}} onTransferred={notice => { setTransferNotice(notice); setTickets(current => current.filter(item => item.ticket_id !== ticket.ticket_id)); setTicketReload(value => value + 1) }}/>})}</div></>}
    </section>
  </>}</main></div>
}

function TicketCard({ ticket, qrImage, canShowQr = false, qrBlockedMessage, onTransferred, canRefund, refundBusy, refundMessage, onRequestRefund }: { ticket: TicketView; qrImage?: string; canShowQr?: boolean; qrBlockedMessage?: string; onTransferred: (notice: string) => void; canRefund: boolean; refundBusy: boolean; refundMessage?: string; onRequestRefund: () => void }) {
  const statusLabel = ticket.ticket_status === 'checked_in' ? 'CHECKED IN' : ticket.ticket_status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'
  const statusClass = ticket.ticket_status === 'cancelled' ? 'status-cancelled' : 'status-published'
  return <article className="digital-ticket"><div className="digital-ticket-info"><span className={`status-badge ${statusClass}`}>{statusLabel}</span><h3>{ticket.event_title}</h3><p>{new Date(ticket.event_start).toLocaleString()} · {ticket.location}{ticket.venue ? ` · ${ticket.venue}` : ''}</p><p>{ticket.ticket_type} · Booking {ticket.booking_reference}</p><small>Ticket {ticket.ticket_id.slice(0, 8).toUpperCase()} · {ticket.blockchain_status === 'off_chain' ? 'Digital ticket · off-chain' : `Database status: ${ticket.blockchain_status}`}</small>{canRefund && <button className="organiser-button refund-request-button" disabled={refundBusy} onClick={onRequestRefund}>{refundBusy ? 'Requesting refund…' : 'Request ticket refund'}</button>}{refundMessage && <small className="refund-status-line" role="status">{refundMessage}</small>}<SolanaWalletControl/>{ticket.solana_ticket_account && <ChainTicketCheck ticketId={ticket.ticket_id} eventId={ticket.event_id} accountAddress={ticket.solana_ticket_account} eventAccountAddress={ticket.solana_event_account ?? null}/>}<OnChainTicketTransfer ticket={ticket} onTransferred={onTransferred}/></div><div className="ticket-qr">{canShowQr && qrImage ? <img src={qrImage} alt={`Secure ticket QR for ${ticket.event_title}`}/> : <span>{ticket.ticket_status === 'cancelled' ? 'Ticket cancelled' : qrBlockedMessage ?? 'Checking ticket status…'}</span>}</div></article>
}
