import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { fetchCommunities, fetchCommunityCard, searchCommunities, setCommunityMembership } from './services/communityService'
import type { CommunitySearchResult, PublicCommunityCard } from './services/communityService'
import { clearDiscoveryFilters, normalizeSearchTerm, readDiscoveryFilters, writeDiscoveryFilters } from './services/searchUtils'
import type { DiscoveryFilters } from './services/searchUtils'
import { fetchEventById, fetchEvents, fetchSavedEventIds, setSavedEvent } from './services/eventService'
import { loadRecommendedEvents, saveRecommendationInterests } from './services/recommendationService'
import { normalizeInterestCategories } from './services/recommendationEngine'
import { fetchTrendingCommunities, fetchTrendingEvents } from './services/trendingService'
import type { TrendingCommunity, TrendingPeriod } from './services/trendingService'
import type { CommunityRow, EventView } from './types/database'
import type { NavigateFunction } from './pages/OrganiserApp'
import { downloadEventCalendar, publicEventUrl } from './services/eventSharing'
import { ReportContentAction } from './components/ReportContentAction'
import { NotificationBell } from './components/NotificationBell'

const OrganiserApp = lazy(() => import('./pages/OrganiserApp').then(module => ({ default: module.OrganiserApp })))
const MyTicketsApp = lazy(() => import('./pages/MyTicketsApp').then(module => ({ default: module.MyTicketsApp })))
const PaymentReturnApp = lazy(() => import('./pages/PaymentReturnApp').then(module => ({ default: module.PaymentReturnApp })))
const AccountProfileSettings = lazy(() => import('./pages/AccountProfileSettings').then(module => ({ default: module.AccountProfileSettings })))
const SavedEventsApp = lazy(() => import('./pages/SavedEventsApp').then(module => ({ default: module.SavedEventsApp })))
const PublicEventPage = lazy(() => import('./pages/PublicEventPage').then(module => ({ default: module.PublicEventPage })))
const PersonalActivityDashboard = lazy(() => import('./pages/PersonalActivityDashboard').then(module => ({ default: module.PersonalActivityDashboard })))
const PrivacyCentre = lazy(() => import('./pages/PrivacyCentre').then(module => ({ default: module.PrivacyCentre })))
const ModerationDashboard = lazy(() => import('./pages/ModerationDashboard').then(module => ({ default: module.ModerationDashboard })))
const CommunityInformationPage = lazy(() => import('./pages/CommunityInformationPage').then(module => ({ default: module.CommunityInformationPage })))
const NotificationsApp = lazy(() => import('./pages/NotificationsApp').then(module => ({ default: module.NotificationsApp })))
const AiDiscoveryPage = lazy(() => import('./pages/AiDiscoveryPage').then(module => ({ default: module.AiDiscoveryPage })))

const categories = ['All', 'Technology', 'Music', 'Business', 'Art & Culture', 'Sports', 'Gaming', 'Education', 'Adventure', 'Social']
const categoryImages: Record<string, string> = {
  Technology: 'photo-1519389950473-47ba0277781c', Music: 'photo-1514525253161-7a46d19cd819',
  Business: 'photo-1521737711867-e3b97375f902', 'Art & Culture': 'photo-1531058020387-3be344556be6',
  Sports: 'photo-1461896836934-ffe607ba8211', Gaming: 'photo-1542751371-adc38448a05e',
  Education: 'photo-1523580494863-6f3031224c94', Adventure: 'photo-1464822759023-fed622ff2c3b',
  Social: 'photo-1511632765486-a01980e01a18',
}
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

function EventGrid({ events, saved, onOpen, onToggleSaved }: {
  events: EventView[]
  saved: string[]
  onOpen: (event: EventView) => void
  onToggleSaved: (event: EventView) => void
}) {
  return <div className="event-grid">{events.map((event, index) => <article className="event-card" key={event.id}>
    <button className="event-image" onClick={() => onOpen(event)} aria-label={`View ${event.title} details`}><img src={event.image} alt="" loading="lazy" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/><span className="event-tag">{event.tag}</span><span className="image-number">{String(index + 1).padStart(2, '0')}</span></button>
    <button className={saved.includes(event.id) ? 'save-button saved' : 'save-button'} onClick={() => onToggleSaved(event)} aria-label={saved.includes(event.id) ? 'Remove saved experience' : 'Save experience'} aria-pressed={saved.includes(event.id)}><Icon name="bookmark" size={17}/></button>
    <div className="event-info"><div className="event-category">{event.category}</div><button className="event-title" onClick={() => onOpen(event)}>{event.title}</button><div className="event-meta"><span><Icon name="calendar" size={14}/>{event.date}</span><span><Icon name="pin" size={14}/>{event.city}, {event.country}</span></div><div className="event-bottom"><span>{event.price}</span><button onClick={() => onOpen(event)}>Details <Icon name="arrow" size={14}/></button></div></div>
  </article>)}</div>
}

function CommunityGrid({ communities, memberships, ownerMemberships, onToggle, onOpen, anchorCards = false }: {
  communities: Pick<CommunityRow, 'id' | 'slug' | 'name' | 'description' | 'category' | 'member_count' | 'cover_image'>[] | TrendingCommunity[]
  memberships: string[]
  ownerMemberships: string[]
  onToggle: (communityId: string) => void
  onOpen: (slug: string) => void
  anchorCards?: boolean
}) {
  return <div className="community-grid">{communities.map(community => <article id={anchorCards ? `community-${community.id}` : undefined} tabIndex={anchorCards ? -1 : undefined} className="community-card" key={community.id}>
    <div className="community-avatar mint">{community.cover_image ? <img src={community.cover_image} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }}/> : community.name.charAt(0).toUpperCase()}<span aria-hidden="true">✳</span></div><span className="community-type">{community.category.toUpperCase()}</span><h3>{community.name}</h3><p>{community.description}</p>
    <div className="community-foot"><span><span className="member-dot"/> {formatCount(community.member_count)} members</span><button className="community-info-link" onClick={() => onOpen(community.slug)}>Community information</button><button disabled={ownerMemberships.includes(community.id)} className={memberships.includes(community.id) ? 'join-button joined' : 'join-button'} onClick={() => onToggle(community.id)}>{ownerMemberships.includes(community.id) ? 'Owner' : memberships.includes(community.id) ? <><Icon name="check" size={14}/> Joined</> : 'Join community'}</button><ReportContentAction target={{ type: 'community', id: community.id }}/></div>
  </article>)}</div>
}

type AuthMode = 'signin' | 'signup'
type ModalMode = 'host' | AuthMode | null

function HomePage({ navigate }: { navigate: NavigateFunction }) {
  const [filters, setFilters] = useState<DiscoveryFilters>(() => readDiscoveryFilters(window.location.search, categories.slice(1)))
  const { query, category, country, location, currency, dateFrom, dateTo, price, sort } = filters
  const updateFilter = (key: keyof DiscoveryFilters, value: DiscoveryFilters[keyof DiscoveryFilters]) => {
    if (key === 'query') {
      setCommunityResults([])
      setCommunityResultsError('')
      setCommunityResultsLoading(Boolean(normalizeSearchTerm(String(value))))
    }
    setFilters(current => {
      const next = { ...current, [key]: value } as DiscoveryFilters
      if (key === 'currency' && next.sort === 'price' && !/^[A-Z]{3}$/.test(next.currency)) next.sort = 'recommended'
      return next
    })
  }
  const clearAllFilters = () => setFilters(current => clearDiscoveryFilters(current))
  const [events, setEvents] = useState<EventView[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState('')
  const [eventReload, setEventReload] = useState(0)
  const [communities, setCommunities] = useState<CommunityRow[]>([])
  const [searchedCommunity, setSearchedCommunity] = useState<PublicCommunityCard | null>(null)
  const [memberships, setMemberships] = useState<string[]>([])
  const [ownerMemberships, setOwnerMemberships] = useState<string[]>([])
  const [communitiesLoading, setCommunitiesLoading] = useState(true)
  const [communitiesError, setCommunitiesError] = useState('')
  const [communityResults, setCommunityResults] = useState<CommunitySearchResult[]>([])
  const [communityResultsLoading, setCommunityResultsLoading] = useState(false)
  const [communityResultsError, setCommunityResultsError] = useState('')
  const [communitySearchReload, setCommunitySearchReload] = useState(0)
  const communityFocusIdRef = useRef('')
  const [recommendedEvents, setRecommendedEvents] = useState<EventView[]>([])
  const [nearbyEvents, setNearbyEvents] = useState<EventView[]>([])
  const [profileLocation, setProfileLocation] = useState<string | null>(null)
  const [nearbyError, setNearbyError] = useState('')
  const [recommendationLoading, setRecommendationLoading] = useState(true)
  const [recommendationError, setRecommendationError] = useState('')
  const [recommendationWarning, setRecommendationWarning] = useState(false)
  const [recommendationReload, setRecommendationReload] = useState(0)
  const [savedInterests, setSavedInterests] = useState<string[]>([])
  const [interestDraft, setInterestDraft] = useState<string[]>([])
  const [interestsSaving, setInterestsSaving] = useState(false)
  const [interestMessage, setInterestMessage] = useState('')
  const [interestError, setInterestError] = useState('')
  const [trendingPeriod, setTrendingPeriod] = useState<TrendingPeriod>('week')
  const [trendingReload, setTrendingReload] = useState(0)
  const [trendingEvents, setTrendingEvents] = useState<EventView[]>([])
  const [trendingCommunities, setTrendingCommunities] = useState<TrendingCommunity[]>([])
  const [trendingLoading, setTrendingLoading] = useState(true)
  const [trendingError, setTrendingError] = useState('')
  const [trendingCommunityError, setTrendingCommunityError] = useState('')
  const [nearbyVisible, setNearbyVisible] = useState(false)
  const [trendingVisible, setTrendingVisible] = useState(false)
  const [communitiesVisible, setCommunitiesVisible] = useState(false)
  const nearbyRef = useRef<HTMLElement | null>(null)
  const trendingRef = useRef<HTMLElement | null>(null)
  const communitiesRef = useRef<HTMLElement | null>(null)
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
  const toggleInterest = (interest: string) => setInterestDraft(current => current.includes(interest)
    ? current.filter(item => item !== interest)
    : normalizeInterestCategories([...current, interest], categories.slice(1)))
  const persistInterests = async () => {
    setInterestsSaving(true)
    setInterestError('')
    setInterestMessage('')
    const result = await saveRecommendationInterests(interestDraft, categories.slice(1))
    setInterestsSaving(false)
    if (result.error) {
      setInterestError('Your interests could not be saved. Please try again.')
      return
    }
    setSavedInterests(result.interests)
    setInterestDraft(result.interests)
    setInterestMessage('Your interests are saved.')
    setRecommendationReload(value => value + 1)
  }

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
    const targets = [
      { element: nearbyRef.current, reveal: () => setNearbyVisible(true) },
      { element: trendingRef.current, reveal: () => setTrendingVisible(true) },
      { element: communitiesRef.current, reveal: () => setCommunitiesVisible(true) },
    ].filter((item): item is { element: HTMLElement; reveal: () => void } => Boolean(item.element))
    if (typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => targets.forEach(item => item.reveal()), 0)
      return () => window.clearTimeout(timer)
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const target = targets.find(item => item.element === entry.target)
        target?.reveal()
        observer.unobserve(entry.target)
      }
    }, { rootMargin: '420px 0px' })
    targets.forEach(item => observer.observe(item.element))
    return () => observer.disconnect()
  }, [setCommunities, setCommunitiesError, setCommunitiesLoading, setMemberships, setOwnerMemberships])

  useEffect(() => {
    if (!nearbyVisible) return
    let active = true
    const timer = window.setTimeout(async () => {
      setRecommendationLoading(true)
      const result = await loadRecommendedEvents(categories.slice(1))
      if (!active) return
      setRecommendedEvents(result.events)
      setNearbyEvents(result.nearbyEvents)
      setProfileLocation(result.profileLocation)
      setNearbyError(result.nearbyError ?? '')
      setSavedInterests(result.interests)
      setInterestDraft(result.interests)
      setRecommendationError(result.error ?? '')
      setRecommendationWarning(result.activityWarning)
      setRecommendationLoading(false)
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [nearbyVisible, userId, recommendationReload])

  useEffect(() => {
    if (!trendingVisible) return
    let active = true
    const timer = window.setTimeout(async () => {
      setTrendingLoading(true)
      setTrendingError('')
      setTrendingCommunityError('')
      try {
        const [eventResult, communityResult] = await Promise.all([
          fetchTrendingEvents(trendingPeriod),
          trendingPeriod === 'all_time'
            ? Promise.resolve({ communities: [] as TrendingCommunity[], error: null })
            : fetchTrendingCommunities(trendingPeriod),
        ])
        if (!active) return
        setTrendingEvents(eventResult.events)
        setTrendingCommunities(communityResult.communities)
        setTrendingError(eventResult.error ? 'Trending experiences could not be loaded.' : '')
        setTrendingCommunityError(communityResult.error ? 'Popular communities could not be loaded.' : '')
      } catch {
        if (!active) return
        setTrendingError('Trending experiences could not be loaded.')
        setTrendingCommunityError('Popular communities could not be loaded.')
        setTrendingEvents([])
        setTrendingCommunities([])
      } finally {
        if (active) setTrendingLoading(false)
      }
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [trendingPeriod, trendingReload, trendingVisible])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setEventsLoading(true)
      setEventsError('')
      const result = await fetchEvents({ query, category, country, location, currency, dateFrom, dateTo, price, sort }, controller.signal)
      if (!active) return
      setEvents(result.events)
      setEventsError(result.error ? result.error.message : '')
      setEventsLoading(false)
    }, 280)
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [query, category, country, location, currency, dateFrom, dateTo, price, sort, eventReload])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href)
      const nextSearch = writeDiscoveryFilters(url.search, filters)
      const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`
      if (`${url.pathname}${url.search}${url.hash}` !== nextUrl) window.history.pushState({ ...window.history.state, discovery: true }, '', nextUrl)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [filters])

  useEffect(() => {
    const restoreDiscoveryState = () => {
      const restored = readDiscoveryFilters(window.location.search, categories.slice(1))
      setCommunityResults([])
      setCommunityResultsError('')
      setCommunityResultsLoading(Boolean(normalizeSearchTerm(restored.query)))
      setFilters(restored)
    }
    window.addEventListener('popstate', restoreDiscoveryState)
    return () => window.removeEventListener('popstate', restoreDiscoveryState)
  }, [])

  useEffect(() => {
    const term = normalizeSearchTerm(query)
    if (!term) return
    let active = true
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setCommunityResultsLoading(true)
      setCommunityResultsError('')
      try {
        const result = await searchCommunities(term, controller.signal)
        if (!active) return
        setCommunityResults(result.communities)
        setCommunityResultsError(result.error?.message ?? '')
      } catch {
        if (!active) return
        setCommunityResults([])
        setCommunityResultsError('Community search is temporarily unavailable.')
      } finally {
        if (active) setCommunityResultsLoading(false)
      }
    }, 320)
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [query, communitySearchReload])

  const reloadCommunities = useCallback(async () => {
    setCommunitiesLoading(true)
    const result = await fetchCommunities()
    setCommunities(result.communities)
    setMemberships(result.memberships)
    setOwnerMemberships(result.ownerMemberships)
    setCommunitiesError(result.error?.message ?? '')
    setCommunitiesLoading(false)
  }, [setCommunities, setCommunitiesError, setCommunitiesLoading, setMemberships, setOwnerMemberships])
  const displayedCommunities = useMemo(() => searchedCommunity && !communities.some(item => item.id === searchedCommunity.id)
    ? [searchedCommunity, ...communities]
    : communities, [communities, searchedCommunity])
  useEffect(() => {
    if (!communitiesVisible) return
    const timer = window.setTimeout(() => { void reloadCommunities() }, 0)
    return () => window.clearTimeout(timer)
  }, [communitiesVisible, reloadCommunities, userId])

  useEffect(() => {
    if (!communityFocusIdRef.current || communitiesLoading) return
    const card = document.getElementById(`community-${communityFocusIdRef.current}`)
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.focus({ preventScroll: true })
    }
    communityFocusIdRef.current = ''
  }, [communities, communitiesLoading, searchedCommunity])

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
  const hasGlobalSearch = Boolean(normalizeSearchTerm(query))
  const doSearch = () => { document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }

  const revealCommunity = (communityId: string) => {
    const card = document.getElementById(`community-${communityId}`)
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.focus({ preventScroll: true })
      return
    }
    communityFocusIdRef.current = communityId
    if (!communitiesVisible) setCommunitiesVisible(true)
    void fetchCommunityCard(communityId).then(result => {
      if (result.error || !result.community) {
        communityFocusIdRef.current = ''
        showNotice('That community is no longer available.')
        return
      }
      setSearchedCommunity(result.community)
      if (result.role && !memberships.includes(communityId)) setMemberships(current => [...current, communityId])
      if (result.role === 'owner' && !ownerMemberships.includes(communityId)) setOwnerMemberships(current => [...current, communityId])
    }).catch(() => {
      communityFocusIdRef.current = ''
      showNotice('That community could not be loaded. Please try again.')
    })
  }

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

  const copyEventLink = async (event: EventView) => {
    const url = publicEventUrl(event.slug, window.location.origin)
    try {
      await navigator.clipboard.writeText(url)
      showNotice('Public event link copied.')
    } catch {
      const field = document.createElement('textarea')
      field.value = url
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.append(field)
      field.select()
      const copied = document.execCommand('copy')
      field.remove()
      showNotice(copied ? 'Public event link copied.' : 'Could not copy the event link. Open the event page and copy its address.')
    }
  }

  const addEventToCalendar = (event: EventView) => {
    try { downloadEventCalendar(event, window.location.origin); showNotice('Calendar file downloaded.') }
    catch (calendarError) { showNotice(calendarError instanceof Error ? calendarError.message : 'Calendar file could not be created.') }
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

  const toggleMembership = async (community: Pick<CommunityRow, 'id' | 'name' | 'member_count'>) => {
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
    setTrendingCommunities(current => current.map(item => item.id === community.id ? { ...item, member_count: Math.max(0, item.member_count + (isMember ? -1 : 1)) } : item))
    setSearchedCommunity(current => current?.id === community.id ? { ...current, member_count: Math.max(0, current.member_count + (isMember ? -1 : 1)) } : current)
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
      <nav className={menuOpen ? 'main-nav open' : 'main-nav'} aria-label="Main navigation"><a href="#discover" onClick={() => setMenuOpen(false)}>Discover</a><a href="/discover/assistant" onClick={event => { event.preventDefault(); setMenuOpen(false); navigate('/discover/assistant') }}>Ask NODARA</a><a href="#trending-now" onClick={() => setMenuOpen(false)}>Explore</a><a href="#communities" onClick={() => setMenuOpen(false)}>Communities</a><a href="#host" onClick={() => setMenuOpen(false)}>Experiences</a>{user && <><a href="/account/activity" onClick={event => { event.preventDefault(); setMenuOpen(false); navigate('/account/activity') }}>My activity</a><a href="/account/privacy" onClick={event => { event.preventDefault(); setMenuOpen(false); navigate('/account/privacy') }}>Privacy centre</a><a href="/notifications" onClick={event => { event.preventDefault(); setMenuOpen(false); navigate('/notifications') }}>Notifications</a></>}</nav>
    <div className="nav-actions"><a className="nav-search" href="#search" aria-label="Search"><Icon name="search"/></a><a className="create-link" href="#communities">Community</a>{user && <><NotificationBell userId={user.id} onOpen={() => navigate('/notifications')}/><a className="create-link" href="/account/profile" onClick={event => { event.preventDefault(); navigate('/account/profile') }}>Profile settings</a><a className="create-link" href="/account/activity" onClick={event => { event.preventDefault(); navigate('/account/activity') }}>My activity</a><a className="create-link" href="/account/privacy" onClick={event => { event.preventDefault(); navigate('/account/privacy') }}>Privacy</a><a className="create-link" href="/saved-events" onClick={event => { event.preventDefault(); navigate('/saved-events') }}>Saved events</a><a className="create-link" href="/my-tickets" onClick={event => { event.preventDefault(); navigate('/my-tickets') }}>My tickets</a></>}<a className="create-link" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}><Icon name="plus" size={16}/> Create</a>{user ? <><span className="user-indicator"><Icon name="user" size={15}/>{user.user_metadata.full_name || user.email}</span><button className="signin" onClick={() => void handleSignOut()}>Sign out</button></> : <button className="signin" onClick={() => openAuth('signin')}>Sign in</button>}<button className="button button-small" onClick={() => user ? navigate('/organiser/dashboard') : openAuth('signup')}>{user ? 'Organiser' : 'Sign up'} <Icon name="arrow" size={15}/></button></div>
      <button className="mobile-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close menu' : 'Open menu'}><Icon name={menuOpen ? 'close' : 'menu'} size={23}/></button>
    </header>
    {supabaseConfigError && <div className="config-banner" role="status">{supabaseConfigError}</div>}
    <main id="home">
      <section className="hero section-wrap"><div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> YOUR WORLD, OPENED UP</div><h1>There's more to<br/><span>experience.</span></h1><p className="hero-tagline">Discover. Connect. Experience.</p><p className="hero-subtitle">Discover events, communities and real-world experiences happening around the world. Find your people and make room for something new.</p><div className="hero-actions"><a className="button" href="#discover">Explore experiences <Icon name="arrow" size={16}/></a><a className="text-link" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}>Host an event <Icon name="arrow" size={15}/></a></div><div className="hero-proof"><span className="hero-proof-mark" aria-hidden="true">✳</span><p><strong>Experiences for curious people.</strong><br/>Browse real listings, at your own pace.</p></div></div>
        <div className="hero-art" aria-label="A collage of people at real-world experiences"><div className="hero-photo hero-photo-main"><img src={photo('photo-1523580494863-6f3031224c94', 1100)} alt="People gathered at a vibrant live event" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/><span className="photo-caption"><b>01 / 04</b> MOMENTS THAT MOVE YOU</span></div><div className="hero-photo hero-photo-top"><img src={photo('photo-1514525253161-7a46d19cd819', 500)} alt="Crowd enjoying a live music performance" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/></div><div className="hero-photo hero-photo-bottom"><img src={photo('photo-1521737711867-e3b97375f902', 500)} alt="Creative team collaborating in a workshop" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/></div><div className="floating-note"><span className="note-icon"><Icon name="pin" size={16}/></span><span><b>Something is happening</b><small>Experiences around the world</small></span><span className="note-arrow"><Icon name="arrow" size={15}/></span></div><span className="art-index">N° 001 — GLOBAL DISCOVERY</span></div>
        <section className="search-area hero-search" id="search"><div className="search-intro"><span className="tiny-label">FIND YOUR NEXT THING</span><span className="search-side-note">Search published experiences and communities.</span></div><div className="search-panel"><label className="search-field"><span className="search-icon"><Icon name="search"/></span><span className="field-copy"><small>I'm looking for</small><input value={query} onChange={e => updateFilter('query', e.target.value)} onKeyDown={event => { if (event.key === 'Enter') doSearch() }} placeholder="What do you want to experience?" aria-label="Search experiences and communities"/></span>{query && <button type="button" className="search-clear" onClick={() => updateFilter('query', '')} aria-label="Clear search">Clear</button>}</label><button className="search-submit" onClick={doSearch} aria-label="Search experiences"><Icon name="search" size={20}/><span>Search</span></button></div></section>
      </section>
      <section className="discover section-wrap" id="discover"><div className="section-heading"><div><span className="tiny-label">CURATED FOR THE CURIOUS</span><h2>Discover what's happening<span className="green-dot">.</span></h2><p>Experiences worth making time for.</p></div><a className="view-all" href="#discover">View all experiences <Icon name="arrow" size={16}/></a></div>
        <div className="advanced-filter-panel" aria-label="Event filters">
          <div className="filter-panel-heading"><div><span className="tiny-label">REFINE DISCOVERY</span><p>Combine filters to find the right experience.</p></div><label className="sort-control"><span>Sort by</span><select value={sort} onChange={event => updateFilter('sort', event.target.value)} aria-label="Sort events"><option value="recommended">Recommended</option><option value="upcoming">Upcoming</option><option value="recent">Recently added</option><option value="alphabetical">Alphabetical</option><option value="price" disabled={!/^[A-Z]{3}$/.test(currency)}>Price: low to high (choose currency)</option></select></label></div>
          <div className="filter-fields"><label><span>Country</span><input value={country} onChange={event => updateFilter('country', event.target.value)} placeholder="Any country" autoComplete="country-name"/></label><label><span>City or location</span><input id="city-filter" value={location} onChange={event => updateFilter('location', event.target.value)} placeholder="Any city" autoComplete="address-level2"/></label><label><span>From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={event => updateFilter('dateFrom', event.target.value)} aria-label="Start date"/></label><label><span>To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={event => updateFilter('dateTo', event.target.value)} aria-label="End date"/></label><label><span>Admission</span><select value={price} onChange={event => updateFilter('price', event.target.value)} aria-label="Filter by admission price"><option value="all">Free and paid</option><option value="free">Free</option><option value="paid">Paid</option></select></label><label><span>Currency (for price sort)</span><input value={currency} onChange={event => updateFilter('currency', event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} placeholder="Any currency" maxLength={3} aria-label="Currency code"/></label></div>
          <div className="filter-footer"><span>Showing published events · Up to 48 results{sort === 'price' ? ` · Sorted in ${currency}` : ''}</span>{(query || category !== 'All' || country || location || currency || dateFrom || dateTo || price !== 'all' || sort !== 'recommended') && <button className="clear-filters" onClick={clearAllFilters}>Clear all</button>}</div>
        </div>
        <div className="active-filter-list" aria-live="polite">{[
          ...(query ? [{ label: `Search: ${query}`, key: 'query' as const }] : []),
          ...(category !== 'All' ? [{ label: category, key: 'category' as const }] : []),
          ...(country ? [{ label: `Country: ${country}`, key: 'country' as const }] : []),
          ...(location ? [{ label: `City: ${location}`, key: 'location' as const }] : []),
          ...(currency ? [{ label: `Currency: ${currency}`, key: 'currency' as const }] : []),
          ...(dateFrom ? [{ label: `From ${dateFrom}`, key: 'dateFrom' as const }] : []),
          ...(dateTo ? [{ label: `To ${dateTo}`, key: 'dateTo' as const }] : []),
          ...(price !== 'all' ? [{ label: price === 'free' ? 'Free events' : 'Paid events', key: 'price' as const }] : []),
          ...(sort !== 'recommended' ? [{ label: `Sorted: ${sort === 'recent' ? 'recently added' : sort}`, key: 'sort' as const }] : []),
        ].map(item => <button className="active-filter-chip" key={item.key} onClick={() => { if (item.key === 'currency' && sort === 'price') setFilters(current => ({ ...current, currency: '', sort: 'recommended' })); else updateFilter(item.key, item.key === 'category' ? 'All' : item.key === 'price' ? 'all' : item.key === 'sort' ? 'recommended' : '') }} aria-label={`Remove ${item.label} filter`}>{item.label}<span aria-hidden="true">×</span></button>)}</div>
        <div className="category-row" role="group" aria-label="Filter experiences by category">{categories.map(item => <button key={item} className={category === item ? 'category-chip active' : 'category-chip'} onClick={() => updateFilter('category', item)}>{item}</button>)}</div>
        <div className="results-label"><span>{eventsLoading ? 'FINDING EXPERIENCES…' : `${filtered.length} EXPERIENCES TO EXPLORE`}</span><span>LIVE LISTINGS · PUBLISHED EVENTS</span></div>
        {eventsError && !supabaseConfigError && <div className="inline-error" role="alert">We couldn’t load experiences right now. Check your connection and try again. <button onClick={() => setEventReload(value => value + 1)}>Retry</button></div>}
        {hasGlobalSearch ? <div className="global-search-results" aria-live="polite">
          <section className="global-result-group"><div className="global-result-heading"><span className="tiny-label">EXPERIENCES</span><span>{eventsLoading ? 'Searching…' : `${filtered.length} found`}</span></div>{eventsLoading ? <div className="loading-state compact"><span className="loading-spinner"/>Searching experiences…</div> : eventsError ? <div className="global-result-message" role="alert">Experiences could not be loaded. <button onClick={() => setEventReload(value => value + 1)}>Retry</button></div> : filtered.length ? <div className="global-result-list">{filtered.slice(0, 8).map(event => <button className="global-result-item" key={event.id} onClick={() => void openEvent(event)}><img src={event.image} alt="" loading="lazy" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/><span className="global-result-copy"><strong>{event.title}</strong><small>{event.category} · {event.city}, {event.country}</small><small>{event.date}</small></span><Icon name="arrow" size={16}/></button>)}</div> : <p className="global-result-message">No published experiences match this search.</p>}</section>
          <section className="global-result-group"><div className="global-result-heading"><span className="tiny-label">COMMUNITIES</span><span>{communityResultsLoading ? 'Searching…' : `${communityResults.length} found`}</span></div>{communityResultsLoading ? <div className="loading-state compact"><span className="loading-spinner"/>Searching communities…</div> : communityResultsError ? <div className="global-result-message" role="alert">Communities could not be searched. <button onClick={() => setCommunitySearchReload(value => value + 1)}>Retry</button></div> : communityResults.length ? <div className="global-result-list">{communityResults.map(community => <button className="global-result-item" key={community.id} onClick={() => revealCommunity(community.id)}><span className="global-result-avatar" aria-hidden="true">{community.name.charAt(0).toUpperCase()}</span>{community.cover_image && <img src={community.cover_image} alt="" loading="lazy" onError={image => { image.currentTarget.hidden = true }}/>}<span className="global-result-copy"><strong>{community.name}</strong><small>{community.category}{community.location ? ` · ${community.location}` : ''}</small><small>{community.description}</small></span><Icon name="arrow" size={16}/></button>)}</div> : <p className="global-result-message">No communities match this search.</p>}</section>
        </div> : eventsLoading ? <div className="loading-state" aria-live="polite"><span className="loading-spinner"/>Loading experiences…</div> : filtered.length ? <EventGrid events={filtered} saved={saved} onOpen={event => void openEvent(event)} onToggleSaved={event => void toggleSaved(event)}/> : <div className="empty-state"><span className="empty-icon"><Icon name="search" size={22}/></span><h3>{eventsError ? 'Experiences are unavailable' : 'No experiences found'}</h3><p>{eventsError ? 'Please try again in a moment.' : 'There are no published experiences matching these filters yet. Check back soon.'}</p>{!eventsError && <button className="button button-outline" onClick={clearAllFilters}>Clear all filters</button>}</div>}
      </section>
      <section className="category-exploration section-wrap" aria-labelledby="category-heading"><div className="section-heading"><div><span className="tiny-label">START WITH WHAT YOU LOVE</span><h2 id="category-heading">Explore categories<span className="green-dot">.</span></h2><p>Choose a theme to filter the live event listings.</p></div><button className="view-all category-reset" onClick={() => updateFilter('category', 'All')}>All experiences <Icon name="arrow" size={16}/></button></div><div className="category-explore-grid">{categories.slice(1).map((item, index) => <button type="button" key={item} className={category === item ? 'category-explore-card active' : 'category-explore-card'} aria-pressed={category === item} onClick={() => { updateFilter('category', item); document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }}><img src={photo(categoryImages[item], 520)} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }}/><span className="category-explore-shade"/><small>{String(index + 1).padStart(2, '0')} / CATEGORY</small><strong>{item}</strong><span className="category-explore-arrow"><Icon name="arrow" size={16}/></span></button>)}</div></section>
      <section className="nearby-section section-wrap" ref={nearbyRef} aria-labelledby="nearby-heading"><div className="section-heading"><div><span className="tiny-label">GOOD THINGS, CLOSER</span><h2 id="nearby-heading">Upcoming near you<span className="green-dot">.</span></h2><p>{profileLocation ? `Upcoming published experiences matching ${profileLocation}.` : 'Browse upcoming experiences by city or country, without sharing precise location.'}</p></div>{user && <button className="view-all" onClick={() => { document.querySelector('#city-filter')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector<HTMLInputElement>('#city-filter')?.focus() }}>{profileLocation ? 'Change location' : 'Browse by location'} <Icon name="arrow" size={16}/></button>}</div>
        {recommendationLoading ? <div className="loading-state nearby-loading" aria-live="polite"><span className="loading-spinner"/>Finding nearby experiences…</div> : nearbyError ? <div className="inline-error" role="alert">Nearby experiences could not be loaded. <button onClick={() => setRecommendationReload(value => value + 1)}>Retry</button></div> : nearbyEvents.length ? <EventGrid events={nearbyEvents} saved={saved} onOpen={event => void openEvent(event)} onToggleSaved={event => void toggleSaved(event)}/> : <div className="nearby-empty"><p>{profileLocation ? 'No upcoming published experiences match your profile location yet.' : user ? 'Add a city and country to your profile to see nearby experiences, or browse by location.' : 'Add a location in discovery filters to find experiences near you. Sign in to use a saved profile location.'}</p><button className="button button-outline" onClick={() => { document.querySelector('#city-filter')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector<HTMLInputElement>('#city-filter')?.focus() }}>Browse by location <Icon name="pin" size={15}/></button></div>}
      </section>
      <section className="recommendation-section section-wrap" id="recommended"><div className="section-heading"><div><span className="tiny-label">A BETTER WAY TO FIND YOUR NEXT THING</span><h2>{user ? 'Recommended for you' : 'A few upcoming picks'}<span className="green-dot">.</span></h2><p>{user ? 'Recommendations use your interests and your own activity.' : 'Useful upcoming picks for guests. Sign in to personalize them.'}</p></div>{user && <a className="view-all" href="#recommended-preferences">Manage your interests <Icon name="arrow" size={16}/></a>}</div>
        <div className="recommendation-preferences" id="recommended-preferences">{user ? <><div><strong>Your interests</strong><p>Select categories to personalize future recommendations.</p></div><div className="interest-options" role="group" aria-label="Choose event interests">{categories.slice(1).map(interest => <button type="button" key={interest} className={interestDraft.includes(interest) ? 'interest-chip selected' : 'interest-chip'} onClick={() => toggleInterest(interest)} aria-pressed={interestDraft.includes(interest)}>{interest}</button>)}</div><div className="interest-save-row">{interestError && <span className="auth-error" role="alert">{interestError}</span>}{interestMessage && <span className="auth-success" role="status">{interestMessage}</span>}<button className="button button-small" onClick={() => void persistInterests()} disabled={interestsSaving || JSON.stringify(interestDraft) === JSON.stringify(savedInterests)}>{interestsSaving ? 'Saving…' : 'Save interests'}</button></div></> : <><span>Choose categories and sync them across sessions.</span><button className="button button-small" onClick={() => openAuth('signup')}>Create an account to personalize <Icon name="arrow" size={14}/></button></>}</div>
        {recommendationWarning && <p className="recommendation-note" role="status">Some activity signals could not be loaded. Recommendations are based on the information available.</p>}
        <p className="recommendation-method">Ranking: selected interests (+8), attended categories (+6), saved-event categories (+5), confirmed-booking categories (+4), matching profile location (+2), and a small boost for recently added events. Ties favor earlier events. No popularity or AI claims.</p>
        {recommendationLoading ? <div className="loading-state recommendation-loading" aria-live="polite"><span className="loading-spinner"/>Finding relevant experiences…</div> : recommendationError ? <div className="inline-error" role="alert">Recommendations are temporarily unavailable. <button onClick={() => setRecommendationReload(value => value + 1)}>Retry</button></div> : recommendedEvents.length ? <EventGrid events={recommendedEvents} saved={saved} onOpen={event => void openEvent(event)} onToggleSaved={event => void toggleSaved(event)}/> : <div className="empty-state recommendation-empty"><span className="empty-icon"><Icon name="search" size={22}/></span><h3>No recommendations yet</h3><p>There are no upcoming published events available to recommend right now. Check back as new experiences are added.</p></div>}
      </section>
      <section className="trending-now-section section-wrap" id="trending-now" ref={trendingRef}><div className="section-heading"><div><span className="tiny-label">REAL ATTENTION, RECENTLY</span><h2>Trending now<span className="green-dot">.</span></h2><p>Ranked from recorded saves, confirmed bookings, check-ins, and recent community joins.</p></div><div className="trending-periods" role="group" aria-label="Trending period">{([{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all_time', label: 'All-time popular' }] as const).map(item => <button key={item.value} className={trendingPeriod === item.value ? 'trending-period active' : 'trending-period'} aria-pressed={trendingPeriod === item.value} onClick={() => setTrendingPeriod(item.value)}>{item.label}</button>)}</div></div>
        {trendingLoading ? <div className="loading-state trending-loading" aria-live="polite"><span className="loading-spinner"/>Calculating genuine activity…</div> : <>
          {trendingError && <div className="inline-error" role="alert">{trendingError} <button onClick={() => setTrendingReload(value => value + 1)}>Retry</button></div>}
          {!trendingError && trendingEvents.length ? <section className="trending-now-group"><div className="trending-subheading"><h3>Experiences gaining attention</h3><span>UPCOMING · PUBLISHED</span></div><EventGrid events={trendingEvents} saved={saved} onOpen={event => void openEvent(event)} onToggleSaved={event => void toggleSaved(event)}/></section> : !trendingError && <div className="empty-state trending-empty"><h3>No trending experiences yet</h3><p>There isn’t enough recent engagement to rank published upcoming events yet. Rankings appear as genuine activity is recorded.</p></div>}
          {trendingPeriod === 'all_time' ? <div className="trending-unavailable-note">All-time community popularity isn’t available because departed memberships aren’t retained as history.</div> : trendingCommunityError ? <div className="inline-error" role="alert">{trendingCommunityError}</div> : trendingCommunities.length ? <section className="trending-now-group"><div className="trending-subheading"><h3>Communities with recent joins</h3><span>ACTIVE MEMBERS ONLY · CURRENT TOTALS</span></div><CommunityGrid communities={trendingCommunities} memberships={memberships} ownerMemberships={ownerMemberships} onOpen={slug => navigate(`/communities/${encodeURIComponent(slug)}`)} onToggle={communityId => { const community = communities.find(item => item.id === communityId) ?? trendingCommunities.find(item => item.id === communityId); if (community) void toggleMembership(community) }}/></section> : <div className="trending-unavailable-note">No recent active community joins to rank in this period.</div>}
          <p className="trending-method">Activity windows are rolling 7- and 30-day periods. Each user counts at most once per event and signal type. All-time event ranking uses retained confirmed bookings and check-ins; historical saves are not retained.</p>
        </>}
      </section>
      <section className="trending section-wrap" id="trending"><div className="section-heading"><div><span className="tiny-label">OUT THERE, RIGHT NOW</span><h2>Explore by city<span className="green-dot">.</span></h2><p>Discover experiences in cities near and far.</p></div><div className="trend-controls"><span>01 — 05</span><span className="control-line"/><span>WORLDWIDE</span></div></div><div className="city-grid">{cities.map(city => <button className="city-card" key={city.name} onClick={() => { setFilters(current => ({ ...current, location: city.name, country: city.country, category: 'All' })); document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }}><img src={photo(city.image, 650)} alt={`${city.name} city`} loading="lazy" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/><span className="city-shade"/><span className="city-number">{city.n} / CITY</span><span className="city-copy"><small>{city.country}</small><strong>{city.name}</strong><span>Browse experiences <Icon name="arrow" size={14}/></span></span></button>)}</div></section>
      <section className="community-section" id="communities" ref={communitiesRef}><div className="section-wrap community-inner"><div className="community-heading"><div><span className="tiny-label">BETTER, TOGETHER</span><h2>Find your people<span className="green-dot">.</span></h2><p>Discover communities built around the things you love.</p></div><a href="#communities" className="view-all">Explore communities <Icon name="arrow" size={16}/></a></div>{communitiesLoading ? <div className="loading-state community-loading"><span className="loading-spinner"/>Loading communities…</div> : displayedCommunities.length ? <CommunityGrid communities={displayedCommunities} memberships={memberships} ownerMemberships={ownerMemberships} anchorCards onOpen={slug => navigate(`/communities/${encodeURIComponent(slug)}`)} onToggle={communityId => { const community = displayedCommunities.find(item => item.id === communityId); if (community) void toggleMembership(community) }}/> : <div className="empty-community"><span>{communitiesError ? 'Communities are temporarily unavailable.' : 'New communities are taking shape.'}</span>{communitiesError && <button onClick={() => void reloadCommunities()}>Retry</button>}</div>}<div className="demo-note"><span/> Membership is linked to your account. Sign in to join or leave a community.</div></div></section>
      <section className="host-wrap section-wrap" id="host"><div className="host-panel"><div className="host-orbit orbit-one"/><div className="host-orbit orbit-two"/><div className="host-copy"><span className="tiny-label">FOR THE PEOPLE WHO BRING US TOGETHER</span><h2>Have something<br/>worth sharing<span className="green-dot">?</span></h2><p>Bring people together. Create experiences. Build your community.</p><a className="button" href="/organiser/events/new" onClick={event => { event.preventDefault(); navigate('/organiser/events/new') }}>Start hosting <Icon name="arrow" size={16}/></a></div><div className="host-aside"><span className="host-star">✳</span><span className="host-aside-label">THE WORLD IS<br/>YOUR AUDIENCE.</span><span className="host-aside-count">NODARA / 001</span></div></div></section>
    </main>
    <footer className="footer"><div className="section-wrap"><div className="footer-main"><div className="footer-brand-col"><a className="brand" href="#home"><span className="brand-mark"><i/><i/><i/></span><span>NODARA</span></a><p>Discover. Connect. Experience.</p><span className="footer-manifesto">A world more connected<br/>to what makes us feel alive.</span></div><div className="footer-links"><div><h4>PRODUCT</h4><a href="#discover">Discover</a><a href="#trending">Explore</a><a href="#communities">Communities</a><a href="#discover">Experiences</a></div><div><h4>COMPANY</h4><a href="#home">About</a><a href="mailto:hello@nodara.example">Contact</a><a href="mailto:careers@nodara.example">Careers</a></div><div><h4>RESOURCES</h4><a href="mailto:help@nodara.example">Help centre</a><a href="#host">Organiser guide</a><a href="#footer-legal">Privacy</a><a href="#footer-legal">Terms</a></div><div><h4>FOLLOW THE FEELING</h4><a href="https://x.com" target="_blank" rel="noreferrer">X <span>↗</span></a><a href="https://instagram.com" target="_blank" rel="noreferrer">Instagram <span>↗</span></a><a href="https://linkedin.com" target="_blank" rel="noreferrer">LinkedIn <span>↗</span></a></div></div></div><div className="footer-bottom" id="footer-legal"><span>© 2026 NODARA. MADE FOR THE MOMENTS THAT MATTER.</span><span>BUILT FOR EVERYWHERE <i>✳</i></span></div></div></footer>
    {notice && <div className="toast" role="status">{notice}</div>}
    {(selected || modal) && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) { setSelected(null); setModal(null) } }}><div className="modal" role="dialog" aria-modal="true" aria-label={selected ? 'Experience details' : modal === 'host' ? 'Start hosting' : modal === 'signup' ? 'Create your account' : 'Sign in'}><button className="modal-close" onClick={() => { setSelected(null); setModal(null); setAuthError('') }} aria-label="Close"><Icon name="close"/></button>{selected ? <><img className="modal-image" src={selected.image} alt="" onError={image => { image.currentTarget.onerror = null; image.currentTarget.src = '/event-fallback.svg' }}/><div className="modal-content"><span className="tiny-label">{selected.category} · PUBLISHED LISTING</span><h2>{selected.title}</h2>{selected.shortDescription && <p>{selected.shortDescription}</p>}<p>{selected.date} · {selected.city}, {selected.country}{selected.address ? ` · ${selected.address}` : ''}</p>{detailLoading ? <p>Refreshing experience details…</p> : <p>{selected.description}</p>}<div className="event-share-actions"><button onClick={() => void copyEventLink(selected)}>Copy public event link</button><button onClick={() => addEventToCalendar(selected)}>Add to calendar</button><button onClick={() => navigate(`/events/${selected.slug}`)}>Open shareable event page</button></div><button className="button" onClick={() => void toggleSaved(selected)}><Icon name="bookmark" size={16}/>{saved.includes(selected.id) ? 'Saved' : 'Save experience'}</button>{bookingOutcome ? <div className="auth-success booking-result" role="status"><strong>{bookingOutcome.status === 'confirmed' ? 'Your tickets are confirmed.' : 'Payment is still pending.'}</strong><span>Booking reference: {bookingOutcome.booking_reference}</span><span>{bookingOutcome.status === 'confirmed' ? `${bookingOutcome.ticket_count} digital ticket${bookingOutcome.ticket_count === 1 ? '' : 's'} issued.` : 'No payment has been verified and no ticket has been issued.'}</span>{bookingOutcome.status === 'confirmed' ? <button className="button" onClick={() => { setSelected(null); navigate('/my-tickets') }}>View my tickets</button> : <><button className="button booking-button" onClick={() => void launchPaystackCheckout(bookingOutcome.booking_id)} disabled={bookingBusy}>{bookingBusy ? 'Opening secure checkout…' : 'Continue to secure checkout'} <Icon name="arrow" size={15}/></button><button className="signin" onClick={() => { setSelected(null); navigate('/my-tickets') }}>Check booking status in My Tickets</button></>}</div> : <><div className="ticket-picker"><strong>Select tickets</strong>{ticketTypes.length ? ticketTypes.map(type => <label className="ticket-choice" key={type.id}><span><b>{type.name}</b><small>{type.price === 0 ? 'Free' : new Intl.NumberFormat('en', { style: 'currency', currency: type.currency }).format(type.price)}{type.remaining !== null ? ` · ${type.remaining} remaining` : ''}</small>{type.description && <small>{type.description}</small>}</span><select aria-label={`Quantity for ${type.name}`} value={ticketQuantities[type.id] ?? 0} onChange={event => setTicketQuantities(current => ({ ...current, [type.id]: Number(event.target.value) }))}><option value={0}>0</option>{Array.from({ length: Math.min(type.max_per_booking, type.remaining ?? type.max_per_booking) }, (_, index) => index + 1).map(quantity => <option key={quantity} value={quantity}>{quantity}</option>)}</select></label>) : <small>{bookingError || (ticketTypesLoading ? 'Loading ticket availability…' : 'No tickets are currently available for this event.')}</small>}<div className="booking-total"><span>Estimated total</span><strong>{new Intl.NumberFormat('en', { style: 'currency', currency: ticketTypes[0]?.currency ?? selected.currency }).format(ticketTypes.reduce((sum, type) => sum + type.price * (ticketQuantities[type.id] ?? 0), 0))}</strong></div></div>{showBookingReview && <div className="booking-review"><strong>Review your booking</strong><span>{selectedTicketCount} ticket{selectedTicketCount === 1 ? '' : 's'} · {new Intl.NumberFormat('en', { style: 'currency', currency: ticketTypes[0]?.currency ?? selected.currency }).format(selectedBookingTotal)}</span><small>Free tickets are confirmed after booking. Paid orders remain pending until payment is independently verified.</small><button className="signin" onClick={() => setShowBookingReview(false)}>Change tickets</button></div>}{bookingError && <div className="auth-error" role="alert">{bookingError}</div>}<button className="button booking-button" onClick={() => { if (!user) { setModal('signin'); return }; if (!showBookingReview) { if (selectedTicketCount === 0) { setBookingError('Choose at least one ticket type.'); return }; setShowBookingReview(true); return }; void requestBooking() }} disabled={bookingBusy || !ticketTypes.length}>{bookingBusy ? 'Securing tickets…' : !user ? 'Sign in to book' : showBookingReview ? 'Confirm booking' : 'Review booking'} <Icon name="arrow" size={15}/></button><small className="pending-note">Free tickets are issued after booking. Paid orders stay pending until a payment is independently verified.</small></>}</div></> : modal === 'host' ? <div className="modal-content placeholder-content"><span className="tiny-label">NODARA FOR ORGANISERS</span><h2>Your next chapter starts here.</h2><p>Organiser tools are in development. Soon you’ll be able to create an experience, reach your community and bring people together.</p><span className="coming-soon">ORGANISER TOOLS · COMING SOON</span><button className="button button-outline" onClick={() => { setModal(null); document.querySelector('#discover')?.scrollIntoView({ behavior: 'smooth' }) }}>Explore experiences <Icon name="arrow" size={15}/></button></div> : <div className="modal-content auth-content"><span className="tiny-label">{modal === 'signup' ? 'YOUR WORLD, OPENED UP' : 'WELCOME BACK'}</span><h2>{modal === 'signup' ? 'Make room for more.' : 'Find your way in.'}</h2><p>{modal === 'signup' ? 'Create an account to save experiences and find your communities.' : 'Sign in to sync saved experiences and manage your memberships.'}</p><form onSubmit={event => void submitAuth(event)}>{modal === 'signup' && <label>Your name<input autoComplete="name" value={authName} onChange={event => setAuthName(event.target.value)} required maxLength={120} placeholder="Full name"/></label>}<label>Email address<input type="email" autoComplete="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} required placeholder="you@example.com"/></label><label>Password<input type="password" autoComplete={modal === 'signup' ? 'new-password' : 'current-password'} value={authPassword} onChange={event => setAuthPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters"/></label>{authError && <div className="auth-error" role="alert">{authError}</div>}{authMessage && <div className="auth-success" role="status">{authMessage}</div>}<button className="button auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : modal === 'signup' ? 'Create account' : 'Sign in'} <Icon name="arrow" size={15}/></button></form><div className="auth-switch">{modal === 'signup' ? 'Already have an account?' : 'New to NODARA?'} <button onClick={() => { setAuthError(''); setAuthMessage(''); setModal(modal === 'signup' ? 'signin' : 'signup') }}>{modal === 'signup' ? 'Sign in' : 'Create account'}</button></div><small className="pending-note">{modal === 'signup' ? 'We’ll email you a confirmation link before first sign-in.' : 'Your session is stored securely by Supabase Auth.'}</small></div>}</div></div>}
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

function LazyPageFallback() { return <div className="saved-loading" role="status" aria-live="polite">Loading NODARA…</div> }

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

  if (pathname.startsWith('/organiser')) return <Suspense fallback={<LazyPageFallback/>}><OrganiserApp pathname={pathname} navigate={navigate}/></Suspense>
  if (pathname === '/my-tickets') return <Suspense fallback={<LazyPageFallback/>}><MyTicketsApp navigate={navigate}/></Suspense>
  if (pathname === '/payment/return') return <Suspense fallback={<LazyPageFallback/>}><PaymentReturnApp navigate={navigate}/></Suspense>
  if (pathname === '/account/profile') return <Suspense fallback={<LazyPageFallback/>}><AccountProfileSettings navigate={navigate}/></Suspense>
  if (pathname === '/notifications') return <Suspense fallback={<LazyPageFallback/>}><NotificationsApp navigate={navigate}/></Suspense>
  if (pathname === '/account/privacy') return <Suspense fallback={<LazyPageFallback/>}><PrivacyCentre navigate={navigate}/></Suspense>
  if (pathname === '/moderation') return <Suspense fallback={<LazyPageFallback/>}><ModerationDashboard navigate={navigate}/></Suspense>
  if (pathname === '/saved-events') return <Suspense fallback={<LazyPageFallback/>}><SavedEventsApp navigate={navigate}/></Suspense>
  if (pathname === '/account/activity') return <Suspense fallback={<LazyPageFallback/>}><PersonalActivityDashboard navigate={navigate}/></Suspense>
  if (pathname === '/discover/assistant') return <Suspense fallback={<LazyPageFallback/>}><AiDiscoveryPage navigate={navigate}/></Suspense>
  if (pathname.startsWith('/events/')) return <Suspense fallback={<LazyPageFallback/>}><PublicEventPage slug={decodeURIComponent(pathname.slice('/events/'.length))} navigate={navigate}/></Suspense>
  const communityAnnouncementRoute = pathname.match(/^\/communities\/([^/]+)\/announcements\/([^/]+)$/)
  if (communityAnnouncementRoute) return <Suspense fallback={<LazyPageFallback/>}><CommunityInformationPage slug={decodeURIComponent(communityAnnouncementRoute[1])} announcementId={decodeURIComponent(communityAnnouncementRoute[2])} navigate={navigate}/></Suspense>
  const communityRoute = pathname.match(/^\/communities\/([^/]+)$/)
  if (communityRoute) return <Suspense fallback={<LazyPageFallback/>}><CommunityInformationPage slug={decodeURIComponent(communityRoute[1])} navigate={navigate}/></Suspense>
  return <HomePage navigate={navigate}/>
}

export default App
