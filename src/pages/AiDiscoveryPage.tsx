import { useEffect, useRef, useState } from 'react'
import './Phase12.css'
import { fetchEvents } from '../services/eventService'
import type { EventFilters } from '../services/eventService'
import { buildGroundedDiscoveryAnswer, parseNaturalLanguageDiscovery } from '../services/naturalLanguageDiscovery'
import { supabase } from '../lib/supabase'
import { loadRecommendedEvents } from '../services/recommendationService'
import type { EventView } from '../types/database'
import type { NavigateFunction } from './OrganiserApp'

const categories = ['All categories', 'Technology', 'Music', 'Business', 'Art & Culture', 'Sports', 'Gaming', 'Education', 'Adventure', 'Social']

export function AiDiscoveryPage({ navigate }: { navigate: NavigateFunction }) {
  const params = new URLSearchParams(window.location.search)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [location, setLocation] = useState(params.get('location') ?? '')
  const [price, setPrice] = useState(params.get('price') ?? '')
  const [dateFrom, setDateFrom] = useState(params.get('from') ?? '')
  const [dateTo, setDateTo] = useState(params.get('to') ?? '')
  const [events, setEvents] = useState<EventView[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [answer, setAnswer] = useState('Ask about published NODARA events. Answers are assembled from event listings and are not generated from private account data.')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [listening, setListening] = useState(false)
  const [recordingSupported, setRecordingSupported] = useState(true)
  const [audioUrl, setAudioUrl] = useState('')
  const [speechBusy, setSpeechBusy] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const performSearch = async (nextQuery = query) => {
    if (nextQuery.trim().length > 240) { setError('Keep your search under 240 characters.'); return }
    setError(''); setLoading(true)
    const parsed = parseNaturalLanguageDiscovery(nextQuery)
    const filters: EventFilters = {
      ...parsed,
      category: category && category !== 'All categories' ? category : parsed.category,
      location: location.trim() || parsed.location,
      price: price === 'free' || price === 'paid' ? price : parsed.price,
      dateFrom: dateFrom || parsed.dateFrom,
      dateTo: dateTo || parsed.dateTo,
      sort: 'upcoming',
    }
    const url = new URL(window.location.href)
    const params = new URLSearchParams()
    if (nextQuery.trim()) params.set('q', nextQuery.trim())
    if (filters.category) params.set('category', filters.category)
    if (filters.location) params.set('location', filters.location)
    if (filters.price) params.set('price', filters.price)
    if (filters.dateFrom) params.set('from', filters.dateFrom)
    if (filters.dateTo) params.set('to', filters.dateTo)
    url.search = params.toString(); window.history.replaceState(window.history.state, '', url)
    try {
      let results: EventView[]
      if (/\b(recommend|recommendations|suggest|for me)\b/i.test(nextQuery)) {
        const recommendation = await loadRecommendedEvents(categories.slice(1))
        if (recommendation.error) throw new Error(recommendation.error)
        results = recommendation.events.filter(event =>
          (!filters.category || event.category === filters.category)
          && (!filters.location || `${event.city} ${event.country}`.toLowerCase().includes(filters.location.toLowerCase()))
          && (!filters.price || (filters.price === 'free' ? event.amount === 0 : event.amount > 0))
          && (!filters.dateFrom || event.startDate.slice(0, 10) >= filters.dateFrom)
          && (!filters.dateTo || event.startDate.slice(0, 10) <= filters.dateTo),
        )
      } else {
        const result = await fetchEvents(filters)
        if (result.error) throw result.error
        results = result.events
      }
      setEvents(results)
      setHasSearched(true)
      setAnswer(buildGroundedDiscoveryAnswer(results, filters))
    } catch {
      setEvents([]); setHasSearched(true); setError('Event search is temporarily unavailable. Try again.')
      setAnswer('I could not load published event information right now.')
    } finally { setLoading(false) }
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    streamRef.current?.getTracks().forEach(track => track.stop())
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  const startVoiceSearch = async () => {
    setVoiceError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setRecordingSupported(false); setVoiceError('Voice input is not supported in this browser. You can type your search.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = recorder
      const chunks: BlobPart[] = []
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop()); streamRef.current = null; setListening(false)
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (!audio.size || audio.size > 1_500_000) { setVoiceError('The recording is empty or too large. Try a shorter search.'); return }
        if (!supabase) { setVoiceError('Voice search is not configured.'); return }
        setSpeechBusy('transcribing')
        const extension = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : audio.type.includes('wav') ? 'wav' : audio.type.includes('mpeg') ? 'mp3' : 'webm'
        const form = new FormData(); form.append('audio', audio, `voice-search.${extension}`)
        const { data, error: invokeError } = await supabase.functions.invoke('elevenlabs-transcribe', { body: form })
        setSpeechBusy('')
        if (invokeError || data?.error) { setVoiceError(data?.error ?? 'Speech could not be transcribed. You can type instead.'); return }
        setQuery(data.transcript); void performSearch(data.transcript)
      }
      recorder.start(); setListening(true)
      timerRef.current = window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop() }, 20_000)
    } catch (failure) {
      setVoiceError(failure instanceof Error && failure.name === 'NotAllowedError' ? 'Microphone access was not allowed. You can type your search instead.' : 'Microphone could not be started. You can type your search instead.')
    }
  }

  const stopVoiceSearch = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
  }

  const speak = async (event: EventView, mode: 'summary' | 'description') => {
    setVoiceError(''); setSpeechBusy(event.id)
    if (!supabase) { setVoiceError('Spoken summaries are not configured.'); setSpeechBusy(''); return }
    const { data, error: invokeError } = await supabase.functions.invoke('elevenlabs-event-speech', { body: { eventId: event.id, mode } })
    setSpeechBusy('')
    if (invokeError || data?.error || !(data instanceof Blob)) { setVoiceError(data?.error ?? 'Spoken audio could not be generated. Sign in and try again.'); return }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    const nextUrl = URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' }))
    setAudioUrl(nextUrl)
    window.setTimeout(() => { void audioRef.current?.play().catch(() => setVoiceError('Press play to start the audio.')) }, 0)
  }

  return <main className="ai-discovery-page">
    <div className="ai-discovery-top"><div><span className="tiny-label">NODARA DISCOVERY ASSISTANT</span><h1>Find an experience<span className="green-dot">.</span></h1><p>Search in everyday language. Results come from published event listings.</p></div><button type="button" onClick={() => navigate('/')}>← Back to discovery</button></div>
    <form className="ai-discovery-controls" onSubmit={event => { event.preventDefault(); void performSearch() }}><input aria-label="Describe an event you are looking for" value={query} onChange={event => setQuery(event.target.value)} maxLength={240} placeholder="Find free technology events in Lagos next month"/><button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search events'}</button></form>
    <div className="ai-discovery-filters" aria-label="Search filters"><label>Category<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option value={item === 'All categories' ? '' : item} key={item}>{item}</option>)}</select></label><label>City or location<input value={location} onChange={event => setLocation(event.target.value)} maxLength={80} placeholder="Anywhere"/></label><label>Price<select value={price} onChange={event => setPrice(event.target.value)}><option value="">Any price</option><option value="free">Free</option><option value="paid">Paid</option></select></label><label>From<input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)}/></label><label>To<input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)}/></label></div>
    <section aria-live="polite"><h2>What I found</h2><p>{answer}</p>{error && <p className="ai-discovery-error" role="alert">{error} <button type="button" onClick={() => void performSearch()}>Retry</button></p>}{loading && <p role="status">Searching published NODARA events…</p>}{!loading && !error && hasSearched && query.trim() && events.length === 0 && <div className="ai-discovery-empty">No matching published events yet. Try a different location or remove a filter.</div>}
      <div className="ai-discovery-results">{events.map(event => <article className="ai-discovery-card" key={event.id}><span className="tiny-label">{event.category}</span><h3>{event.title}</h3><p>{event.shortDescription || event.description.slice(0, 180)}</p><small>{new Date(event.startDate).toLocaleString()} · {event.city}, {event.country} · {event.price || 'Price not listed'}</small><div><button type="button" onClick={() => navigate(`/events/${encodeURIComponent(event.slug)}`)}>Open event details</button><button type="button" disabled={speechBusy === event.id} onClick={() => void speak(event, 'summary')}>{speechBusy === event.id ? 'Preparing audio…' : 'Read event summary aloud'}</button></div></article>)}</div>
    </section>
    <section className="voice-panel"><h2>Voice search</h2><p>Microphone use starts only when you press the button. A short recording is sent to ElevenLabs for transcription and is not saved by NODARA.</p><div className="voice-panel-controls"><button type="button" disabled={listening || speechBusy === 'transcribing' || !recordingSupported} onClick={() => void startVoiceSearch()}>{listening ? 'Listening…' : speechBusy === 'transcribing' ? 'Transcribing…' : 'Speak a search'}</button>{listening && <button type="button" className="quiet" onClick={stopVoiceSearch}>Stop recording</button>}{audioUrl && <button type="button" className="quiet" onClick={() => { audioRef.current?.pause(); if (audioUrl) URL.revokeObjectURL(audioUrl); setAudioUrl('') }}>Stop audio</button>}</div>{audioUrl && <audio ref={audioRef} controls src={audioUrl} aria-label="Spoken event summary"/>}{voiceError && <p className="ai-discovery-error" role="alert">{voiceError}</p>}<p className="ai-discovery-note">Speech features require sign-in and may be unavailable until the service is configured. Text search remains available.</p></section>
  </main>
}
