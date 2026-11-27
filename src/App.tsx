import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import './Ticketing.css'
import { supabase, supabaseConfigError } from './lib/supabase'
import { signIn, signOut, signUp } from './services/authService'
import { createBooking, getEventTicketTypes, initializePaystackPayment } from './services/bookingService'
import type { BookingResult, TicketTypeView } from './services/bookingService'
import { rememberPaymentBooking } from './services/paymentPresentation'
import { startBookingCheckout } from './services/checkoutFlow'
import { createSingleFlightGate } from './services/singleFlightGate'
import { fetchCommunities, setCommunityMembership } from './services/communityService'
import { fetchEventById, fetchEvents, fetchSavedEventIds, setSavedEvent } from './services/eventService'
import type { CommunityRow, EventView } from './types/database'
import { OrganiserApp } from './pages/OrganiserApp'
import type { NavigateFunction } from './pages/OrganiserApp'
import { MyTicketsApp } from './pages/MyTicketsApp'
import { PaymentReturnApp } from './pages/PaymentReturnApp'

const categories = ['All', 'Technology', 'Music', 'Business', 'Art & Culture', 'Sports', 'Gaming', 'Education', 'Adventure', 'Social']
const cities = [
  { name: 'Lagos', country: 'Nigeria', n: '01', image: 'photo-1519671482749-fd09be7ccebf' },
  { name: 'London', country: 'United Kingdom', n: '02', image: 'photo-1513635269975-59663e0ac1ad' },
  { name: 'New York', country: 'United States', n: '03', image: 'photo-1496588152823-86ff7695e68f' },
  { name: 'Dubai', country: 'United Arab Emirates', n: '04', image: 'photo-1512453979798-5ea266f8880c' },
  { name: 'Tokyo', country: 'Japan', n: '05', image: 'photo-1540959733332-eab4deabeeaf' },
]
const photo = (id: string, width = 900) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=85`
const formatCount = (count: number) => new Intl.NumberFormat('en', { notation: count >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(count)

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    bookmark: <path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-4-6 4z"/>,
    close: <><path d="m18 6-12 12"/><path d="m6 6 12 12"/></>, menu: <><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>, check: <path d="m5 12 4 4L19 6"/>, user: <><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
  }
  return <svg {...common}>{paths[name] ?? paths.arrow}</svg>
}

type AuthMode = 'signin' | 'signup'
type ModalMode = 'host' | AuthMode | null

function HomePage({ navigate }: { navigate: NavigateFunction }) {
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState('Anywhere')
  const [searchCategory, setSearchCategory] = useState('Any category')
  const [events, setEvents] = useState<EventView[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState('')
  const [eventReload, setEventReload] = useState(0)
  const [communities, setCommunities] = useState<CommunityRow[]>([])
  const [memberships, setMemberships] = useState<string[]>([])
  const [ownerMemberships, setOwnerMemberships] = useState<string[]>([])
  const [communitiesLoading, setCommunitiesLoading] = useState(true)
  const [communitiesError, setCommunitiesError] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const user = session?.user ?? null
  const userId = user?.id
  const [saved, setSaved] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('nodara-saved') || '[]') as string[] } catch { return [] } })
  const [selected, setSelected] = useState<EventView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [modal, setModal] = useState<ModalMode>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authName, setAuthName] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [bookingBusy, setBookingBusy] = useState(false)
  const bookingGateRef = useRef(createSingleFlightGate())
  const [ticketTypes, setTicketTypes] = useState<TicketTypeView[]>([])
  const [ticketTypesLoading, setTicketTypesLoading] = useState(false)
  const [ticketQuantities, setTicketQuantities] = useState<Record<string, number>>({})
  const [bookingOutcome, setBookingOutcome] = useState<BookingResult | null>(null)
  const [bookingError, setBookingError] = useState('')
  const [showBookingReview, setShowBookingReview] = useState(false)

  const showNotice = useCallback((message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3800) }, [])
  const openAuth = (mode: AuthMode = 'signin') => { setAuthError(''); setAuthMessage(''); setModal(mode) }

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) showNotice('Could not restore your sign-in session. Please sign in again.')
      setSession(data.session)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [showNotice])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(async () => {
      setEventsLoading(true)
      setEventsError('')
      const activeCategory = category !== 'All' ? category : searchCategory
      const result = await fetchEvents({ query, category: activeCategory, location })
      if (!active) return
      setEvents(result.events)
      setEventsError(result.error ? result.error.message : '')
      setEventsLoading(false)
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, category, searchCategory, location, eventReload])

  const reloadCommunities = useCallback(async () => {
    setCommunitiesLoading(true)
    const result = await fetchCommunities()
    setCommunities(result.communities)
    setMemberships(result.memberships)
    setOwnerMemberships(result.ownerMemberships)
    setCommunitiesError(result.error?.message ?? '')
    setCommunitiesLoading(false)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { void reloadCommunities() }, 0)
    return () => window.clearTimeout(timer)
  }, [reloadCommunities, userId])

  useEffect(() => {
    if (!userId) return
    let active = true
    const load = async () => {
      const localSaved = (() => { try { return JSON.parse(localStorage.getItem('nodara-saved') || '[]') as string[] } catch { return [] } })()
      const result = await fetchSavedEventIds(userId)
      if (!active) return
      const merged = Array.from(new Set([...result.ids, ...localSaved]))
      for (const eventId of localSaved) if (!result.ids.includes(eventId)) await setSavedEvent(userId, eventId, true)
      if (!active) return
      setSaved(merged)
      localStorage.removeItem('nodara-saved')
      if (result.error) showNotice('Saved experiences could not be synced. Try again shortly.')
    }
    void load()
    return () => { active = false }
  }, [userId, showNotice])

  useEffect(() => {
    if (!userId) localStorage.setItem('nodara-saved', JSON.stringify(saved))
  }, [saved, userId])

  const filtered = useMemo(() => events, [events])
  const doSearch = () => { document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }

  const openEvent = async (event: EventView) => {
    setSelected(event)
    setTicketTypes([])
    setTicketTypesLoading(true)
    setTicketQuantities({})
    setBookingOutcome(null)
    setBookingError('')
    setShowBookingReview(false)
    setDetailLoading(true)
    const result = await fetchEventById(event.id)
    if (result.event) setSelected(result.event)
    if (result.error) showNotice('Could not refresh the event details. Showing the available listing information.')
    setDetailLoading(false)
  }

  const toggleSaved = async (event: EventView) => {
    const shouldSave = !saved.includes(event.id)
    setSaved(current => shouldSave ? [...current, event.id] : current.filter(id => id !== event.id))
    if (!user) {
      const next = shouldSave ? [...saved, event.id] : saved.filter(id => id !== event.id)
      localStorage.setItem('nodara-saved', JSON.stringify(next))
      showNotice(shouldSave ? 'Saved on this device. Sign in to sync across devices.' : 'Removed from saved experiences.')
      return
    }
    const result = await setSavedEvent(user.id, event.id, shouldSave)
    if (result.error) {
      setSaved(current => shouldSave ? current.filter(id => id !== event.id) : [...current, event.id])
      showNotice('code' in result.error && result.error.code === '23505' ? 'This experience is already saved.' : 'Could not update saved experiences. Please try again.')
      return
    }
    showNotice(shouldSave ? 'Saved to your account.' : 'Removed from saved experiences.')
  }

  const toggleMembership = async (community: CommunityRow) => {
    if (!user) { openAuth('signin'); showNotice('Sign in to join a community.'); return }
    if (ownerMemberships.includes(community.id)) { showNotice('Community owners can’t leave until ownership transfer is available.'); return }
    const isMember = memberships.includes(community.id)
    const result = await setCommunityMembership(user.id, community.id, !isMember)
    if (result.error) {
      showNotice('code' in result.error && result.error.code === '23505' ? 'You are already a member.' : 'Could not update membership. Please try again.')
      return
    }
    setMemberships(current => isMember ? current.filter(id => id !== community.id) : [...current, community.id])
    setCommunities(current => current.map(item => item.id === community.id ? { ...item, member_count: item.member_count + (isMember ? -1 : 1) } : item))
    showNotice(isMember ? `You left ${community.name}.` : `You joined ${community.name}.`)
  }

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthError('')
    setAuthMessage('')
    setAuthBusy(true)
    const result = modal === 'signup'
      ? await signUp(authEmail.trim(), authPassword, authName.trim())
      : await signIn(authEmail.trim(), authPassword)
    setAuthBusy(false)
    if (result.error) {
      setAuthError(userMessage(result.error.message))
      return
    }
    if (modal === 'signup' && result.user && !result.user.email_confirmed_at) {
      setAuthMessage('Check your inbox for a confirmation link. Your account will be ready after you verify your email.')
      return
    }
    setModal(null)
    setAuthEmail('')
    setAuthPassword('')
    setAuthName('')
    showNotice(modal === 'signup' ? 'Your NODARA account is ready.' : 'You are signed in.')
  }

  const handleSignOut = async () => {
    const result = await signOut()
    if (result.error) showNotice('Could not sign out. Please try again.')
    else showNotice('You are signed out.')
  }

  const launchPaystackCheckout = async (bookingId: string) => {
    if (!bookingGateRef.current.tryEnter()) return
    setBookingBusy(true)
    setBookingError('')
    let result: Awaited<ReturnType<typeof initializePaystackPayment>>
    try { result = await initializePaystackPayment(bookingId) }
    catch {
      setBookingError('Checkout could not be reached. Your reservation remains in My Tickets; check its status before retrying.')
      setBookingBusy(false)
      bookingGateRef.current.release()
      return
    }
    setBookingBusy(false)
    bookingGateRef.current.release()
    if (result.error || !result.payment) {
      setBookingError(result.error || 'Checkout could not be started. Your reservation is still available until it expires. Try again.')
      return
    }
    let checkoutUrl: URL
    try { checkoutUrl = new URL(result.payment.authorizationUrl) } catch {
      setBookingError('Checkout returned an invalid address. Your reservation remains in My Tickets; check payment status before retrying.')
      return
    }
    if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.paystack.com') {
      setBookingError('Checkout returned an untrusted address. Your reservation remains in My Tickets; check payment status before retrying.')
      return
    }
    rememberPaymentBooking(result.payment.reference, bookingId)
    window.location.assign(checkoutUrl.toString())
  }

  const requestBooking = async () => {
    if (!selected) return
    if (!user) { setModal('signin'); showNotice('Sign in to book tickets.'); return }
    const items = ticketTypes.map(type => ({ ticket_type_id: type.id, quantity: ticketQuantities[type.id] ?? 0 })).filter(item => item.quantity > 0)
    if (!items.length) { setBookingError('Choose at least one ticket type.'); return }
    if (!bookingGateRef.current.tryEnter()) return
    setBookingBusy(true)
    setBookingError('')
    try {
      const result = await startBookingCheckout(selected.id, items, {
        createBooking,
        initializePayment: initializePaystackPayment,
        rememberBooking: rememberPaymentBooking,
        redirect: url => window.location.assign(url),
      })
      if (result.kind === 'failed') setBookingError(result.error)
      else {
        setBookingOutcome(result.booking)
        if (result.kind === 'initialization_failed') setBookingError(result.error)
      }
    } catch {
      setBookingError('Booking could not be completed. Please check My Tickets before trying again.')
    } finally {
      setBookingBusy(false)
      bookingGateRef.current.release()
    }
  }
  const selectedTicketCount = ticketTypes.reduce((sum, type) => sum + (ticketQuantities[type.id] ?? 0), 0)
  const selectedBookingTotal = ticketTypes.reduce((sum, type) => sum + type.price * (ticketQuantities[type.id] ?? 0), 0)

  const selectedEventId = selected?.id
  useEffect(() => {
    if (!selectedEventId) return
    let active = true
    getEventTicketTypes(selectedEventId).then(result => {
      if (!active) return
      setTicketTypes(result.types)
      setBookingError(result.error ?? '')
      setTicketTypesLoading(false)
    })
    return () => { active = false }
  }, [selectedEventId])

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#home" aria-label="NODARA home"><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span></a>
      <nav className={menuOpen ? 'main-nav open' : 'main-nav'} aria-label="Main navigation"><a href="#discover" onClick={() => setMenuOpen(false)}>Discover</a><a href="#trending" onClick={() => setMenuOpen(false)}>Explore</a><a href="#communities" onClick={() => setMenuOpen(false)}>Communities</a><a href="#host" onClick={() => setMenuOpen(false)}>Experiences</a></nav>
      <div className="nav-actions"><a className="nav-search" href="#search" aria-label="Search"><Icon name="search"/></a>{user && <a className="create-link" href="/my-tickets" onClick={event => { event.preventDefault(); navigate('/my-tickets') }}>My tickets</a>}<a className="create-link" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}><Icon name="plus" size={16}/> Create</a>{user ? <><span className="user-indicator"><Icon name="user" size={15}/>{user.user_metadata.full_name || user.email}</span><button className="signin" onClick={() => void handleSignOut()}>Sign out</button></> : <button className="signin" onClick={() => openAuth('signin')}>Sign in</button>}<button className="button button-small" onClick={() => user ? navigate('/organiser/dashboard') : openAuth('signup')}>{user ? 'Organiser' : 'Get started'} <Icon name="arrow" size={15}/></button></div>
      <button className="mobile-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close menu' : 'Open menu'}><Icon name={menuOpen ? 'close' : 'menu'} size={23}/></button>
    </header>
    {supabaseConfigError && <div className="config-banner" role="status">{supabaseConfigError}</div>}
    <main id="home">
      <section className="hero section-wrap"><div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> YOUR WORLD, OPENED UP</div><h1>There's more to<br/><span>experience.</span></h1><p className="hero-subtitle">Discover events, communities, experiences and opportunities happening around the world. Find your people. Be part of something.</p><div className="hero-actions"><a className="button" href="#discover">Explore experiences <Icon name="arrow" size={16}/></a><a className="text-link" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}>Host an event <Icon name="arrow" size={15}/></a></div><div className="hero-proof"><div className="avatar-stack"><span>AM</span><span>KO</span><span>JT</span><span>+</span></div><p><strong>Good things happen together.</strong><br/>Find your next thing with NODARA.</p></div></div>
        <div className="hero-art" aria-label="A collage of people at real-world experiences"><div className="hero-photo hero-photo-main"><img src={photo('photo-1523580494863-6f3031224c94', 1100)} alt="People gathered at a vibrant live event"/><span className="photo-caption"><b>01 / 04</b> MOMENTS THAT MOVE YOU</span></div><div className="hero-photo hero-photo-top"><img src={photo('photo-1514525253161-7a46d19cd819', 500)} alt="Crowd enjoying a live music performance"/></div><div className="hero-photo hero-photo-bottom"><img src={photo('photo-1521737711867-e3b97375f902', 500)} alt="Creative team collaborating in a workshop"/></div><div className="floating-note"><span className="note-icon"><Icon name="pin" size={16}/></span><span><b>Something is happening</b><small>Everywhere around you</small></span><span className="note-arrow"><Icon name="arrow" size={15}/></span></div><span className="art-index">N° 001 — GLOBAL DISCOVERY</span></div>
      </section>
      <section className="search-area section-wrap" id="search"><div className="search-intro"><span className="tiny-label">FIND YOUR NEXT THING</span><span className="search-side-note">A world of possibilities, one search away.</span></div><div className="search-panel"><label className="search-field"><span className="search-icon"><Icon name="search"/></span><span className="field-copy"><small>I'm looking for</small><input value={query} onChange={e => setQuery(e.target.value)} placeholder="What do you want to experience?" aria-label="Search experiences"/></span></label><label className="select-field"><span className="field-symbol"><Icon name="pin"/></span><span className="field-copy"><small>Where</small><select value={location} onChange={e => setLocation(e.target.value)} aria-label="Choose a location"><option>Anywhere</option>{cities.map(city => <option key={city.name}>{city.name}</option>)}</select></span></label><label className="select-field"><span className="field-copy"><small>Experience type</small><select value={searchCategory} onChange={e => setSearchCategory(e.target.value)} aria-label="Choose an experience type"><option>Any category</option>{categories.slice(1).map(item => <option key={item}>{item}</option>)}</select></span></label><button className="search-submit" onClick={doSearch} aria-label="Search experiences"><Icon name="search" size={20}/><span>Search</span></button></div></section>
      <section className="discover section-wrap" id="discover"><div className="section-heading"><div><span className="tiny-label">CURATED FOR THE CURIOUS</span><h2>Discover what's happening<span className="green-dot">.</span></h2><p>Experiences worth making time for.</p></div><a className="view-all" href="#discover">View all experiences <Icon name="arrow" size={16}/></a></div><div className="category-row" role="group" aria-label="Filter experiences by category">{categories.map(item => <button key={item} className={category === item ? 'category-chip active' : 'category-chip'} onClick={() => setCategory(item)}>{item}</button>)}</div>
        <div className="results-label"><span>{eventsLoading ? 'FINDING EXPERIENCES…' : `${filtered.length} EXPERIENCES TO EXPLORE`}</span><span>LIVE LISTINGS · PUBLISHED EVENTS</span></div>
        {eventsError && !supabaseConfigError && <div className="inline-error" role="alert">We couldn’t load experiences right now. Check your connection and try again. <button onClick={() => setEventReload(value => value + 1)}>Retry</button></div>}
        {eventsLoading ? <div className="loading-state" aria-live="polite"><span className="loading-spinner"/>Loading experiences…</div> : filtered.length ? <div className="event-grid">{filtered.map((event, i) => <article className="event-card" key={event.id}><button className="event-image" onClick={() => void openEvent(event)} aria-label={`View ${event.title} details`}><img src={event.image} alt="" loading="lazy"/><span className="event-tag">{event.tag}</span><span className="image-number">{String(i + 1).padStart(2, '0')}</span></button><button className={saved.includes(event.id) ? 'save-button saved' : 'save-button'} onClick={() => void toggleSaved(event)} aria-label={saved.includes(event.id) ? 'Remove saved experience' : 'Save experience'} aria-pressed={saved.includes(event.id)}><Icon name="bookmark" size={17}/></button><div className="event-info"><div className="event-category">{event.category}</div><button className="event-title" onClick={() => void openEvent(event)}>{event.title}</button><div className="event-meta"><span><Icon name="calendar" size={14}/>{event.date}</span><span><Icon name="pin" size={14}/>{event.city}, {event.country}</span></div><div className="event-bottom"><span>{event.price}</span><button onClick={() => void openEvent(event)}>Details <Icon name="arrow" size={14}/></button></div></div></article>)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name="search" size={22}/></span><h3>{eventsError ? 'Experiences are unavailable' : 'No experiences found'}</h3><p>{eventsError ? 'Please try again in a moment.' : 'There are no published experiences matching these filters yet. Check back soon.'}</p>{!eventsError && <button className="button button-outline" onClick={() => { setQuery(''); setCategory('All'); setSearchCategory('Any category'); setLocation('Anywhere') }}>Clear filters</button>}</div>}
      </section>
      <section className="trending section-wrap" id="trending"><div className="section-heading"><div><span className="tiny-label">OUT THERE, RIGHT NOW</span><h2>Trending around the world<span className="green-dot">.</span></h2><p>Discover experiences in cities near and far.</p></div><div className="trend-controls"><span>01 — 05</span><span className="control-line"/><span>WORLDWIDE</span></div></div><div className="city-grid">{cities.map(city => { const count = events.filter(event => event.city.toLowerCase().includes(city.name.toLowerCase())).length; return <button className="city-card" key={city.name} onClick={() => { setLocation(city.name); setCategory('All'); setSearchCategory('Any category'); document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }}><img src={photo(city.image, 650)} alt={`${city.name} city`} loading="lazy"/><span className="city-shade"/><span className="city-number">{city.n} / CITY</span><span className="city-copy"><small>{city.country}</small><strong>{city.name}</strong><span>{count ? `${count} ${count === 1 ? 'experience' : 'experiences'}` : 'Explore experiences'} <Icon name="arrow" size={14}/></span></span></button> })}</div></section>
      <section className="community-section" id="communities"><div className="section-wrap community-inner"><div className="community-heading"><div><span className="tiny-label">BETTER, TOGETHER</span><h2>Find your people<span className="green-dot">.</span></h2><p>Discover communities built around the things you love.</p></div><a href="#communities" className="view-all">Explore communities <Icon name="arrow" size={16}/></a></div>{communitiesLoading ? <div className="loading-state community-loading"><span className="loading-spinner"/>Loading communities…</div> : communities.length ? <div className="community-grid">{communities.map(community => <article className="community-card" key={community.id}><div className="community-avatar mint">{community.name.charAt(0).toUpperCase()}<span>✳</span></div><span className="community-type">{community.category.toUpperCase()}</span><h3>{community.name}</h3><p>{community.description}</p><div className="community-foot"><span><span className="member-dot"/> {formatCount(community.member_count)} members</span><button disabled={ownerMemberships.includes(community.id)} className={memberships.includes(community.id) ? 'join-button joined' : 'join-button'} onClick={() => void toggleMembership(community)}>{ownerMemberships.includes(community.id) ? 'Owner' : memberships.includes(community.id) ? <><Icon name="check" size={14}/> Joined</> : 'Join community'}</button></div></article>)}</div> : <div className="empty-community"><span>{communitiesError ? 'Communities are temporarily unavailable.' : 'New communities are taking shape.'}</span>{communitiesError && <button onClick={() => void reloadCommunities()}>Retry</button>}</div>}<div className="demo-note"><span/> Membership is linked to your account. Sign in to join or leave a community.</div></div></section>
      <section className="host-wrap section-wrap" id="host"><div className="host-panel"><div className="host-orbit orbit-one"/><div className="host-orbit orbit-two"/><div className="host-copy"><span className="tiny-label">FOR THE PEOPLE WHO BRING US TOGETHER</span><h2>Have something<br/>worth sharing<span className="green-dot">?</span></h2><p>Bring people together. Create experiences. Build your community.</p><a className="button" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}>Start hosting <Icon name="arrow" size={16}/></a></div><div className="host-aside"><span className="host-star">✳</span><span className="host-aside-label">THE WORLD IS<br/>YOUR AUDIENCE.</span><span className="host-aside-count">NODARA / 001</span></div></div></section>
    </main>
    <footer className="footer"><div className="section-wrap"><div className="footer-main"><div className="footer-brand-col"><a className="brand" href="#home"><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span></a><p>Discover. Connect. Experience.</p><span className="footer-manifesto">A world more connected<br/>to what makes us feel alive.</span></div><div className="footer-links"><div><h4>PRODUCT</h4><a href="#discover">Discover</a><a href="#trending">Explore</a><a href="#communities">Communities</a><a href="#discover">Experiences</a></div><div><h4>COMPANY</h4><a href="#home">About</a><a href="mailto:hello@nodara.example">Contact</a><a href="mailto:careers@nodara.example">Careers</a></div><div><h4>RESOURCES</h4><a href="mailto:help@nodara.example">Help centre</a><a href="#host">Organiser guide</a><a href="#footer-legal">Privacy</a><a href="#footer-legal">Terms</a></div><div><h4>FOLLOW THE FEELING</h4><a href="https://x.com" target="_blank" rel="noreferrer">X <span>↗</span></a><a href="https://instagram.com" target="_blank" rel="noreferrer">Instagram <span>↗</span></a><a href="https://linkedin.com" target="_blank" rel="noreferrer">LinkedIn <span>↗</span></a></div></div></div><div className="footer-bottom" id="footer-legal"><span>© 2026 NODARA. MADE FOR THE MOMENTS THAT MATTER.</span><span>BUILT FOR EVERYWHERE <i>✳</i></span></div></div></footer>
    {notice && <div className="toast" role="status">{notice}</div>}
    {(selected || modal) && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) { setSelected(null); setModal(null) } }}><div className="modal" role="dialog" aria-modal="true" aria-label={selected ? 'Experience details' : modal === 'host' ? 'Start hosting' : modal === 'signup' ? 'Create your account' : 'Sign in'}><button className="modal-close" onClick={() => { setSelected(null); setModal(null); setAuthError('') }} aria-label="Close"><Icon name="close"/></button>{selected ? <><img className="modal-image" src={selected.image} alt=""/><div className="modal-content"><span className="tiny-label">{selected.category} · PUBLISHED LISTING</span><h2>{selected.title}</h2>{selected.shortDescription && <p>{selected.shortDescription}</p>}<p>{selected.date} · {selected.city}, {selected.country}{selected.address ? ` · ${selected.address}` : ''}</p>{detailLoading ? <p>Refreshing experience details…</p> : <p>{selected.description}</p>}<button className="button" onClick={() => void toggleSaved(selected)}><Icon name="bookmark" size={16}/>{saved.includes(selected.id) ? 'Saved' : 'Save experience'}</button>{bookingOutcome ? <div className="auth-success booking-result" role="status"><strong>{bookingOutcome.status === 'confirmed' ? 'Your tickets are confirmed.' : 'Payment is still pending.'}</strong><span>Booking reference: {bookingOutcome.booking_reference}</span><span>{bookingOutcome.status === 'confirmed' ? `${bookingOutcome.ticket_count} digital ticket${bookingOutcome.ticket_count === 1 ? '' : 's'} issued.` : 'No payment has been verified and no ticket has been issued.'}</span>{bookingOutcome.status === 'confirmed' ? <button className="button" onClick={() => { setSelected(null); navigate('/my-tickets') }}>View my tickets</button> : <><button className="button booking-button" onClick={() => void launchPaystackCheckout(bookingOutcome.booking_id)} disabled={bookingBusy}>{bookingBusy ? 'Opening secure checkout…' : 'Continue to secure checkout'} <Icon name="arrow" size={15}/></button><button className="signin" onClick={() => { setSelected(null); navigate('/my-tickets') }}>Check booking status in My Tickets</button></>}</div> : <><div className="ticket-picker"><strong>Select tickets</strong>{ticketTypes.length ? ticketTypes.map(type => <label className="ticket-choice" key={type.id}><span><b>{type.name}</b><small>{type.price === 0 ? 'Free' : new Intl.NumberFormat('en', { style: 'currency', currency: type.currency }).format(type.price)}{type.remaining !== null ? ` · ${type.remaining} remaining` : ''}</small>{type.description && <small>{type.description}</small>}</span><select aria-label={`Quantity for ${type.name}`} value={ticketQuantities[type.id] ?? 0} onChange={event => setTicketQuantities(current => ({ ...current, [type.id]: Number(event.target.value) }))}><option value={0}>0</option>{Array.from({ length: Math.min(type.max_per_booking, type.remaining ?? type.max_per_booking) }, (_, index) => index + 1).map(quantity => <option key={quantity} value={quantity}>{quantity}</option>)}</select></label>) : <small>{bookingError || (ticketTypesLoading ? 'Loading ticket availability…' : 'No tickets are currently available for this event.')}</small>}<div className="booking-total"><span>Estimated total</span><strong>{new Intl.NumberFormat('en', { style: 'currency', currency: ticketTypes[0]?.currency ?? selected.currency }).format(ticketTypes.reduce((sum, type) => sum + type.price * (ticketQuantities[type.id] ?? 0), 0))}</strong></div></div>{showBookingReview && <div className="booking-review"><strong>Review your booking</strong><span>{selectedTicketCount} ticket{selectedTicketCount === 1 ? '' : 's'} · {new Intl.NumberFormat('en', { style: 'currency', currency: ticketTypes[0]?.currency ?? selected.currency }).format(selectedBookingTotal)}</span><small>Free tickets are confirmed after booking. Paid orders remain pending until payment is independently verified.</small><button className="signin" onClick={() => setShowBookingReview(false)}>Change tickets</button></div>}{bookingError && <div className="auth-error" role="alert">{bookingError}</div>}<button className="button booking-button" onClick={() => { if (!user) { setModal('signin'); return }; if (!showBookingReview) { if (selectedTicketCount === 0) { setBookingError('Choose at least one ticket type.'); return }; setShowBookingReview(true); return }; void requestBooking() }} disabled={bookingBusy || !ticketTypes.length}>{bookingBusy ? 'Securing tickets…' : !user ? 'Sign in to book' : showBookingReview ? 'Confirm booking' : 'Review booking'} <Icon name="arrow" size={15}/></button><small className="pending-note">Free tickets are issued after booking. Paid orders stay pending until a payment is independently verified.</small></>}</div></> : modal === 'host' ? <div className="modal-content placeholder-content"><span className="tiny-label">NODARA FOR ORGANISERS</span><h2>Your next chapter starts here.</h2><p>Organiser tools are in development. Soon you’ll be able to create an experience, reach your community and bring people together.</p><span className="coming-soon">ORGANISER TOOLS · COMING SOON</span><button className="button button-outline" onClick={() => { setModal(null); document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }}>Explore experiences <Icon name="arrow" size={15}/></button></div> : <div className="modal-content auth-content"><span className="tiny-label">{modal === 'signup' ? 'YOUR WORLD, OPENED UP' : 'WELCOME BACK'}</span><h2>{modal === 'signup' ? 'Make room for more.' : 'Find your way in.'}</h2><p>{modal === 'signup' ? 'Create an account to save experiences and find your communities.' : 'Sign in to sync saved experiences and manage your memberships.'}</p><form onSubmit={event => void submitAuth(event)}>{modal === 'signup' && <label>Your name<input autoComplete="name" value={authName} onChange={event => setAuthName(event.target.value)} required maxLength={120} placeholder="Full name"/></label>}<label>Email address<input type="email" autoComplete="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} required placeholder="you@example.com"/></label><label>Password<input type="password" autoComplete={modal === 'signup' ? 'new-password' : 'current-password'} value={authPassword} onChange={event => setAuthPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters"/></label>{authError && <div className="auth-error" role="alert">{authError}</div>}{authMessage && <div className="auth-success" role="status">{authMessage}</div>}<button className="button auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : modal === 'signup' ? 'Create account' : 'Sign in'} <Icon name="arrow" size={15}/></button></form><div className="auth-switch">{modal === 'signup' ? 'Already have an account?' : 'New to NODARA?'} <button onClick={() => { setAuthError(''); setAuthMessage(''); setModal(modal === 'signup' ? 'signin' : 'signup') }}>{modal === 'signup' ? 'Sign in' : 'Create account'}</button></div><small className="pending-note">{modal === 'signup' ? 'We’ll email you a confirmation link before first sign-in.' : 'Your session is stored securely by Supabase Auth.'}</small></div>}</div></div>}
  </div>
}

function userMessage(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('invalid login credentials')) return 'Email or password did not match. Check them and try again.'
  if (lower.includes('email not confirmed')) return 'Confirm your email using the link we sent before signing in.'
  if (lower.includes('already registered') || lower.includes('user already registered')) return 'That email already has an account. Sign in instead.'
  if (lower.includes('password should be') || lower.includes('weak password')) return 'Use a stronger password with at least 8 characters.'
  if (lower.includes('rate limit') || lower.includes('too many requests')) return 'Too many attempts. Wait a little and try again.'
  if (lower.includes('fetch') || lower.includes('network')) return 'Could not reach Supabase. Check the project URL and your internet connection.'
  return message || 'Authentication failed. Please try again.'
}

function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const navigate = useCallback<NavigateFunction>((path) => {
    window.history.pushState({}, '', path)
    setPathname(path)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  if (pathname.startsWith('/organiser')) return <OrganiserApp pathname={pathname} navigate={navigate}/>
  if (pathname === '/my-tickets') return <MyTicketsApp navigate={navigate}/>
  if (pathname === '/payment/return') return <PaymentReturnApp navigate={navigate}/>
  return <HomePage navigate={navigate}/>
}

export default App
