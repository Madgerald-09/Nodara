import { useEffect, useMemo, useState } from 'react'
import './PersonalActivityDashboard.css'
import { getBookingPaymentStatus } from '../services/bookingService'
import type { BookingPaymentStatus } from '../services/bookingService'
import { isDisplayableTicket } from '../services/paymentPresentation'
import { buildPersonalActivityTimeline, getPersonalActivityCounts, getPersonalBookingState, isConfirmedPersonalBooking, type PersonalActivityItem, type PersonalBooking } from '../services/personalActivity'
import { loadPersonalActivityDashboard } from '../services/personalActivityService'
import type { PersonalActivityDashboardData } from '../services/personalActivityService'
import type { NavigateFunction } from './OrganiserApp'

type BookingFilter = 'all' | 'confirmed' | 'pending' | 'other'
const EMPTY_BOOKINGS: PersonalBooking[] = []

const labels: Record<string, string> = {
  confirmed: 'Confirmed', awaiting_payment: 'Awaiting payment', processing: 'Payment processing',
  failed: 'Payment failed', expired: 'Reservation expired', cancelled: 'Cancelled',
  manual_review: 'Manual review', refunded: 'Refunded', partially_refunded: 'Partially refunded',
}

function money(amount: number | string, currency: string) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${currency} —`
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value) }
  catch { return `${currency} ${value.toFixed(2)}` }
}

function dateLabel(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Date unavailable'
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function reminderLabel(value: string, now: number) {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time < now) return null
  const hours = Math.ceil((time - now) / 3_600_000)
  if (hours <= 24) return 'Coming up within 24 hours'
  const days = Math.ceil(hours / 24)
  return days <= 7 ? `Coming up in ${days} day${days === 1 ? '' : 's'}` : null
}

function filterBooking(booking: PersonalBooking, state: string, filter: BookingFilter, now: number) {
  if (filter === 'all') return true
  if (filter === 'confirmed') return isConfirmedPersonalBooking(booking) && Date.parse(booking.event_start) >= now
  if (filter === 'pending') return ['payment_pending', 'awaiting_payment', 'processing', 'manual_review'].includes(state)
  return !isConfirmedPersonalBooking(booking) || Date.parse(booking.event_start) < now
}

export function PersonalActivityDashboard({ navigate }: { navigate: NavigateFunction }) {
  const [data, setData] = useState<PersonalActivityDashboardData | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [paymentStatuses, setPaymentStatuses] = useState<Record<string, BookingPaymentStatus>>({})
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({})
  const [paymentLoading, setPaymentLoading] = useState<Record<string, boolean>>({})
  const [paymentChecksComplete, setPaymentChecksComplete] = useState(false)
  const [bookingFilter, setBookingFilter] = useState<BookingFilter>('all')
  const [bookingSearch, setBookingSearch] = useState('')
  const [bookingVisible, setBookingVisible] = useState(8)
  const [activityVisible, setActivityVisible] = useState(10)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void loadPersonalActivityDashboard().then(result => {
      if (!active) return
      setSignedIn(result.signedIn)
      setData(result.data)
      setError(result.error?.message ?? '')
      setPaymentStatuses({})
      setPaymentErrors({})
      setPaymentChecksComplete(false)
      setLoading(false)
    }).catch(cause => {
      if (active) { setError(cause instanceof Error ? cause.message : 'Your activity could not be loaded.'); setLoading(false) }
    })
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    if (!data) return
    let active = true
    const recentPaid = data.bookings.filter(booking => booking.payment_status !== 'not_required'
      && booking.status !== 'cancelled').slice(0, 8)
    void Promise.all(recentPaid.map(async booking => [booking.id, await getBookingPaymentStatus(booking.id)] as const))
      .then(results => {
        if (!active) return
        const statuses: Record<string, BookingPaymentStatus> = {}
        const errors: Record<string, string> = {}
        for (const [id, result] of results) {
          if (result.status) statuses[id] = result.status
          if (result.error) errors[id] = result.error
        }
        setPaymentStatuses(statuses)
        setPaymentErrors(errors)
        setPaymentChecksComplete(true)
      })
    return () => { active = false }
  }, [data])

  const bookings = data?.bookings ?? EMPTY_BOOKINGS
  const [now] = useState(() => Date.now())
  const recentPaidIds = new Set(bookings.filter(booking => booking.payment_status !== 'not_required'
    && booking.status !== 'cancelled').slice(0, 8).map(booking => booking.id))
  const bookingStates = useMemo(() => Object.fromEntries(bookings.map(booking => [
    booking.id, getPersonalBookingState(booking, paymentStatuses[booking.id] ?? null),
  ])), [bookings, paymentStatuses])
  const confirmedUpcoming = bookings.filter(booking => isConfirmedPersonalBooking(booking)
    && data?.tickets.some(ticket => ticket.booking_reference === booking.booking_reference
      && ticket.ticket_status === 'issued' && isDisplayableTicket(ticket))
    && Number.isFinite(Date.parse(booking.event_start)) && Date.parse(booking.event_start) >= now)
    .sort((a, b) => Date.parse(a.event_start) - Date.parse(b.event_start))
  const confirmedPast = bookings.filter(booking => isConfirmedPersonalBooking(booking)
    && data?.tickets.some(ticket => ticket.booking_reference === booking.booking_reference
      && ticket.ticket_status !== 'cancelled' && isDisplayableTicket(ticket))
    && Number.isFinite(Date.parse(booking.event_start)) && Date.parse(booking.event_start) < now)
    .sort((a, b) => Date.parse(b.event_start) - Date.parse(a.event_start))
  const filteredBookings = bookings.filter(booking => {
    const state = String(bookingStates[booking.id] ?? 'processing')
    return filterBooking(booking, state, bookingFilter, now)
      && `${booking.event_title} ${booking.booking_reference}`.toLocaleLowerCase().includes(bookingSearch.trim().toLocaleLowerCase())
  })
  const timeline = useMemo(() => data ? buildPersonalActivityTimeline({
    userId: data.userId, savedEvents: data.savedEvents, bookings: data.bookings,
    tickets: data.tickets, ticketMetadata: data.ticketMetadata, checkins: data.checkins,
    memberships: data.memberships,
  }, 100) : [] as PersonalActivityItem[], [data])
  const counts = data ? getPersonalActivityCounts({
    bookings, savedCount: data.savedEvents.length + data.unavailableSavedCount,
    currentTicketBookingReferences: data.tickets.filter(ticket => ticket.ticket_status !== 'cancelled' && isDisplayableTicket(ticket)).map(ticket => ticket.booking_reference),
    collectionCount: data.collections.length,
    ticketCount: data.tickets.filter(ticket => ticket.ticket_status !== 'cancelled').length,
    communityCount: data.memberships.length,
  }, now) : null

  const refreshPayment = async (bookingId: string) => {
    setPaymentLoading(current => ({ ...current, [bookingId]: true }))
    const result = await getBookingPaymentStatus(bookingId)
    if (result.status) setPaymentStatuses(current => ({ ...current, [bookingId]: result.status! }))
    setPaymentErrors(current => ({ ...current, [bookingId]: result.error ?? '' }))
    setPaymentLoading(current => ({ ...current, [bookingId]: false }))
  }

  if (loading) return <main className="activity-page"><div className="activity-loading" aria-live="polite">Loading your private activity…</div></main>
  if (!signedIn) return <main className="activity-page"><header className="activity-topbar"><button className="activity-brand" onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><button className="activity-nav-button" onClick={() => navigate('/')}>Back to discovery</button></header><section className="activity-signin"><span>PERSONAL DASHBOARD</span><h1>Your activity, in one place.</h1><p>Sign in to review your bookings, tickets, saved events and community memberships.</p>{error && <div className="activity-alert activity-alert-error" role="alert">{error}</div>}<button onClick={() => navigate('/')}>Go to sign in</button></section></main>

  const renderBooking = (booking: PersonalBooking) => {
    const state = String(bookingStates[booking.id] ?? 'processing')
    const detail = paymentStatuses[booking.id]
    const refunds = detail?.refunds ?? []
    return <article className="activity-booking-card" key={booking.id}>
      <div className="activity-booking-main"><span className={`activity-status activity-status-${state}`}>{labels[state] ?? 'Status unavailable'}</span>
        <h3>{booking.event_title}</h3><p>{dateLabel(booking.event_start)} · {booking.event_location}</p>
        {booking.status === 'confirmed' && reminderLabel(booking.event_start, now) && <small className="activity-reminder">{reminderLabel(booking.event_start, now)}</small>}
        <small>Reference {booking.booking_reference} · Created {dateLabel(booking.created_at)}</small>
        {booking.status === 'payment_pending' && booking.expires_at && <small>Reservation expires {dateLabel(booking.expires_at)}. It is not a confirmed booking.</small>}
        {paymentErrors[booking.id] && <small className="activity-inline-error">Payment details could not be refreshed: {paymentErrors[booking.id]}</small>}
        {!paymentChecksComplete && recentPaidIds.has(booking.id) && <small>Checking trusted payment and refund status…</small>}
        {refunds.map((refund, index) => <small className="activity-refund" key={`${booking.id}-refund-${index}`}>
          Refund {refund.status.replaceAll('_', ' ')} · {dateLabel(refund.completedAt ?? refund.requestedAt)}
          {refund.safeErrorCode === 'PROVIDER_NEEDS_ATTENTION' ? ' · Provider review needed' : ''}
        </small>)}
      </div>
      <div className="activity-booking-side"><strong>{money(booking.total_amount, booking.currency)}</strong><small>{data?.bookingQuantities[booking.id] ?? booking.quantity ?? '—'} ticket(s)</small>
        <button onClick={() => navigate('/my-tickets')}>Booking &amp; ticket details</button>
        {booking.payment_status !== 'not_required' && <button className="activity-check-payment" onClick={() => void refreshPayment(booking.id)} disabled={Boolean(paymentLoading[booking.id]) || (!paymentChecksComplete && recentPaidIds.has(booking.id))}>{paymentLoading[booking.id] || (!paymentChecksComplete && recentPaidIds.has(booking.id)) ? 'Checking…' : 'Refresh payment status'}</button>}
      </div>
    </article>
  }

  return <main className="activity-page">
    <header className="activity-topbar"><button className="activity-brand" onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><nav aria-label="Account navigation"><button onClick={() => navigate('/saved-events')}>Saved events</button><button onClick={() => navigate('/my-tickets')}>My tickets</button><button onClick={() => navigate('/account/profile')}>Profile settings</button><button className="activity-nav-button" onClick={() => navigate('/')}>Discovery</button></nav></header>
    <div className="activity-content">
      <div className="activity-heading"><div><span>YOUR ACCOUNT · PRIVATE</span><h1>{data?.displayName ?? 'Your activity'}<b>.</b></h1><p>Bookings, tickets and saved experiences linked to your signed-in account.</p></div><button className="activity-refresh" onClick={() => { setError(''); setLoading(true); setReload(value => value + 1) }}>Refresh activity</button></div>
      {error && <div className="activity-alert activity-alert-error" role="alert">{error}<button onClick={() => { setLoading(true); setReload(value => value + 1) }}>Retry</button></div>}
      {data?.warnings.map((warning, index) => <div className="activity-alert" role="status" key={`warning-${index}`}>{warning}</div>)}

      <section className="activity-stats" aria-label="Activity overview">
        <StatCard label="Upcoming experiences" value={counts?.upcoming ?? 0}/><StatCard label="Past experiences" value={counts?.past ?? 0}/>
        <StatCard label="Pending reservations" value={counts?.pending ?? 0}/><StatCard label="Current tickets" value={counts?.tickets ?? 0}/>
        <StatCard label="Saved events" value={counts?.saved ?? 0}/><StatCard label="Communities" value={counts?.communities ?? 0}/>
      </section>

      <section className="activity-section"><div className="activity-section-heading"><div><span>CONFIRMED ONLY</span><h2>Upcoming experiences</h2></div><button onClick={() => navigate('/my-tickets')}>View tickets →</button></div>
        {confirmedUpcoming.length ? <div className="activity-experience-grid">{confirmedUpcoming.slice(0, 6).map(booking => <ExperienceCard key={booking.id} booking={booking} now={now} onOpen={() => navigate('/my-tickets')}/>)}</div>
          : <EmptyState title="Nothing confirmed is coming up" detail="Pending reservations are kept separate until payment or free booking confirmation is recorded." action="Discover events" onClick={() => navigate('/')}/>}
      </section>

      {confirmedPast.length > 0 && <section className="activity-section"><div className="activity-section-heading"><div><span>YOUR HISTORY</span><h2>Past experiences</h2></div></div><div className="activity-experience-grid">{confirmedPast.slice(0, 6).map(booking => <ExperienceCard key={booking.id} booking={booking} now={now} onOpen={() => navigate('/my-tickets')}/>)}</div></section>}

      <section className="activity-section"><div className="activity-section-heading"><div><span>BOOKING HISTORY</span><h2>Bookings &amp; reservations</h2></div><span>{filteredBookings.length} shown</span></div>
        <div className="activity-booking-tools"><input value={bookingSearch} onChange={event => { setBookingSearch(event.target.value); setBookingVisible(8) }} placeholder="Search event or reference" aria-label="Search bookings"/><select value={bookingFilter} onChange={event => { setBookingFilter(event.target.value as BookingFilter); setBookingVisible(8) }} aria-label="Filter bookings"><option value="all">All bookings</option><option value="confirmed">Confirmed upcoming</option><option value="pending">Pending or processing</option><option value="other">Past or other status</option></select></div>
        {filteredBookings.length ? <div className="activity-booking-list">{filteredBookings.slice(0, bookingVisible).map(renderBooking)}{filteredBookings.length > bookingVisible && <button className="activity-more" onClick={() => setBookingVisible(value => value + 8)}>Show more bookings</button>}</div>
          : <EmptyState title="No bookings match this view" detail="Confirmed, pending, cancelled and expired records will appear here when they exist."/>}
      </section>

      <section className="activity-section"><div className="activity-section-heading"><div><span>CURRENT TICKET ACCESS</span><h2>Tickets</h2></div><button onClick={() => navigate('/my-tickets')}>Open QR tickets →</button></div>
        {data?.tickets.length ? <div className="activity-ticket-list">{data.tickets.slice(0, 8).map(ticket => <article className="activity-ticket-card" key={ticket.ticket_id}>
          <div><span className={`activity-status activity-status-${ticket.ticket_status}`}>{ticket.ticket_status.replaceAll('_', ' ')}</span><h3>{ticket.event_title}</h3><p>{dateLabel(ticket.event_start)} · {ticket.location}{ticket.venue ? ` · ${ticket.venue}` : ''}</p><small>{ticket.ticket_type} · {ticket.blockchain_status === 'off_chain' ? 'Digital ticket' : `Solana ${ticket.blockchain_status}`}</small></div>
          <button onClick={() => navigate('/my-tickets')}>View QR &amp; ticket</button>
        </article>)}</div> : <EmptyState title="No current tickets" detail="Tickets appear here after a booking has been confirmed and the ticket is assigned to your account." action="My tickets" onClick={() => navigate('/my-tickets')}/>}
      </section>

      <div className="activity-two-column">
        <section className="activity-section"><div className="activity-section-heading"><div><span>PRIVATE TO YOUR ACCOUNT</span><h2>Saved events &amp; collections</h2></div><button onClick={() => navigate('/saved-events')}>Manage →</button></div>
          {data?.savedEvents.length || data?.collections.length ? <><div className="activity-saved-list">{data.savedEvents.slice(0, 5).map(item => <button key={item.event.id} onClick={() => navigate(`/events/${item.event.slug}`)}><span>{item.event.title}</span><small>{item.event.date} · {item.event.city}, {item.event.country}</small></button>)}</div>
            <div className="activity-collection-list">{data.collections.slice(0, 5).map(collection => <div key={collection.id}><strong>{collection.name}</strong><small>{collection.eventIds.length} saved event{collection.eventIds.length === 1 ? '' : 's'}</small></div>)}</div>
            {data.unavailableSavedCount > 0 && <small className="activity-muted">{data.unavailableSavedCount} saved listing(s) are no longer publicly available.</small>}
          </> : <EmptyState title="Your library is empty" detail="Save public events and organize them into private collections." action="Find events" onClick={() => navigate('/')}/>}
        </section>
        <section className="activity-section"><div className="activity-section-heading"><div><span>EXISTING MEMBERSHIPS</span><h2>Communities</h2></div><button onClick={() => navigate('/#communities')}>Explore →</button></div>
          {data?.memberships.length ? <div className="activity-community-list">{data.memberships.slice(0, 6).map(membership => <article key={membership.community_id}><span>{membership.community.cover_image ? <img src={membership.community.cover_image} alt=""/> : membership.community.name.charAt(0)}</span><div><strong>{membership.community.name}</strong><small>{membership.community.category}{membership.community.location ? ` · ${membership.community.location}` : ''}</small><small>{membership.role === 'member' ? 'Member' : membership.role}</small></div></article>)}</div>
            : <EmptyState title="No community memberships yet" detail="Communities you choose to join appear here." action="Browse communities" onClick={() => navigate('/#communities')}/>}
        </section>
      </div>

      <section className="activity-section"><div className="activity-section-heading"><div><span>FROM EXISTING RECORDS</span><h2>Recent activity</h2></div><span>Newest first</span></div>
        {timeline.length ? <><ol className="activity-timeline">{timeline.slice(0, activityVisible).map(item => <TimelineRow key={item.id} item={item} onOpen={() => item.href && navigate(item.href)}/>)}</ol>{timeline.length > activityVisible && <button className="activity-more" onClick={() => setActivityVisible(value => value + 10)}>Show more activity</button>}</>
          : <EmptyState title="No recent activity to show" detail="Saved events, bookings, ticket issuance, check-ins and current memberships appear here when records exist."/>}
      </section>
      <p className="activity-privacy-note">This dashboard is private to your account. Ticket QR codes remain on the existing My Tickets page, where payment and ticket status checks are performed.</p>
    </div>
  </main>
}

function StatCard({ label, value }: { label: string; value: number }) {
  return <article className="activity-stat"><span>{label}</span><strong>{value}</strong></article>
}

function ExperienceCard({ booking, now, onOpen }: { booking: PersonalBooking; now: number; onOpen: () => void }) {
  const reminder = reminderLabel(booking.event_start, now)
  return <article className="activity-experience-card">{booking.event_cover_image && <img src={booking.event_cover_image} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }}/>}<div><span>CONFIRMED EXPERIENCE</span><h3>{booking.event_title}</h3><p>{dateLabel(booking.event_start)} · {booking.event_location}</p>{reminder && <small className="activity-reminder">{reminder}</small>}<small>{booking.booking_reference}</small><button onClick={onOpen}>Booking details →</button></div></article>
}

function EmptyState({ title, detail, action, onClick }: { title: string; detail: string; action?: string; onClick?: () => void }) {
  return <div className="activity-empty"><strong>{title}</strong><p>{detail}</p>{action && onClick && <button onClick={onClick}>{action}</button>}</div>
}

function TimelineRow({ item, onOpen }: { item: PersonalActivityItem; onOpen: () => void }) {
  return <li><span className={`activity-timeline-mark activity-mark-${item.kind}`} aria-hidden="true"/><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={item.occurredAt}>{dateLabel(item.occurredAt)}</time></div>{item.href && <button onClick={onOpen}>Open</button>}</li>
}
