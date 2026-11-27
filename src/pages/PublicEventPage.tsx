import { useEffect, useState } from 'react'
import './SavedEvents.css'
import { fetchPublishedEventBySlug } from '../services/eventService'
import { downloadEventCalendar, publicEventUrl } from '../services/eventSharing'
import type { EventView } from '../types/database'
import type { NavigateFunction } from './OrganiserApp'

export function PublicEventPage({ slug, navigate }: { slug: string; navigate: NavigateFunction }) {
  const [event, setEvent] = useState<EventView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    fetchPublishedEventBySlug(slug).then(result => {
      if (!active) return
      setEvent(result.event)
      setError(result.error?.message ?? '')
      setLoading(false)
    }).catch(() => {
      if (active) { setError('This event could not be loaded.'); setLoading(false) }
    })
    return () => { active = false }
  }, [slug])

  const eventUrl = () => publicEventUrl(slug, window.location.origin)
  const copyLink = async () => {
    const value = eventUrl()
    try {
      await navigator.clipboard.writeText(value)
      setNotice('Public event link copied.')
    } catch {
      const field = document.createElement('textarea')
      field.value = value; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0'
      document.body.append(field); field.select()
      const copied = document.execCommand('copy'); field.remove()
      setNotice(copied ? 'Public event link copied.' : 'Copy is unavailable in this browser. You can copy the page address from your browser.')
    }
  }
  const shareEvent = async () => {
    if (!event) return
    const url = eventUrl()
    if (!navigator.share) { await copyLink(); return }
    try { await navigator.share({ title: event.title, text: `${event.title} · ${event.city}, ${event.country}`, url }) }
    catch (shareError) { if (shareError instanceof Error && shareError.name !== 'AbortError') setNotice('The event could not be shared. You can copy its link instead.') }
  }
  const addCalendar = () => {
    if (!event) return
    try { downloadEventCalendar(event, window.location.origin); setNotice('Calendar file downloaded.') }
    catch (calendarError) { setNotice(calendarError instanceof Error ? calendarError.message : 'Calendar file could not be created.') }
  }

  return <main className="public-event-page">
    <header className="saved-header"><button className="saved-brand" onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><button className="saved-back" onClick={() => navigate('/')}>Browse events</button></header>
    {loading ? <div className="saved-loading" aria-live="polite">Loading published event…</div> : !event ? <section className="public-event-unavailable"><div><span className="saved-heading"><span>PUBLISHED EVENT</span></span><h1>Event unavailable</h1><p>{error || 'This event is no longer publicly available.'}</p><button className="saved-empty button" onClick={() => navigate('/')}>Return to event discovery</button></div></section> : <div className="public-event-content">
      <button className="public-event-back" onClick={() => navigate('/')}>← Event discovery</button>
      <article className="public-event-card"><img className="public-event-cover" src={event.coverImage ?? event.image} alt="" onError={image => { image.currentTarget.src = '/event-fallback.svg' }}/><div className="public-event-details">
        <span className="saved-event-category">{event.category} · PUBLIC EVENT</span><h1>{event.title}</h1><p className="public-event-meta">{new Date(event.startDate).toLocaleString()} · {event.city}, {event.country}{event.venue ? ` · ${event.venue}` : ''}</p><p>{event.shortDescription}</p><p>{event.description}</p><p>{event.price}{event.address ? ` · ${event.address}` : ''}</p>
        <div className="public-event-actions"><button onClick={() => void shareEvent()}>Share event</button><button onClick={() => void copyLink()}>Copy event link</button><button onClick={addCalendar}>Add to calendar</button></div>
        <small className="public-event-note">This page contains public event details only. It does not include bookings, tickets, or attendee information.</small>{notice && <div className="saved-message saved-success" role="status">{notice}</div>}
      </div></article>
    </div>}
  </main>
}
