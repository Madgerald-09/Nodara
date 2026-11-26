import { useEffect, useState } from 'react'
import type { NavigateFunction } from './OrganiserApp'
import { supabase, supabaseConfigError } from '../lib/supabase'
import { getMyBookings, getMyTickets } from '../services/bookingService'
import type { TicketView } from '../services/bookingService'
import { signIn } from '../services/authService'
import { SolanaWalletControl } from '../components/SolanaWalletControl'
import { ChainTicketCheck } from '../components/ChainTicketCheck'
import { OnChainTicketTransfer } from '../components/OnChainTicketTransfer'
import { ClaimTransferredTicket } from '../components/ClaimTransferredTicket'
import '../Organiser.css'

const ticketPageNow = Date.now()

type BookingRow = { id: string; booking_reference: string; status: string; payment_status: string; total_amount: number; currency: string; expires_at: string | null; created_at: string; event_id: string; event_title: string; event_start: string; event_location: string; event_cover_image: string | null }

export function MyTicketsApp({ navigate }: { navigate: NavigateFunction }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [tickets, setTickets] = useState<TicketView[]>([])
  const [ticketReload, setTicketReload] = useState(0)
  const [transferNotice, setTransferNotice] = useState('')
  const [bookings, setBookings] = useState<BookingRow[]>([])
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
      setBookings(bookingResult.bookings as BookingRow[])
      setError(ticketResult.error ?? bookingResult.error ?? '')
      setLoading(false)
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
  const upcomingTickets = tickets.filter(ticket => new Date(ticket.event_start).getTime() >= ticketPageNow)
  const pastTickets = tickets.filter(ticket => new Date(ticket.event_start).getTime() < ticketPageNow)
  if (supabaseConfigError) return <div className="organiser-page"><div className="organiser-center-card"><h1>Tickets need setup</h1><p>{supabaseConfigError}</p><button className="organiser-button" onClick={() => navigate('/')}>Back to discovery</button></div></div>
  if (loading) return <div className="organiser-page"><div className="organiser-loading"><span className="organiser-spinner"/>Loading your tickets…</div></div>
  return <div className="organiser-page tickets-page"><header className="organiser-topbar"><button className="brand organiser-brand" onClick={() => navigate('/')}><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span><small>MY TICKETS</small></button><div className="organiser-top-actions"><SolanaWalletControl/><button className="organiser-quiet" onClick={() => navigate('/')}>Back to discovery</button></div></header><main className="tickets-content"><div className="tiny-label">YOUR NODARA WALLET</div><h1>My tickets</h1><p className="ticket-page-intro">Your confirmed tickets and current booking requests.</p>{!userId ? <section className="organiser-panel ticket-signin"><span className="tiny-label">ACCOUNT ACCESS</span><h2>Sign in to view your tickets.</h2><p>Tickets are linked to your NODARA account.</p><form onSubmit={event => { event.preventDefault(); setError(''); setSigningIn(true); void signIn(email.trim(), password).then(result => { setSigningIn(false); if (result.error) setError(result.error.message) }) }}><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email"/></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password"/></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="organiser-button organiser-button-primary" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}</button></form></section> : error ? <div className="form-error" role="alert">{error}</div> : loading ? null : <>
    <ClaimTransferredTicket userId={userId} onClaimed={() => setTicketReload(value => value + 1)}/>
    {transferNotice && <div className="form-success transfer-complete-notice" role="status">{transferNotice}</div>}
    {bookings.filter(booking => booking.status === 'payment_pending' || booking.status === 'pending').map(booking => <article className="pending-booking-card" key={booking.id}><div><span className="status-badge status-draft">PAYMENT PENDING</span><h2>{booking.event_title}</h2><p>Reference {booking.booking_reference} · {new Date(booking.expires_at ?? booking.created_at).toLocaleString()}</p></div><strong>{new Intl.NumberFormat('en', { style: 'currency', currency: booking.currency }).format(booking.total_amount)}</strong><small>No payment has been verified and no ticket has been issued.</small></article>)}
    <section><div className="ticket-section-heading"><h2>Upcoming tickets</h2><span>{upcomingTickets.length} {upcomingTickets.length === 1 ? 'ticket' : 'tickets'}</span></div>{upcomingTickets.length ? <div className="digital-ticket-list">{upcomingTickets.map(ticket => <TicketCard key={ticket.ticket_id} ticket={ticket} qrImage={qrImages[ticket.ticket_id]} onTransferred={notice => { setTransferNotice(notice); setTickets(current => current.filter(item => item.ticket_id !== ticket.ticket_id)); setTicketReload(value => value + 1) }}/>)}</div> : <div className="organiser-panel organiser-empty"><span className="empty-diamond">✳</span><h2>No upcoming tickets.</h2><p>When you book a free event, your ticket will appear here. Paid bookings remain pending until payment is verified.</p><button className="organiser-button" onClick={() => navigate('/')}>Discover experiences →</button></div>}{pastTickets.length > 0 && <><div className="ticket-section-heading"><h2>Past tickets</h2><span>{pastTickets.length}</span></div><div className="digital-ticket-list">{pastTickets.map(ticket => <TicketCard key={ticket.ticket_id} ticket={ticket} qrImage={qrImages[ticket.ticket_id]} onTransferred={notice => { setTransferNotice(notice); setTickets(current => current.filter(item => item.ticket_id !== ticket.ticket_id)); setTicketReload(value => value + 1) }}/>)}</div></>}</section>
  </>}</main></div>
}

function TicketCard({ ticket, qrImage, onTransferred }: { ticket: TicketView; qrImage?: string; onTransferred: (notice: string) => void }) {
  const statusLabel = ticket.ticket_status === 'checked_in' ? 'CHECKED IN' : ticket.ticket_status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'
  const statusClass = ticket.ticket_status === 'cancelled' ? 'status-cancelled' : 'status-published'
  return <article className="digital-ticket"><div className="digital-ticket-info"><span className={`status-badge ${statusClass}`}>{statusLabel}</span><h3>{ticket.event_title}</h3><p>{new Date(ticket.event_start).toLocaleString()} · {ticket.location}{ticket.venue ? ` · ${ticket.venue}` : ''}</p><p>{ticket.ticket_type} · Booking {ticket.booking_reference}</p><small>Ticket {ticket.ticket_id.slice(0, 8).toUpperCase()} · {ticket.blockchain_status === 'off_chain' ? 'Digital ticket · off-chain' : `Database status: ${ticket.blockchain_status}`}</small><SolanaWalletControl/>{ticket.solana_ticket_account && <ChainTicketCheck ticketId={ticket.ticket_id} eventId={ticket.event_id} accountAddress={ticket.solana_ticket_account} eventAccountAddress={ticket.solana_event_account ?? null}/>}<OnChainTicketTransfer ticket={ticket} onTransferred={onTransferred}/></div><div className="ticket-qr">{ticket.ticket_status === 'cancelled' ? <span>Ticket cancelled</span> : qrImage ? <img src={qrImage} alt={`Secure ticket QR for ${ticket.event_title}`}/> : <span>Preparing QR…</span>}</div></article>
}
