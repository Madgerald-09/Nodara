import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import '../Organiser.css'
import { supabase, supabaseConfigError } from '../lib/supabase'
import { signIn, signOut, signUp } from '../services/authService'
import { cancelEvent, createEvent, getEventById, getMyEventDashboard, getMyEventPage, publishEvent, updateEvent } from '../services/eventService'
import type { EventStatus, EventWriteInput } from '../services/eventService'
import type { EventRow } from '../types/database'
import { checkInTicket, getEventAttendees, getEventAttendeeRefunds, getOrganiserTicketTypes, getTicketChainInfo, removeTicketType, saveTicketType } from '../services/bookingService'
import type { TicketTypeAdmin } from '../services/bookingService'
import { SolanaWalletControl } from '../components/SolanaWalletControl'
import { OnChainTicketRegistration } from '../components/OnChainTicketRegistration'
import { SolanaReconciliationPanel } from '../components/SolanaReconciliationPanel'
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import { ClientProvider } from '@solana/react'
import { solanaClient } from '../lib/solana'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'
import { getRefundStatusLabel } from '../services/paymentPresentation'
import { EventWebpageImporter } from '../components/EventWebpageImporter'
import './Phase12.css'
import './OrganiserPagination.css'

const OrganiserAnalyticsPage = lazy(() => import('./OrganiserAnalyticsPage').then(module => ({ default: module.OrganiserAnalyticsPage })))

export type NavigateFunction = (path: string) => void
const statusLabels: Record<EventStatus, string> = { draft: 'Draft', published: 'Published', cancelled: 'Cancelled', completed: 'Completed' }
const eventCategories = ['Technology', 'Music', 'Business', 'Art & Culture', 'Sports', 'Gaming', 'Education', 'Adventure', 'Social']
const currencies = ['USD', 'NGN', 'GBP', 'EUR', 'CAD', 'AUD', 'AED', 'JPY']
const fallbackImage = 'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&w=1000&q=85'
type OrganiserProps = { pathname: string; navigate: NavigateFunction }

export function OrganiserApp({ pathname, navigate }: OrganiserProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => { if (active) { setSession(data.session); setSessionLoading(false) } })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setSessionLoading(false) })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])

  if (supabaseConfigError) return <div className="organiser-page"><div className="organiser-center-card"><Brand/><h1>Organiser tools need setup</h1><p>{supabaseConfigError}</p><RouteButton navigate={navigate} to="/">Back to discovery</RouteButton></div></div>
  if (sessionLoading) return <div className="organiser-page"><div className="organiser-loading"><span className="organiser-spinner"/>Checking your session…</div></div>
  if (!session?.user) return <OrganiserAuth navigate={navigate}/>

  const route = resolveRoute(pathname)
  const page = route.kind === 'new'
    ? <EventFormPage navigate={navigate}/>
    : route.kind === 'analytics'
      ? <Suspense fallback={<LoadingState label="Loading organiser analytics…"/>}><OrganiserAnalyticsPage navigate={navigate} mode="overview"/></Suspense>
      : route.kind === 'financials'
        ? <Suspense fallback={<LoadingState label="Loading financial reports…"/>}><OrganiserAnalyticsPage navigate={navigate} mode="financials"/></Suspense>
        : route.kind === 'eventAnalytics'
          ? <Suspense fallback={<LoadingState label="Loading event analytics…"/>}><OrganiserAnalyticsPage navigate={navigate} mode="event" eventId={route.eventId}/></Suspense>
    : route.kind === 'attendees'
      ? <AttendeesPage eventId={route.eventId ?? ''} navigate={navigate}/>
      : route.kind === 'checkin'
        ? <CheckInPage eventId={route.eventId ?? ''} navigate={navigate}/>
    : route.kind === 'edit'
      ? <EventFormPage eventId={route.eventId} navigate={navigate}/>
      : route.kind === 'detail'
        ? <EventDetailPage key={route.eventId} eventId={route.eventId ?? ''} navigate={navigate}/>
        : route.kind === 'events'
          ? <EventsPage navigate={navigate}/>
          : <DashboardPage navigate={navigate}/>

  return <ClientProvider client={solanaClient}><div className="organiser-page">
    <header className="organiser-topbar"><Brand onClick={() => navigate('/')}/><div className="organiser-top-actions"><span className="organiser-user">{session.user.user_metadata.full_name || session.user.email}</span><SolanaWalletControl/><button className="organiser-quiet" onClick={() => navigate('/')}>View discovery <span>↗</span></button><button className="organiser-quiet" onClick={() => void signOut().then(() => navigate('/'))}>Sign out</button></div></header>
    <div className="organiser-layout">
      <aside className="organiser-sidebar"><div className="sidebar-label">ORGANISER WORKSPACE</div><RouteLink navigate={navigate} to="/organiser/dashboard" active={route.kind === 'dashboard'}>Overview</RouteLink><RouteLink navigate={navigate} to="/organiser/events" active={route.kind === 'events' || route.kind === 'detail' || route.kind === 'edit' || route.kind === 'attendees' || route.kind === 'checkin' || route.kind === 'eventAnalytics'}>My events</RouteLink><RouteLink navigate={navigate} to="/organiser/analytics" active={route.kind === 'analytics'}>Analytics</RouteLink><RouteLink navigate={navigate} to="/organiser/financials" active={route.kind === 'financials'}>Financials</RouteLink><RouteLink navigate={navigate} to="/organiser/events/new" active={route.kind === 'new'} accent>＋ Create event</RouteLink><div className="sidebar-bottom"><span className="sidebar-status-dot"/> Your workspace is private</div></aside>
      <main className="organiser-main">{page}</main>
    </div>
  </div></ClientProvider>
}

function resolveRoute(pathname: string): { kind: 'dashboard' | 'events' | 'new' | 'edit' | 'detail' | 'attendees' | 'checkin' | 'analytics' | 'financials' | 'eventAnalytics'; eventId?: string } {
  if (pathname === '/organiser/analytics' || pathname === '/organiser/analytics/') return { kind: 'analytics' }
  if (pathname === '/organiser/financials' || pathname === '/organiser/financials/') return { kind: 'financials' }
  if (pathname === '/organiser/events/new') return { kind: 'new' }
  const eventAnalytics = pathname.match(/^\/organiser\/events\/([^/]+)\/analytics\/?$/)
  if (eventAnalytics) return { kind: 'eventAnalytics', eventId: decodeURIComponent(eventAnalytics[1]) }
  const attendee = pathname.match(/^\/organiser\/events\/([^/]+)\/attendees\/?$/)
  if (attendee) return { kind: 'attendees', eventId: decodeURIComponent(attendee[1]) }
  const checkin = pathname.match(/^\/organiser\/events\/([^/]+)\/check-in\/?$/)
  if (checkin) return { kind: 'checkin', eventId: decodeURIComponent(checkin[1]) }
  const edit = pathname.match(/^\/organiser\/events\/([^/]+)\/edit\/?$/)
  if (edit) return { kind: 'edit', eventId: decodeURIComponent(edit[1]) }
  const detail = pathname.match(/^\/organiser\/events\/([^/]+)\/?$/)
  if (detail) return { kind: 'detail', eventId: decodeURIComponent(detail[1]) }
  if (pathname === '/organiser/events' || pathname === '/organiser/events/') return { kind: 'events' }
  return { kind: 'dashboard' }
}

function Brand({ onClick }: { onClick?: () => void }) {
  const content = <><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span><small>ORGANISER</small></>
  return onClick ? <button className="brand organiser-brand" onClick={onClick}>{content}</button> : <div className="brand organiser-brand">{content}</div>
}

function RouteButton({ navigate, to, children, className = '' }: { navigate: NavigateFunction; to: string; children: React.ReactNode; className?: string }) {
  return <button className={className || 'organiser-button'} onClick={() => navigate(to)}>{children}</button>
}

function RouteLink({ navigate, to, children, active = false, accent = false }: { navigate: NavigateFunction; to: string; children: React.ReactNode; active?: boolean; accent?: boolean }) {
  return <a className={`sidebar-link${active ? ' active' : ''}${accent ? ' sidebar-create' : ''}`} href={to} onClick={event => { event.preventDefault(); navigate(to) }}>{children}</a>
}

function OrganiserAuth({ navigate }: { navigate: NavigateFunction }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage(''); setBusy(true)
    const result = mode === 'signup' ? await signUp(email.trim(), password, name.trim()) : await signIn(email.trim(), password)
    setBusy(false)
    if (result.error) { setError(authError(result.error.message)); return }
    if (mode === 'signup' && (!result.user || !result.user.email_confirmed_at)) {
      setMessage('Check your email for a confirmation link. Return here to sign in after confirming.')
      return
    }
    navigate(window.location.pathname || '/organiser/dashboard')
  }
  return <div className="organiser-page organiser-auth-page"><div className="organiser-auth-card"><Brand/><div className="tiny-label">NODARA ORGANISER WORKSPACE</div><h1>{mode === 'signup' ? 'Create your organiser account.' : 'Sign in to your workspace.'}</h1><p>Manage your events and bring your community together.</p><form onSubmit={event => void submit(event)}>{mode === 'signup' && <label>Your name<input value={name} onChange={event => setName(event.target.value)} autoComplete="name" required maxLength={120} placeholder="Full name"/></label>}<label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required placeholder="you@example.com"/></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required placeholder="At least 8 characters"/></label>{error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}<button className="organiser-button organiser-button-primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'} <span>→</span></button></form><div className="auth-toggle">{mode === 'signup' ? 'Already have an account?' : 'New to NODARA?'} <button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); setMessage('') }}>{mode === 'signup' ? 'Sign in' : 'Create account'}</button></div><button className="back-discovery" onClick={() => navigate('/')}>← Back to discovery</button></div></div>
}

function authError(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('invalid login credentials')) return 'Email or password did not match. Check them and try again.'
  if (lower.includes('email not confirmed')) return 'Confirm your email from the link we sent before signing in.'
  if (lower.includes('already registered')) return 'That email already has an account. Try signing in.'
  if (lower.includes('fetch') || lower.includes('network')) return 'Could not reach Supabase. Check your connection and try again.'
  return message
}

function DashboardPage({ navigate }: { navigate: NavigateFunction }) {
  const [events, setEvents] = useState<EventRow[]>([])
  const [counts, setCounts] = useState<{ total: number; published: number; draft: number; cancelled: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    getMyEventDashboard().then(result => { if (active) { setEvents(result.events); setCounts(result.counts); setError(result.error ?? ''); setLoading(false) } })
    return () => { active = false }
  }, [reload])
  const stats = [
    { label: 'Total events', value: counts?.total ?? 0, className: 'stat-neutral' },
    { label: 'Published', value: counts?.published ?? 0, className: 'stat-published' },
    { label: 'Drafts', value: counts?.draft ?? 0, className: 'stat-draft' },
    { label: 'Cancelled', value: counts?.cancelled ?? 0, className: 'stat-cancelled' },
  ]
  return <>
    <PageHeading eyebrow="YOUR WORKSPACE" title="Overview" description="A clear view of the experiences you’re bringing to life."><RouteButton navigate={navigate} to="/organiser/events/new">＋ Create event</RouteButton></PageHeading>
    {error && <InlineError message={error} retry={() => setReload(value => value + 1)}/>}
    <div className="organiser-stats">{stats.map(stat => <div className="organiser-stat" key={stat.label}><span>{stat.label}</span><strong className={stat.className}>{loading || !counts ? '—' : stat.value}</strong></div>)}</div>
    <section className="organiser-panel"><div className="panel-heading"><div><span className="tiny-label">RECENT ACTIVITY</span><h2>Your events</h2></div><RouteLink navigate={navigate} to="/organiser/events">See all events →</RouteLink></div>
      {loading ? <LoadingState label="Loading your events…"/> : events.length ? <EventTable events={events.slice(0, 5)} navigate={navigate} onChanged={() => setReload(value => value + 1)}/> : <EmptyEvents navigate={navigate} title="Your event list starts here." text="Create a draft to plan your next gathering, or publish when it’s ready."/>}
    </section>
  </>
}

function EventsPage({ navigate }: { navigate: NavigateFunction }) {
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | EventStatus>('all')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    getMyEventPage(page, filter).then(result => { if (active) { setEvents(result.events); setTotal(result.total); setError(result.error ?? ''); setLoading(false) } })
    return () => { active = false }
  }, [reload, page, filter])
  const pageCount = Math.max(1, Math.ceil(total / 25))
  const visible = events
  return <>
    <PageHeading eyebrow="EVENT MANAGEMENT" title="My events" description="Create, edit, and keep track of every experience you organise."><RouteButton navigate={navigate} to="/organiser/events/new">＋ Create event</RouteButton></PageHeading>
    {error && <InlineError message={error} retry={() => setReload(value => value + 1)}/>}
    <div className="event-filter-row"><label>Status filter<select value={filter} onChange={event => { setLoading(true); setPage(0); setFilter(event.target.value as typeof filter) }}><option value="all">All statuses</option>{(['draft', 'published', 'cancelled', 'completed'] as EventStatus[]).map(status => <option value={status} key={status}>{statusLabels[status]}</option>)}</select></label><span>{total ? `${page * 25 + 1}–${page * 25 + visible.length} of ${total} events` : '0 events'}</span></div>
    <section className="organiser-panel panel-flush">{loading ? <LoadingState label="Loading your events…"/> : visible.length ? <EventTable events={visible} navigate={navigate} onChanged={() => setReload(value => value + 1)}/> : <EmptyEvents navigate={navigate} title={total ? 'No events on this page.' : 'No events match this status.'} text={total ? 'Use the page controls to browse your events.' : 'Choose another status filter or create a new event.'}/>}</section>
    {total > 25 && <nav className="event-pagination" aria-label="Event pages"><button type="button" disabled={page === 0 || loading} onClick={() => { setLoading(true); setPage(value => Math.max(0, value - 1)) }}>Previous</button><span aria-live="polite">Page {page + 1} of {pageCount}</span><button type="button" disabled={page + 1 >= pageCount || loading} onClick={() => { setLoading(true); setPage(value => value + 1) }}>Next</button></nav>}
  </>
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <div className="organiser-page-heading"><div><span className="tiny-label">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children}</div>
}

function EventTable({ events, navigate, onChanged }: { events: EventRow[]; navigate: NavigateFunction; onChanged?: () => void }) {
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState('')
  const action = async (event: EventRow, kind: 'publish' | 'cancel') => {
    const text = kind === 'publish' ? `Publish “${event.title}”? It will appear in public discovery.` : `Cancel “${event.title}”? It will no longer be available publicly.`
    if (!window.confirm(text)) return
    setBusyId(event.id); setActionError('')
    const result = kind === 'publish' ? await publishEvent(event.id) : await cancelEvent(event.id)
    setBusyId('')
    if (result.error) setActionError(result.error)
    else onChanged?.()
  }
  return <div className="event-table-wrap">{actionError && <div className="form-error table-error" role="alert">{actionError}</div>}<table className="event-table"><thead><tr><th>Event</th><th>Status</th><th>Start date</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{events.map(event => <tr key={event.id}><td><button className="table-event-name" onClick={() => navigate(`/organiser/events/${event.id}`)}>{event.title}</button><span className="table-event-meta">{event.location}, {event.country} · {event.category}</span></td><td><StatusBadge status={event.status}/></td><td>{formatDate(event.start_date)}</td><td>{formatDate(event.updated_at)}</td><td><div className="table-actions"><button onClick={() => navigate(`/organiser/events/${event.id}/edit`)}>Edit</button>{event.status === 'draft' && <button className="action-publish" disabled={busyId === event.id} onClick={() => void action(event, 'publish')}>{busyId === event.id ? '…' : 'Publish'}</button>}{(event.status === 'published' || event.status === 'draft') && <button className="action-cancel" disabled={busyId === event.id} onClick={() => void action(event, 'cancel')}>{busyId === event.id ? '…' : 'Cancel'}</button>}</div></td></tr>)}</tbody></table><div className="event-card-list">{events.map(event => <article className="event-mobile-card" key={event.id}><div className="mobile-event-top"><div><button className="table-event-name" onClick={() => navigate(`/organiser/events/${event.id}`)}>{event.title}</button><span className="table-event-meta">{event.location}, {event.country}</span></div><StatusBadge status={event.status}/></div><div className="mobile-event-date">Starts {formatDate(event.start_date)} · Updated {formatDate(event.updated_at)}</div><div className="table-actions"><button onClick={() => navigate(`/organiser/events/${event.id}/edit`)}>Edit event</button>{event.status === 'draft' && <button className="action-publish" disabled={busyId === event.id} onClick={() => void action(event, 'publish')}>Publish</button>}{(event.status === 'published' || event.status === 'draft') && <button className="action-cancel" disabled={busyId === event.id} onClick={() => void action(event, 'cancel')}>Cancel</button>}</div></article>)}</div></div>
}

function StatusBadge({ status }: { status: EventStatus }) { return <span className={`status-badge status-${status}`}>{statusLabels[status]}</span> }

function EmptyEvents({ navigate, title, text }: { navigate: NavigateFunction; title: string; text: string }) {
  return <div className="organiser-empty"><span className="empty-diamond">✳</span><h3>{title}</h3><p>{text}</p><RouteButton navigate={navigate} to="/organiser/events/new" className="organiser-button organiser-button-primary">Create an event</RouteButton></div>
}

function LoadingState({ label }: { label: string }) { return <div className="organiser-loading"><span className="organiser-spinner"/>{label}</div> }
function InlineError({ message, retry }: { message: string; retry: () => void }) { return <div className="form-error inline-organiser-error" role="alert">{message}<button onClick={retry}>Retry</button></div> }
function formatDate(value: string) { return new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) }

type AttendeeRow = { ticket_id: string; booking_reference: string; attendee_name: string | null; attendee_email: string | null; ticket_type: string; quantity: number; booking_status: string; ticket_status: string; checked_in_at: string | null; created_at: string }
type AttendeeRefund = { ticket_id: string; amount_minor: number | string; currency: string; status: string; requested_at: string; completed_at: string | null; safe_error_code: string | null }

function AttendeesPage({ eventId, navigate }: { eventId: string; navigate: NavigateFunction }) {
  const [rows, setRows] = useState<AttendeeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [capacity, setCapacity] = useState<{ name: string; capacity: number | null; quantity_sold: number; quantity_reserved: number }[]>([])
  const [eventStatus, setEventStatus] = useState<string | null>(null)
  const [refundByTicket, setRefundByTicket] = useState<Record<string, AttendeeRefund>>({})
  useEffect(() => {
    let active = true
    Promise.all([getEventAttendees(eventId), getEventAttendeeRefunds(eventId), supabase?.from('ticket_types').select('name,capacity,quantity_sold,quantity_reserved').eq('event_id', eventId), supabase?.from('events').select('status').eq('id', eventId).maybeSingle()])
      .then(([result, refundResult, typesResult, eventResult]) => {
        if (!active) return
        setRows(result.attendees as AttendeeRow[])
        setError(result.error ?? refundResult.error ?? typesResult?.error?.message ?? eventResult?.error?.message ?? '')
        const refunds: Record<string, AttendeeRefund> = {}
        for (const refund of refundResult.refunds as AttendeeRefund[]) {
          if (!refunds[refund.ticket_id]) refunds[refund.ticket_id] = refund
        }
        setRefundByTicket(refunds)
        setCapacity((typesResult?.data ?? []) as typeof capacity)
        setEventStatus(eventResult?.data?.status ?? null)
        setLoading(false)
      })
    return () => { active = false }
  }, [eventId])
  const visible = rows.filter(row => {
    const query = search.toLowerCase()
    return (filter === 'all' || row.ticket_status === filter) && (!query || `${row.attendee_name ?? ''} ${row.attendee_email ?? ''} ${row.booking_reference} ${row.ticket_type}`.toLowerCase().includes(query))
  })
  if (loading) return <LoadingState label="Loading attendees…"/>
  return <>
    <PageHeading eyebrow="EVENT OPERATIONS" title="Attendees" description="Ticket records for this event. Your organiser access is checked by Supabase for every request."><RouteButton navigate={navigate} to={`/organiser/events/${eventId}/check-in`}>Open check-in</RouteButton></PageHeading>
    <div className="organiser-stats"><div className="organiser-stat"><span>Confirmed tickets</span><strong className="stat-published">{rows.length}</strong></div><div className="organiser-stat"><span>Checked in</span><strong>{rows.filter(row => row.ticket_status === 'checked_in').length}</strong></div><div className="organiser-stat"><span>Remaining listed capacity</span><strong>{capacity.reduce((sum, item) => sum + (item.capacity === null ? 0 : Math.max(0, item.capacity - item.quantity_sold - item.quantity_reserved)), 0) || '—'}</strong></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <SolanaReconciliationPanel eventId={eventId}/>
    <section className="organiser-panel"><div className="ticket-filter-row"><input aria-label="Search attendees" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, email, booking reference"/><select aria-label="Filter ticket status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All ticket statuses</option><option value="issued">Issued</option><option value="checked_in">Checked in</option><option value="cancelled">Cancelled</option></select></div>
      {visible.length ? <div className="event-table-wrap"><table className="event-table attendee-table"><thead><tr><th>Attendee</th><th>Booking reference</th><th>Ticket type</th><th>Booking</th><th>Ticket status</th><th>Refund</th><th>Created</th><th>Devnet registration</th></tr></thead><tbody>{visible.map(row => { const refund = refundByTicket[row.ticket_id]; return <tr key={row.ticket_id}><td>{row.attendee_name || 'NODARA guest'}<span className="table-event-meta">{row.attendee_email || 'Email unavailable'}</span></td><td>{row.booking_reference}</td><td>{row.ticket_type} · ×{row.quantity}</td><td><span className="status-badge status-published">{row.booking_status}</span></td><td>{row.ticket_status === 'checked_in' ? `Checked in ${row.checked_in_at ? formatDate(row.checked_in_at) : ''}` : row.ticket_status}</td><td>{refund ? <><span className={`status-badge ${refund.status === 'succeeded' ? 'status-cancelled' : 'status-draft'}`}>{getRefundStatusLabel(refund.status, refund.safe_error_code)}</span><small className="table-event-meta">{new Intl.NumberFormat('en', { style: 'currency', currency: refund.currency }).format(Number(refund.amount_minor) / 100)} · {formatDate(refund.completed_at ?? refund.requested_at)}</small></> : '—'}</td><td>{formatDate(row.created_at)}</td><td>{eventStatus !== 'published' ? <small>Only tickets for published events can be registered.</small> : row.ticket_status === 'issued' ? <OnChainTicketRegistration eventId={eventId} ticketId={row.ticket_id} ticketStatus={row.ticket_status}/> : <small>Only issued tickets can be registered.</small>}</td></tr>})}</tbody></table>{!visible.length && <div className="organiser-empty"><p>No attendees match that search.</p></div>}</div> : <div className="organiser-empty"><span className="empty-diamond">✳</span><h2>{rows.length ? 'No matching attendees.' : 'No confirmed tickets yet.'}</h2><p>Confirmed attendee tickets will appear here. Paid bookings remain excluded until independently verified.</p></div>}
    </section>
  </>
}

function CheckInPage({ eventId, navigate }: { eventId: string; navigate: NavigateFunction }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [stage, setStage] = useState('')
  const [ticketInfo, setTicketInfo] = useState<{ attendee: string; event: string; ticketReference: string } | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const connected = useConnectedWallet(useClient() as ClientWithWallet)
  const verify = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().replace(/^NODARA:TICKET:/i, '')
    if (!normalized) return
    setBusy(true); setError(''); setMessage(''); setStage('Validating ticket…'); setTicketInfo(null)
    let onChain: typeof import('../services/onChainTicketCheckIn') | null = null
    try {
      const chainInfo = await getTicketChainInfo(eventId, normalized)
      if (chainInfo.error) throw new Error(chainInfo.error)
      if (chainInfo.ticket && (chainInfo.ticket.solana_ticket_account || chainInfo.ticket.blockchain_status !== 'off_chain')) {
        const ticket = chainInfo.ticket
        if (ticket.status !== 'issued') {
          if (ticket.status === 'checked_in') setMessage('Already checked in: the database records this ticket as used.')
          else setError('Rejected: this ticket is cancelled or otherwise unavailable.')
          return
        }
        onChain = await import('../services/onChainTicketCheckIn')
        const pending = onChain.getPendingOnChainCheckIn(ticket.id)
        if (pending) {
          setStage('Verifying confirmed check-in with NODARA…')
          const verification = await onChain.verifyOnChainCheckIn(pending)
          if (!verification.verified) {
            setStage('Awaiting server verification')
            setError(`The confirmed check-in is still awaiting server verification. ${verification.error}`)
            return
          }
          setMessage(`Verified: on-chain check-in recorded · ${pending.signature}`)
          setCode('')
          return
        }
        if (!ticket.holder_user_id) throw new Error('Rejected: this ticket was transferred and has not been claimed by its current holder.')
        if (!ticket.wallet_address) throw new Error('Rejected: NODARA has no current wallet recorded for this ticket.')
        if (!connected) throw new Error('Connect the wallet authorised for this event to check in on-chain tickets.')
        const attendees = await getEventAttendees(eventId)
        if (attendees.error) throw new Error(`Could not load attendee details: ${attendees.error}`)
        const attendee = attendees.attendees.find((row: { ticket_id: string }) => row.ticket_id === ticket.id)
        if (!attendee) throw new Error('Rejected: this ticket is not in the event’s confirmed attendee list.')
        const eventResult = await getEventById(eventId)
        if (eventResult.error || !eventResult.event) throw new Error(eventResult.error ?? 'Could not load event details.')
        setTicketInfo({
          attendee: attendee.attendee_name || 'Ticket holder',
          event: eventResult.event.title,
          ticketReference: `${attendee.ticket_type} · Booking ${attendee.booking_reference} · Ticket ${ticket.id.slice(0, 8).toUpperCase()}`,
        })
        setStage('Validating on Solana Devnet…')
        const result = await onChain.checkInTicketOnDevnet({
          ticketId: ticket.id, eventId, expectedTicketAccount: ticket.solana_ticket_account ?? '',
          expectedEventAccount: ticket.solana_event_account ?? '', expectedOwnerWallet: ticket.wallet_address,
          eventTitle: eventResult.event.title, ticketHolder: attendee.attendee_name || 'Ticket holder',
          organizer: connected as unknown as Parameters<typeof onChain.checkInTicketOnDevnet>[0]['organizer'],
          onStage: (next: string) => setStage(next),
        })
        setMessage(`Verified: on-chain check-in recorded · ${result.signature}`)
        setCode('')
        return
      }

      // QR codes and manual IDs for off-chain tickets retain the existing database flow.
      const result = await checkInTicket(eventId, normalized)
      if (result.error) throw new Error(result.error)
      const labels: Record<string, string> = { valid: 'Verified: valid off-chain ticket. Check-in recorded.', already_used: 'Already checked in: this ticket has already been used.', cancelled: 'Rejected: this ticket was cancelled.', invalid: 'Rejected: ticket code is not valid for this event.', requires_on_chain: 'This registered ticket must be checked in on Solana.' }
      setMessage(labels[result.result?.result ?? 'invalid'])
      setCode('')
    } catch (cause) {
      if (onChain && cause instanceof onChain.CheckInVerificationPendingError) {
        setStage('Awaiting server verification')
        setError(cause.message)
        return
      }
      const text = cause instanceof Error ? cause.message : 'Ticket check-in was rejected.'
      if (/already been checked in on-chain/i.test(text)) setMessage('Already checked in on-chain.')
      else setError(text)
    } finally { setBusy(false) }
  }, [connected, eventId])
  useEffect(() => {
    if (!scanning) return
    let stopped = false
    let stream: MediaStream | null = null
    let frame = 0
    const scannerWindow = window as Window & { BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }
    const Detector = scannerWindow.BarcodeDetector
    if (!Detector) return
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stopped || !videoRef.current) return
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        const detector = new Detector({ formats: ['qr_code'] })
        const scan = async () => {
          if (stopped || !videoRef.current) return
          try {
            const results = await detector.detect(videoRef.current)
            if (results[0]?.rawValue) { setCode(results[0].rawValue); setScanning(false); await verify(results[0].rawValue); return }
          } catch { /* Keep the camera active and allow manual entry. */ }
          frame = window.requestAnimationFrame(() => void scan())
        }
        void scan()
      } catch {
        setError('Camera access was unavailable. Allow camera access or use manual ticket lookup.')
        setScanning(false)
      }
    })()
    return () => { stopped = true; window.cancelAnimationFrame(frame); stream?.getTracks().forEach(track => track.stop()) }
  }, [scanning, verify])
  return <>
    <div className="detail-back"><button onClick={() => navigate(`/organiser/events/${eventId}/attendees`)}>← Attendees</button></div>
    <PageHeading eyebrow="EVENT OPERATIONS" title="Ticket check-in" description="Blockchain tickets are checked in on Solana Devnet. Other tickets continue through NODARA’s existing check-in flow."/>
    <section className="organiser-panel scanner-panel"><div className="scanner-frame">{scanning ? <video ref={videoRef} muted playsInline/> : <div className="scanner-placeholder"><span>▦</span><p>Camera scan works in browsers with QR detection support.</p></div>}</div>{scanning && <div className="form-pending" role="status">Scanning for a ticket QR code…</div>}<button className="organiser-button organiser-button-primary" disabled={busy} onClick={() => { const supportsScanner = 'BarcodeDetector' in window; if (!scanning && !supportsScanner) { setError('QR camera scanning is not supported by this browser. Use the manual ticket lookup below.'); return } setError(''); setScanning(value => !value) }}>{scanning ? 'Stop camera' : 'Start camera scan'}</button><p className="form-footnote">Camera permission is requested only when you start scanning. Camera access requires HTTPS or localhost.</p>
      <form className="manual-ticket-form" onSubmit={event => { event.preventDefault(); void verify(code) }}><label>Manual ticket QR value or ticket ID<input value={code} onChange={event => setCode(event.target.value)} placeholder="Scan value or paste ticket code" autoComplete="off"/></label><button className="organiser-button" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Validate ticket'}</button></form>
      {stage && <div className="form-pending" role="status">{stage}</div>}{ticketInfo && <div className="checkin-ticket-summary"><strong>{ticketInfo.attendee}</strong><span>{ticketInfo.event}</span><small>{ticketInfo.ticketReference}</small></div>}
      {message && <div className={message.startsWith('Verified:') ? 'form-success' : 'form-error'} role="status">{message}</div>}{error && <div className="form-error" role="alert">{error}</div>}
    </section>
  </>
}

function EventDetailPage({ eventId, navigate }: { eventId: string; navigate: NavigateFunction }) {
  const [event, setEvent] = useState<EventRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    getEventById(eventId).then(result => { if (active) { setEvent(result.event); setError(result.error ?? ''); setLoading(false) } })
    return () => { active = false }
  }, [eventId])
  const changeStatus = async (status: 'published' | 'cancelled') => {
    if (!event) return
    const prompt = status === 'published' ? `Publish “${event.title}” to public discovery?` : `Cancel “${event.title}”? Visitors will no longer see it as available.`
    if (!window.confirm(prompt)) return
    setBusy(true)
    const result = status === 'published' ? await publishEvent(event.id) : await cancelEvent(event.id)
    setBusy(false)
    if (result.error) setError(result.error)
    else if (result.event) setEvent(result.event)
  }
  if (loading) return <LoadingState label="Loading event details…"/>
  if (!event) return <div className="organiser-empty"><h2>Event unavailable</h2><p>{error || 'This event does not exist or is not in your organiser workspace.'}</p><RouteButton navigate={navigate} to="/organiser/events">Back to my events</RouteButton></div>
  return <><div className="detail-back"><button onClick={() => navigate('/organiser/events')}>← My events</button><StatusBadge status={event.status}/></div><div className="organiser-detail-grid"><section className="organiser-panel event-detail-panel"><img className="event-detail-cover" src={imageFailed || !event.cover_image ? fallbackImage : event.cover_image} onError={() => setImageFailed(true)} alt="Event cover"/><span className="tiny-label">{event.category.toUpperCase()} · {event.country.toUpperCase()}</span><h1>{event.title}</h1>{event.short_description && <p className="detail-summary">{event.short_description}</p>}<p className="detail-description">{event.description}</p><div className="detail-meta-grid"><DetailMeta label="City" value={event.location}/><DetailMeta label="Venue" value={event.venue || 'Not provided'}/><DetailMeta label="Address" value={event.address || 'Not provided'}/><DetailMeta label="Start" value={formatDateTime(event.start_date)}/><DetailMeta label="End" value={event.end_date ? formatDateTime(event.end_date) : 'Not provided'}/><DetailMeta label="Capacity" value={event.capacity ? String(event.capacity) : 'Unlimited'}/><DetailMeta label="Ticket price" value={event.price === 0 ? 'Free' : `${event.currency} ${Number(event.price).toFixed(2)}`}/></div></section><aside className="organiser-panel detail-side-panel"><h2>Event controls</h2><p>Created {formatDate(event.created_at)}<br/>Updated {formatDate(event.updated_at)}</p><RouteButton navigate={navigate} to={`/organiser/events/${event.id}/edit`} className="organiser-button organiser-button-primary full-width">Edit event</RouteButton><RouteButton navigate={navigate} to={`/organiser/events/${event.id}/analytics`} className="organiser-button full-width">Event analytics</RouteButton><RouteButton navigate={navigate} to={`/organiser/events/${event.id}/attendees`} className="organiser-button full-width">View attendees</RouteButton><RouteButton navigate={navigate} to={`/organiser/events/${event.id}/check-in`} className="organiser-button full-width">Open check-in</RouteButton>{event.status === 'draft' && <button className="organiser-button full-width" disabled={busy} onClick={() => void changeStatus('published')}>{busy ? 'Updating…' : 'Publish event'}</button>}{(event.status === 'published' || event.status === 'draft') && <button className="organiser-button button-danger full-width" disabled={busy} onClick={() => void changeStatus('cancelled')}>{busy ? 'Updating…' : 'Cancel event'}</button>}{error && <div className="form-error">{error}</div>}</aside></div><TicketTypesEditor eventId={event.id}/></>
}

function DetailMeta({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div> }
function formatDateTime(value: string) { return new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) }

function TicketTypesEditor({ eventId }: { eventId: string }) {
  const [types, setTypes] = useState<TicketTypeAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState({ name: '', description: '', price: '0', currency: 'USD', capacity: '', max_per_booking: '10' })
  const load = useCallback(() => getOrganiserTicketTypes(eventId).then(result => { setTypes(result.types); setError(result.error ?? ''); setLoading(false) }), [eventId])
  useEffect(() => { void load() }, [load])
  const save = async (values: { id?: string; name: string; description: string; price: string; currency: string; capacity: string; max_per_booking: string }) => {
    if (!values.name.trim() || Number(values.price) < 0 || (values.capacity && Number(values.capacity) < 1)) { setError('Enter a valid name, non-negative price and positive capacity.'); return }
    setSaving(values.id ?? 'new'); setError(''); setMessage('')
    const result = await saveTicketType(eventId, { id: values.id, name: values.name.trim(), description: values.description.trim() || null, price: Number(values.price), currency: values.currency, capacity: values.capacity ? Number(values.capacity) : null, max_per_booking: Number(values.max_per_booking) })
    setSaving('')
    if (result.error) { setError(result.error); return }
    setMessage('Ticket type saved.')
    if (!values.id) setDraft({ name: '', description: '', price: '0', currency: 'USD', capacity: '', max_per_booking: '10' })
    await load()
  }
  const remove = async (type: TicketTypeAdmin) => {
    if (!window.confirm(`Remove “${type.name}”? A ticket type with bookings cannot be removed.`)) return
    setError(''); setMessage('')
    const result = await removeTicketType(eventId, type.id)
    if (result.error) setError(result.error)
    else { setMessage('Ticket type removed.'); await load() }
  }
  const renderForm = (values: { id?: string; name: string; description: string; price: string; currency: string; capacity: string; max_per_booking: string }, update: (key: 'name' | 'description' | 'price' | 'currency' | 'capacity' | 'max_per_booking', value: string) => void) => <>
    <div className="ticket-admin-fields"><label>Ticket name<input value={values.name} onChange={event => update('name', event.target.value)} required minLength={2} maxLength={100}/></label><label>Price<input type="number" value={values.price} onChange={event => update('price', event.target.value)} min="0" step="0.01" required/></label><label>Currency<select value={values.currency} onChange={event => update('currency', event.target.value)}>{currencies.map(currency => <option key={currency}>{currency}</option>)}</select></label><label>Capacity<input type="number" value={values.capacity} onChange={event => update('capacity', event.target.value)} min="1" placeholder="Unlimited"/></label><label>Limit per booking<input type="number" value={values.max_per_booking} onChange={event => update('max_per_booking', event.target.value)} min="1" max="20" required/></label><label className="span-two">Description<input value={values.description} onChange={event => update('description', event.target.value)} maxLength={500} placeholder="Optional ticket details"/></label></div>
  </>
  return <section className="organiser-panel ticket-admin-panel"><div className="panel-heading"><div><span className="tiny-label">INVENTORY</span><h2>Ticket types</h2></div><span className="table-event-meta">Inventory is reserved and counted by Supabase.</span></div>{loading ? <LoadingState label="Loading ticket types…"/> : <>
    {types.map(type => {
      const values = { id: type.id, name: type.name, description: type.description ?? '', price: String(type.price), currency: type.currency, capacity: type.capacity === null ? '' : String(type.capacity), max_per_booking: String(type.max_per_booking) }
      return <form className="ticket-admin-row" key={type.id} onSubmit={event => { event.preventDefault(); void save(values) }}>
        {renderForm(values, (key, value) => setTypes(current => current.map(item => item.id === type.id ? { ...item, [key]: key === 'price' ? Number(value) : key === 'capacity' ? (value ? Number(value) : null) : key === 'max_per_booking' ? Number(value) : value } : item)))}
        <div className="ticket-admin-meta"><span>{type.quantity_sold} sold · {type.quantity_reserved} reserved · {type.capacity === null ? 'Unlimited capacity' : `${Math.max(0, type.capacity - type.quantity_sold - type.quantity_reserved)} remaining`}</span><span className={type.active ? 'status-badge status-published' : 'status-badge'}>{type.active ? 'On sale' : 'Paused'}</span></div>
        <div className="ticket-admin-actions"><button className="organiser-button organiser-button-primary" disabled={saving === type.id}>{saving === type.id ? 'Saving…' : 'Save type'}</button>{types.length > 1 && <button className="organiser-button button-danger" type="button" onClick={() => void remove(type)}>Remove</button>}</div>
      </form>
    })}
    <form className="ticket-admin-row new-ticket-type" onSubmit={event => { event.preventDefault(); void save(draft) }}><h3>Add a ticket type</h3>{renderForm(draft, (key, value) => setDraft(current => ({ ...current, [key]: value })))}<button className="organiser-button" disabled={saving === 'new'}>{saving === 'new' ? 'Adding…' : 'Add ticket type'}</button></form>
  </>}{error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}</section>
}

type FormValues = {
  title: string; short_description: string; description: string; category: string; country: string; location: string;
  venue: string; address: string; start_date: string; end_date: string; free: boolean; price: string;
  currency: string; capacity: string; cover_image: string; source_url: string; registration_url: string
}
const blankForm: FormValues = { title: '', short_description: '', description: '', category: '', country: '', location: '', venue: '', address: '', start_date: '', end_date: '', free: true, price: '0', currency: 'USD', capacity: '', cover_image: '', source_url: '', registration_url: '' }

function EventFormPage({ eventId, navigate }: { eventId?: string; navigate: NavigateFunction }) {
  const [event, setEvent] = useState<EventRow | null>(null)
  const [loading, setLoading] = useState(Boolean(eventId))
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    if (!eventId) return
    let active = true
    getEventById(eventId).then(result => { if (active) { setEvent(result.event); setLoadError(result.error ?? ''); setLoading(false) } })
    return () => { active = false }
  }, [eventId])
  if (loading) return <LoadingState label="Loading event for editing…"/>
  if (eventId && !event) return <div className="organiser-empty"><h2>Event unavailable</h2><p>{loadError || 'This event is not in your organiser workspace.'}</p><RouteButton navigate={navigate} to="/organiser/events">Back to my events</RouteButton></div>
  const initial: FormValues = event ? {
    title: event.title, short_description: event.short_description ?? '', description: event.description, category: event.category,
    country: event.country, location: event.location, venue: event.venue ?? '', address: event.address ?? '',
    start_date: toLocalInput(event.start_date), end_date: event.end_date ? toLocalInput(event.end_date) : '',
    free: Number(event.price) === 0, price: String(event.price), currency: event.currency,
    capacity: event.capacity === null ? '' : String(event.capacity), cover_image: event.cover_image ?? '', source_url: event.source_url ?? '', registration_url: event.registration_url ?? '',
  } : blankForm
  return <EventForm key={event?.id ?? 'new'} event={event} initial={initial} navigate={navigate}/>
}

function toLocalInput(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function EventForm({ event, initial, navigate }: { event: EventRow | null; initial: FormValues; navigate: NavigateFunction }) {
  const [values, setValues] = useState<FormValues>(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const update = <K extends keyof FormValues>(field: K, value: FormValues[K]) => setValues(current => ({ ...current, [field]: value }))
  const save = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault()
    const form = formEvent.currentTarget
    if (!form.reportValidity()) return
    setError('')
    const start = new Date(values.start_date)
    const end = new Date(values.end_date)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) { setError('Enter valid start and end dates.'); return }
    if (end <= start) { setError('The end date and time must be after the start.'); return }
    const price = values.free ? 0 : Number(values.price)
    if (!Number.isFinite(price) || price < 0) { setError('Ticket price must be zero or more.'); return }
    const capacity = Number(values.capacity)
    if (!Number.isInteger(capacity) || capacity < 1) { setError('Capacity must be a whole number greater than zero.'); return }
    const imageUrl = values.cover_image.trim()
    if (imageUrl && !validImageUrl(imageUrl)) { setError('Cover image must be a valid HTTPS URL.'); return }
    if ((values.source_url.trim() && !validImageUrl(values.source_url.trim())) || (values.registration_url.trim() && !validImageUrl(values.registration_url.trim()))) { setError('Source and registration links must use secure HTTPS URLs.'); return }
    const submitter = (formEvent.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const intent = (submitter?.value || 'draft') as 'draft' | 'published' | 'preserve'
    const nextStatus: EventStatus = intent === 'preserve' ? (event?.status ?? 'draft') : intent
    if (nextStatus === 'published' && event?.status !== 'published' && !window.confirm('Publish this event now? It will become visible in public discovery.')) return
    if (nextStatus === 'draft' && event?.status === 'published' && !window.confirm('Save as draft? This will remove the event from public discovery.')) return
    const input: EventWriteInput = {
      title: values.title.trim(), short_description: values.short_description.trim(), description: values.description.trim(),
      category: values.category, country: values.country.trim(), location: values.location.trim(), venue: values.venue.trim() || null,
      address: values.address.trim() || null, start_date: start.toISOString(), end_date: end.toISOString(),
      price, currency: values.currency, capacity, cover_image: imageUrl || null, status: nextStatus,
      source_url: values.source_url.trim() || null, registration_url: values.registration_url.trim() || null,
    }
    setSaving(true)
    const result = event ? await updateEvent(event.id, input) : await createEvent(input)
    setSaving(false)
    if (result.error) { setError(result.error); return }
    if (result.event) navigate(`/organiser/events/${result.event.id}`)
  }
  return <>
    <div className="detail-back"><button onClick={() => navigate(event ? `/organiser/events/${event.id}` : '/organiser/events')}>← {event ? 'Back to event' : 'My events'}</button>{event && <StatusBadge status={event.status}/>}</div>
    <PageHeading eyebrow={event ? 'EVENT EDITOR' : 'NEW EXPERIENCE'} title={event ? 'Edit event' : 'Create an event'} description="Share the details people need to make this experience part of their plans."/>
    {!event && <EventWebpageImporter onDraft={draft => setValues(current => ({ ...current, ...draft }))}/>}
    <form className="organiser-form" onSubmit={event => void save(event)}>
      <section className="organiser-panel form-section"><FormSectionTitle number="01" title="Basic information" note="Start with the story of your event."/><div className="form-grid"><label className="span-two">Event title<input value={values.title} onChange={event => update('title', event.target.value)} required minLength={3} maxLength={180} placeholder="Give your event a memorable name"/></label><label className="span-two">Short description<textarea value={values.short_description} onChange={event => update('short_description', event.target.value)} required minLength={1} maxLength={240} rows={2} placeholder="A concise introduction for event cards"/><small className="input-hint">{values.short_description.length}/240 characters</small></label><label className="span-two">Full description<textarea value={values.description} onChange={event => update('description', event.target.value)} required minLength={1} maxLength={10000} rows={6} placeholder="What will guests experience? Include useful details and what to expect."/></label><label>Category<select value={values.category} onChange={event => update('category', event.target.value)} required><option value="">Choose a category</option>{eventCategories.map(category => <option key={category}>{category}</option>)}</select></label></div></section>
      <section className="organiser-panel form-section"><FormSectionTitle number="02" title="Location" note="Help guests find their way there."/><div className="form-grid"><label>Country<input value={values.country} onChange={event => update('country', event.target.value)} required maxLength={100} placeholder="e.g. Nigeria"/></label><label>City<input value={values.location} onChange={event => update('location', event.target.value)} required maxLength={180} placeholder="e.g. Lagos"/></label><label className="span-two">Venue<input value={values.venue} onChange={event => update('venue', event.target.value)} maxLength={180} placeholder="Venue name (optional)"/></label><label className="span-two">Full address<textarea value={values.address} onChange={event => update('address', event.target.value)} maxLength={300} rows={2} placeholder="Street address and directions (optional)"/></label></div></section>
      <section className="organiser-panel form-section"><FormSectionTitle number="03" title="Schedule" note="Times are shown in your local time zone."/><div className="form-grid"><label>Start date and time<input type="datetime-local" value={values.start_date} onChange={event => update('start_date', event.target.value)} required/></label><label>End date and time<input type="datetime-local" value={values.end_date} onChange={event => update('end_date', event.target.value)} required min={values.start_date || undefined}/></label></div></section>
      <section className="organiser-panel form-section"><FormSectionTitle number="04" title="Tickets and capacity" note="No payment is processed in this milestone."/><div className="ticket-toggle" role="group" aria-label="Ticket type"><button type="button" className={values.free ? 'selected' : ''} onClick={() => { update('free', true); update('price', '0') }}>Free</button><button type="button" className={!values.free ? 'selected' : ''} onClick={() => update('free', false)}>Paid</button></div><div className="form-grid ticket-grid">{!values.free && <><label>Ticket price<input type="number" value={values.price} onChange={event => update('price', event.target.value)} min="0" step="0.01" required placeholder="0.00"/></label><label>Currency<select value={values.currency} onChange={event => update('currency', event.target.value)}>{currencies.map(currency => <option key={currency}>{currency}</option>)}</select></label></>}<label className={values.free ? 'span-two' : ''}>Available capacity<input type="number" value={values.capacity} onChange={event => update('capacity', event.target.value)} min="1" step="1" required placeholder="Maximum number of guests"/></label></div></section>
      <section className="organiser-panel form-section"><FormSectionTitle number="05" title="Cover image" note="Paste a public HTTPS image URL. Uploads are not enabled."/><label className="cover-url-field">Cover image URL<input type="url" value={values.cover_image} onChange={event => { update('cover_image', event.target.value); setImageFailed(false) }} placeholder="https://example.com/event-cover.jpg"/></label>{values.cover_image && !validImageUrl(values.cover_image) && <div className="input-hint image-validation">Use a secure HTTPS URL to preview this image.</div>}<div className="cover-preview">{values.cover_image && validImageUrl(values.cover_image) ? <img src={imageFailed ? fallbackImage : values.cover_image} onError={() => setImageFailed(true)} alt="Cover preview"/> : <img src={fallbackImage} alt="Default event cover preview"/>}<div><span className="tiny-label">PREVIEW</span><strong>{values.title || 'Your event title'}</strong><small>{values.location || 'City'}{values.country ? `, ${values.country}` : ''}</small>{imageFailed && <small className="form-error">Couldn’t load this image. Showing the fallback preview.</small>}</div></div></section>
      <section className="organiser-panel form-section"><FormSectionTitle number="06" title="Public source and registration" note="Optional links appear on the public event page."/><div className="form-grid"><label>Source webpage URL<input type="url" value={values.source_url} onChange={event => update('source_url', event.target.value)} maxLength={2048} placeholder="https://organiser.example/event"/></label><label>Official registration URL<input type="url" value={values.registration_url} onChange={event => update('registration_url', event.target.value)} maxLength={2048} placeholder="https://organiser.example/register"/></label></div></section>
      {error && <div className="form-error form-submit-error" role="alert">{error}</div>}
      <div className="form-actions"><button className="organiser-button" type="submit" name="intent" value={event?.status === 'published' || event?.status === 'cancelled' || event?.status === 'completed' ? 'preserve' : 'draft'} disabled={saving}>{saving ? 'Saving…' : event ? 'Save changes' : 'Save as draft'}</button>{event?.status !== 'cancelled' && event?.status !== 'completed' && <button className="organiser-button organiser-button-primary" type="submit" name="intent" value="published" disabled={saving}>{saving ? 'Saving…' : event?.status === 'published' ? 'Save and publish' : 'Publish event'} <span>→</span></button>}</div>
      <p className="form-footnote">Publishing makes the event visible in public discovery. Save a draft to keep it private.</p>
    </form>
  </>
}

function FormSectionTitle({ number, title, note }: { number: string; title: string; note: string }) { return <div className="form-section-title"><span>{number}</span><div><h2>{title}</h2><p>{note}</p></div></div> }

function validImageUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
}
