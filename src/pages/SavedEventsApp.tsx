import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { NodaraLogo } from '../components/NodaraLogo'
import './SavedEvents.css'
import { supabase } from '../lib/supabase'
import {
  addSavedEventToCollection, createPersonalCollection, deletePersonalCollection,
  fetchOwnSavedExperiences, fetchPersonalCollections, removeEventFromCollection,
  removeOwnSavedEvent, renamePersonalCollection,
} from '../services/personalCollectionsService'
import type { PersonalEventCollection, SavedExperience } from '../services/personalCollectionsService'
import type { NavigateFunction } from './OrganiserApp'

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export function SavedEventsApp({ navigate }: { navigate: NavigateFunction }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [experiences, setExperiences] = useState<SavedExperience[]>([])
  const [collections, setCollections] = useState<PersonalEventCollection[]>([])
  const [collectionName, setCollectionName] = useState('')
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unavailableCount, setUnavailableCount] = useState(0)
  const [unavailableIds, setUnavailableIds] = useState<string[]>([])

  const reload = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    const { data, error: authError } = await supabase.auth.getUser()
    if (authError) { setError(errorText(authError)); setLoading(false); return }
    if (!data.user) { setUserId(null); setLoading(false); return }
    setUserId(data.user.id)
    const [savedResult, collectionResult] = await Promise.all([fetchOwnSavedExperiences(), fetchPersonalCollections()])
    setExperiences(savedResult.experiences)
    setUnavailableCount(savedResult.unavailableCount)
    setUnavailableIds(savedResult.unavailableIds)
    setCollections(collectionResult.collections)
    const firstCollection = collectionResult.collections[0]?.id ?? ''
    const collectionIds = new Set(collectionResult.collections.map(collection => collection.id))
    setSelection(current => Object.fromEntries(savedResult.experiences.map(item => [
      item.event.id,
      current[item.event.id] && collectionIds.has(current[item.event.id]) ? current[item.event.id] : firstCollection,
    ])))
    setError(savedResult.error ? errorText(savedResult.error) : collectionResult.error ? errorText(collectionResult.error) : '')
    setLoading(false)
  }, [])

  useEffect(() => {
    let active = true
    const initialize = async () => {
      const authResult = supabase
        ? await supabase.auth.getUser()
        : await Promise.resolve({ data: { user: null }, error: new Error('Supabase is not configured.') })
      if (!active) return
      if (authResult.error) { setError(errorText(authResult.error)); setLoading(false); return }
      if (!authResult.data.user) { setUserId(null); setLoading(false); return }
      setUserId(authResult.data.user.id)
      const [savedResult, collectionResult] = await Promise.all([fetchOwnSavedExperiences(), fetchPersonalCollections()])
      if (!active) return
      setExperiences(savedResult.experiences)
      setUnavailableCount(savedResult.unavailableCount)
      setUnavailableIds(savedResult.unavailableIds)
      setCollections(collectionResult.collections)
      const firstCollection = collectionResult.collections[0]?.id ?? ''
      const collectionIds = new Set(collectionResult.collections.map(collection => collection.id))
      setSelection(current => Object.fromEntries(savedResult.experiences.map(item => [
        item.event.id,
        current[item.event.id] && collectionIds.has(current[item.event.id]) ? current[item.event.id] : firstCollection,
      ])))
      setError(savedResult.error ? errorText(savedResult.error) : collectionResult.error ? errorText(collectionResult.error) : '')
      setLoading(false)
    }
    void initialize().catch(loadError => { if (active) { setError(errorText(loadError)); setLoading(false) } })
    return () => { active = false }
  }, [])

  const savedEventById = useMemo(() => new Map(experiences.map(item => [item.event.id, item.event])), [experiences])

  const createCollection = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    const result = await createPersonalCollection(collectionName)
    setBusy(false)
    if (result.error) { setError(errorText(result.error)); return }
    setCollectionName(''); setNotice('Collection created privately.'); await reload()
  }

  const addToCollection = async (eventId: string) => {
    const collectionId = selection[eventId]
    if (!collectionId) { setError('Create a collection first.'); return }
    setBusy(true); setError(''); setNotice('')
    const result = await addSavedEventToCollection(collectionId, eventId)
    setBusy(false)
    if (result.error) setError(errorText(result.error))
    else { setNotice('Experience added to your collection.'); await reload() }
  }

  const removeFromCollection = async (collectionId: string, eventId: string) => {
    setBusy(true); setError(''); setNotice('')
    const result = await removeEventFromCollection(collectionId, eventId)
    setBusy(false)
    if (result.error) setError(errorText(result.error))
    else { setNotice('Experience removed from the collection.'); await reload() }
  }

  const removeSaved = async (eventId: string) => {
    if (!window.confirm('Remove this experience from your saved list and all your collections?')) return
    setBusy(true); setError(''); setNotice('')
    const result = await removeOwnSavedEvent(eventId)
    setBusy(false)
    if (result.error) setError(errorText(result.error))
    else { setNotice('Experience removed from your saved list.'); await reload() }
  }

  const rename = async (collection: PersonalEventCollection) => {
    const nextName = window.prompt('Rename private collection', collection.name)
    if (nextName === null || nextName.trim() === collection.name) return
    setBusy(true); setError('')
    const result = await renamePersonalCollection(collection.id, nextName)
    setBusy(false)
    if (result.error) setError(errorText(result.error)); else { setNotice('Collection renamed.'); await reload() }
  }

  const removeCollection = async (collection: PersonalEventCollection) => {
    if (!window.confirm(`Delete “${collection.name}”? Saved experiences will remain in your saved list.`)) return
    setBusy(true); setError('')
    const result = await deletePersonalCollection(collection.id)
    setBusy(false)
    if (result.error) setError(errorText(result.error)); else { setNotice('Collection deleted. Your saved experiences remain saved.'); await reload() }
  }

  return <main className="saved-page">
    <header className="saved-header"><button className="saved-brand" aria-label="NODARA home" onClick={() => navigate('/')}><NodaraLogo/></button><button className="saved-back" onClick={() => navigate('/')}>Back to discovery</button></header>
    <div className="saved-content">
      <div className="saved-heading"><span>YOUR PRIVATE LIBRARY</span><h1>Saved experiences<span>.</span></h1><p>Organize event listings for your own planning. Collections are visible only to your signed-in account.</p></div>
      {error && <div className="saved-message saved-error" role="alert">{error}<button onClick={() => { setLoading(true); void reload() }}>Retry</button></div>}
      {notice && <div className="saved-message saved-success" role="status">{notice}</div>}
      {loading ? <div className="saved-loading" aria-live="polite">Loading your private saved list…</div> : !userId ? <section className="saved-empty"><h2>Sign in to view your saved experiences</h2><p>Device-only bookmarks are still available on the discovery page. Sign in to sync saved events and create private collections.</p><button onClick={() => navigate('/')}>Go to sign in</button></section> : <>
        <form className="saved-create-collection" onSubmit={event => void createCollection(event)}><div><strong>Create a collection</strong><small>For example: Weekend ideas or Summer plans</small></div><input value={collectionName} onChange={event => setCollectionName(event.target.value)} maxLength={60} placeholder="Collection name" aria-label="New collection name" required/><button disabled={busy || !collectionName.trim()}>{busy ? 'Working…' : 'Create collection'}</button></form>
        <section className="saved-list-section"><div className="saved-section-title"><h2>Saved events</h2><span>{experiences.length} shown · private to you</span></div>
          {experiences.length ? <div className="saved-event-grid">{experiences.map(({ event }) => <article className="saved-event-card" key={event.id}>
            <button className="saved-event-image" onClick={() => navigate(`/events/${event.slug}`)} aria-label={`View ${event.title}`}><img src={event.image} alt="" loading="lazy" onError={image => { image.currentTarget.src = '/event-fallback.svg' }}/></button>
            <div className="saved-event-details"><span className="saved-event-category">{event.category}</span><button className="saved-event-title" onClick={() => navigate(`/events/${event.slug}`)}>{event.title}</button><span>{event.date} · {event.city}, {event.country}</span><span>{event.price}</span>
              <div className="saved-event-actions"><select aria-label={`Choose collection for ${event.title}`} value={selection[event.id] ?? ''} onChange={e => setSelection(current => ({ ...current, [event.id]: e.target.value }))}><option value="">Choose collection</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button disabled={busy || !collections.length} onClick={() => void addToCollection(event.id)}>Add</button><button className="saved-remove" disabled={busy} onClick={() => void removeSaved(event.id)}>Remove saved</button></div>
            </div>
          </article>)}</div> : <div className="saved-empty"><h2>No saved events yet</h2><p>Save published events from discovery and they will appear here.</p><button onClick={() => navigate('/')}>Discover events</button></div>}
          {unavailableCount > 0 && <div className="saved-unavailable"><strong>{unavailableCount} saved listing{unavailableCount === 1 ? ' is' : 's are'} no longer publicly available.</strong>{unavailableIds.map(eventId => <div key={eventId}><span>Unavailable event · {eventId.slice(0, 8)}</span><button className="saved-remove" disabled={busy} onClick={() => void removeSaved(eventId)}>Remove saved listing</button></div>)}</div>}
        </section>
        <section className="saved-collections-section"><div className="saved-section-title"><h2>Your collections</h2><span>Only your account can view or change these</span></div>
          {collections.length ? <div className="saved-collection-list">{collections.map(collection => <article className="saved-collection" key={collection.id}>
            <div className="saved-collection-heading"><div><h3>{collection.name}</h3><small>{collection.eventIds.length} saved experience{collection.eventIds.length === 1 ? '' : 's'}</small></div><div><button disabled={busy} onClick={() => void rename(collection)}>Rename</button><button className="saved-remove" disabled={busy} onClick={() => void removeCollection(collection)}>Delete collection</button></div></div>
            {collection.eventIds.length ? <ul>{collection.eventIds.map(eventId => { const event = savedEventById.get(eventId); return <li key={eventId}><span>{event ? <button onClick={() => navigate(`/events/${event.slug}`)}>{event.title}</button> : 'Saved listing no longer available'}</span><button className="saved-remove" disabled={busy} onClick={() => void removeFromCollection(collection.id, eventId)}>Remove</button></li> })}</ul> : <p className="saved-collection-empty">Add an event from your saved list above.</p>}
          </article>)}</div> : <div className="saved-empty"><h2>No collections yet</h2><p>Create a private collection to organize your saved event ideas.</p></div>}
        </section>
      </>}
    </div>
  </main>
}
