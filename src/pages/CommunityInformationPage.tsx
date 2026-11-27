import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './CommunityInformationPage.css'
import { supabase } from '../lib/supabase'
import {
  changeCommunityAnnouncementStatus, createCommunityAnnouncement, fetchCommunityAnnouncementHistory,
  fetchCommunityInformation, getUpcomingPublishedEvents, saveCommunityPublicInfo, scheduleCommunityAnnouncement,
  setCommunityEventHighlight, setCommunityMembership, updateCommunityAnnouncement,
} from '../services/communityService'
import type { CommunityAnnouncement } from '../services/communityService'
import { isPublicCommunityAnnouncement, isSafeCommunityHttpsUrl } from '../services/communityAnnouncementPolicy'
import { ReportContentAction } from '../components/ReportContentAction'
import type { NavigateFunction } from './OrganiserApp'

type PageData = Awaited<ReturnType<typeof fetchCommunityInformation>>
type Highlight = { event_id: string; event: Record<string, unknown> }
type HistoryItem = { id: string; action: string; title_snapshot: string; body_snapshot: string; status_snapshot: string; created_at: string }
type PublicEventOption = { id: string; title: string; slug: string; location: string; country: string; start_date: string }

function safeExternalUrl(value: unknown) {
  if (typeof value !== 'string') return null
  return isSafeCommunityHttpsUrl(value) ? new URL(value).toString() : null
}

export function CommunityInformationPage({ slug, announcementId, navigate }: {
  slug: string
  announcementId?: string
  navigate: NavigateFunction
}) {
  const [data, setData] = useState<PageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [infoForm, setInfoForm] = useState({ website: '', links: '', guidelines: '' })
  const [announcementForm, setAnnouncementForm] = useState({ title: '', body: '' })
  const [editing, setEditing] = useState<string | null>(null)
  const [scheduleDates, setScheduleDates] = useState<Record<string, string>>({})
  const [eventOptions, setEventOptions] = useState<PublicEventOption[]>([])
  const [eventToHighlight, setEventToHighlight] = useState('')
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [joined, setJoined] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const result = await fetchCommunityInformation(slug)
    if (!result.community) {
      setData(null); setError(result.error?.message || 'Community information could not be loaded.'); setLoading(false); return
    }
    setData(result)
    setInfoForm({
      website: result.info?.official_website ?? '',
      links: (result.info?.official_links ?? []).join('\n'),
      guidelines: result.info?.guidelines ?? '',
    })
    setJoined(Boolean(result.role))
    if (result.role === 'owner' || result.role === 'moderator') {
      const options = await getUpcomingPublishedEvents()
      if (!options.error) setEventOptions(options.events as PublicEventOption[])
    }
    setLoading(false)
  }, [slug])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const isManager = (data?.role === 'owner' || data?.role === 'moderator') && !data?.schemaWarning
  const focusedAnnouncement = useMemo(() => data?.announcements.find(item => item.id === announcementId) ?? null, [data, announcementId])
  const publicAnnouncements = data?.announcements.filter(item => isManager || isPublicCommunityAnnouncement(item)) ?? []
  const highlightRows = (data?.highlights ?? []) as Highlight[]

  const handleMembership = async () => {
    if (!supabase) return
    setSaving(true); setError(''); setNotice('')
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) { setSaving(false); setError('Sign in to join this community.'); return }
    const result = await setCommunityMembership(auth.user.id, data!.community!.id, !joined)
    setSaving(false)
    if (result.error) setError('Membership could not be updated. Please try again.')
    else { setJoined(!joined); setNotice(joined ? 'You left the community.' : 'You joined the community.') }
  }

  const saveInfo = async (event: FormEvent) => {
    event.preventDefault(); if (!data?.community) return
    setSaving(true); setError(''); setNotice('')
    const result = await saveCommunityPublicInfo({ communityId: data.community.id, website: infoForm.website, links: infoForm.links.split('\n'), guidelines: infoForm.guidelines })
    setSaving(false)
    if (result.error) setError(result.error.message || 'Community information could not be saved.')
    else { setNotice('Official community information was updated.'); await load() }
  }

  const createAnnouncement = async (event: FormEvent) => {
    event.preventDefault(); if (!data?.community) return
    setSaving(true); setError(''); setNotice('')
    const result = await createCommunityAnnouncement(data.community.id, announcementForm.title, announcementForm.body)
    setSaving(false)
    if (result.error) setError(result.error.message || 'Announcement could not be created.')
    else { setAnnouncementForm({ title: '', body: '' }); setNotice('Announcement saved as a draft.'); await load() }
  }

  const editAnnouncement = async (event: FormEvent, item: CommunityAnnouncement) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const result = await updateCommunityAnnouncement(item.id, String(form.get('title') ?? ''), String(form.get('body') ?? ''))
    setSaving(false)
    if (result.error) setError(result.error.message || 'Announcement could not be updated.')
    else { setEditing(null); setNotice('Announcement updated.'); await load() }
  }

  const setAnnouncementStatus = async (action: 'publish' | 'archive', id: string) => {
    if (action === 'archive' && !window.confirm('Archive this official announcement? It will no longer appear publicly.')) return
    setSaving(true); setError(''); setNotice('')
    const result = await changeCommunityAnnouncementStatus(action, id)
    setSaving(false)
    if (result.error) setError(result.error.message || 'Announcement status could not be changed.')
    else { setNotice(action === 'publish' ? 'Announcement published.' : 'Announcement archived.'); await load() }
  }

  const scheduleAnnouncement = async (id: string) => {
    const localValue = scheduleDates[id]
    if (!localValue) { setError('Choose a future publication time first.'); return }
    setSaving(true); setError(''); setNotice('')
    const result = await scheduleCommunityAnnouncement(id, localValue)
    setSaving(false)
    if (result.error) setError(result.error.message || 'Announcement could not be scheduled.')
    else { setNotice('Announcement scheduled. It stays private until the scheduled publisher runs.'); await load() }
  }

  const highlightEvent = async () => {
    if (!data?.community || !eventToHighlight) return
    setSaving(true); setError(''); setNotice('')
    const result = await setCommunityEventHighlight(data.community.id, eventToHighlight, true)
    setSaving(false)
    if (result.error) setError(result.error.message || 'Event could not be highlighted.')
    else { setEventToHighlight(''); setNotice('Event added to community highlights.'); await load() }
  }

  const removeHighlight = async (eventId: string) => {
    if (!data?.community) return
    setSaving(true); setError('')
    const result = await setCommunityEventHighlight(data.community.id, eventId, false)
    setSaving(false)
    if (result.error) setError('Highlight could not be removed.')
    else await load()
  }

  const showHistory = async (id: string) => {
    const result = await fetchCommunityAnnouncementHistory(id)
    if (result.error) { setError('Announcement history is available only to community managers.'); return }
    setHistory(result.history as HistoryItem[]); setHistoryFor(historyFor === id ? null : id)
  }

  if (loading) return <main className="community-page"><div className="community-page-status" role="status">Loading community information…</div></main>
  if (!data?.community) return <main className="community-page"><header className="community-page-header"><button onClick={() => navigate('/')}>NODARA · Back to discovery</button></header><div className="community-page-status"><h1>Community unavailable</h1><p>{error}</p><button onClick={() => void load()}>Retry</button></div></main>

  const community = data.community
  const links = Array.isArray(data.info?.official_links) ? data.info!.official_links.map(safeExternalUrl).filter((link): link is string => Boolean(link)) : []

  return <main className="community-page">
    <header className="community-page-header"><button onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><button onClick={() => navigate('/')}>Back to discovery</button></header>
    <div className="community-page-main">
      {error && <div className="community-alert community-alert-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {notice && <div className="community-alert community-alert-success" role="status">{notice}</div>}
      {data.schemaWarning && <div className="community-alert community-alert-warning" role="status">{data.schemaWarning}</div>}
      <section className="community-hero-panel">
        {community.cover_image ? <img src={community.cover_image} alt="" onError={event => { event.currentTarget.hidden = true }}/> : <div className="community-hero-placeholder">{community.name.charAt(0).toUpperCase()}</div>}
        <div><span className="community-page-kicker">OFFICIAL COMMUNITY INFORMATION</span><h1>{community.name}</h1><p>{community.description}</p><div className="community-facts"><span>{community.category}</span>{community.location && <span>{community.location}</span>}<span>{community.member_count.toLocaleString()} members</span></div><p className="community-manager-copy">Community information is maintained by its authorised owner and moderators. Member identities are private.</p>{data.role === 'owner' ? <span className="community-role">Owner</span> : data.role === 'moderator' ? <span className="community-role">Moderator</span> : <button className="community-join" disabled={saving} onClick={() => void handleMembership()}>{saving ? 'Updating…' : joined ? 'Leave community' : 'Join community'}</button>}</div>
      </section>

      <section className="community-info-section"><div><span className="community-page-kicker">COMMUNITY DETAILS</span><h2>Guidelines & official resources</h2><p>Review the community’s published information and resources.</p></div>{data.info?.updated_at && <small>Updated {new Date(data.info.updated_at).toLocaleString()}</small>}
        {data.info?.guidelines ? <div className="community-guidelines">{data.info.guidelines}</div> : <div className="community-empty">No community guidelines have been published yet.</div>}
        <div className="community-official-links">{data.info?.official_website && safeExternalUrl(data.info.official_website) && <a href={safeExternalUrl(data.info.official_website)!} target="_blank" rel="noreferrer">Official website ↗</a>}{links.map(link => <a key={link} href={link} target="_blank" rel="noreferrer">Official resource ↗</a>)}</div>
        {isManager && <form className="community-manager-form" onSubmit={event => void saveInfo(event)}><h3>Manage official information</h3><label>Official website<input type="url" inputMode="url" placeholder="https://example.org" value={infoForm.website} onChange={event => setInfoForm(current => ({ ...current, website: event.target.value }))} maxLength={2048}/></label><label>Official links <span>One HTTPS link per line, up to 10.</span><textarea rows={4} value={infoForm.links} onChange={event => setInfoForm(current => ({ ...current, links: event.target.value }))}/></label><label>Community guidelines<textarea rows={7} maxLength={10000} value={infoForm.guidelines} onChange={event => setInfoForm(current => ({ ...current, guidelines: event.target.value }))}/><small>{infoForm.guidelines.length}/10,000</small></label><button disabled={saving}>{saving ? 'Saving…' : 'Publish community information'}</button></form>}
      </section>

      <section className="community-info-section"><div><span className="community-page-kicker">OFFICIAL ANNOUNCEMENTS</span><h2>Updates from the community</h2><p>Only published announcements are public. Draft and scheduled notices remain visible only to community managers.</p></div>
        {isManager && <div className="community-schedule-note">Scheduled announcements are published by a trusted server task. Until Supabase Cron is configured to call the protected publisher, scheduled notices remain private.</div>}
        {announcementId && !focusedAnnouncement && <div className="community-alert community-alert-error">This announcement is unavailable or is not published.</div>}
        {(announcementId ? (focusedAnnouncement ? [focusedAnnouncement] : []) : publicAnnouncements).length ? <div className="community-announcement-list">{(announcementId ? (focusedAnnouncement ? [focusedAnnouncement] : []) : publicAnnouncements).map(item => <article className="community-announcement" key={item.id}>
          <div className="community-announcement-top"><span className="community-official-badge">OFFICIAL</span>{isManager && <span className={`community-announcement-status status-${item.status}`}>{item.status}{item.scheduled_for ? ` · ${new Date(item.scheduled_for).toLocaleString()}` : ''}</span>}{item.published_at && <time>{new Date(item.published_at).toLocaleString()}</time>}</div>
          {isManager && editing === item.id ? <form onSubmit={event => void editAnnouncement(event, item)}><label>Title<input name="title" defaultValue={item.title} maxLength={180} required/></label><label>Announcement<textarea name="body" defaultValue={item.body} maxLength={8000} rows={6} required/></label><div className="community-actions"><button disabled={saving}>Save changes</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div></form> : <><h3><button className="community-announcement-title" onClick={() => navigate(`/communities/${encodeURIComponent(community.slug)}/announcements/${item.id}`)}>{item.title}</button></h3><div className="community-announcement-body">{item.body}</div></>}
          {item.status === 'published' && <ReportContentAction target={{ type: 'announcement', id: item.id }} label="Report announcement"/>}
          {isManager && <div className="community-actions"><button onClick={() => setEditing(item.id)}>Edit</button>{item.status === 'draft' && <button disabled={saving} onClick={() => void setAnnouncementStatus('publish', item.id)}>Publish now</button>}{['draft', 'scheduled'].includes(item.status) && <><label className="community-schedule-input">Schedule<input type="datetime-local" value={scheduleDates[item.id] ?? ''} onChange={event => setScheduleDates(current => ({ ...current, [item.id]: event.target.value }))}/></label><button disabled={saving} onClick={() => void scheduleAnnouncement(item.id)}>Schedule</button></>}{item.status !== 'archived' && <button className="community-archive-button" disabled={saving} onClick={() => void setAnnouncementStatus('archive', item.id)}>Archive</button>}<button onClick={() => void showHistory(item.id)}>View history</button></div>}
          {historyFor === item.id && <div className="community-history"><h4>Announcement history</h4>{history.length ? history.map(version => <article key={version.id}><small>{version.action.replaceAll('_', ' ')} · {version.status_snapshot} · {new Date(version.created_at).toLocaleString()}</small><strong>{version.title_snapshot}</strong><p>{version.body_snapshot}</p></article>) : <p>No earlier versions are available.</p>}</div>}
        </article>)}</div> : <div className="community-empty">No published announcements are available.</div>}
        {isManager && <form className="community-manager-form" onSubmit={event => void createAnnouncement(event)}><h3>Create an official announcement</h3><p>New announcements start as private drafts. Publish or schedule them after review.</p><label>Title<input value={announcementForm.title} onChange={event => setAnnouncementForm(current => ({ ...current, title: event.target.value }))} minLength={3} maxLength={180} required/></label><label>Announcement<textarea value={announcementForm.body} onChange={event => setAnnouncementForm(current => ({ ...current, body: event.target.value }))} minLength={1} maxLength={8000} rows={6} required/></label><button disabled={saving}>{saving ? 'Saving…' : 'Save draft'}</button></form>}
      </section>

      <section className="community-info-section"><div><span className="community-page-kicker">EVENT HIGHLIGHTS</span><h2>Upcoming experiences</h2><p>Public events selected by the community’s authorised managers.</p></div>
        {highlightRows.length ? <div className="community-highlight-grid">{highlightRows.map(row => { const event = row.event; return <article key={row.event_id}><span>{String(event.category ?? 'EXPERIENCE')}</span><h3>{String(event.title ?? 'Event unavailable')}</h3><p>{new Date(String(event.start_date)).toLocaleString()} · {String(event.location ?? '')}, {String(event.country ?? '')}</p><button onClick={() => navigate(`/events/${String(event.slug ?? '')}`)}>View event →</button>{isManager && <button onClick={() => void removeHighlight(row.event_id)}>Remove highlight</button>}</article> })}</div> : <div className="community-empty">No upcoming published events have been highlighted.</div>}
        {isManager && <div className="community-highlight-controls"><label>Published upcoming event<select value={eventToHighlight} onChange={event => setEventToHighlight(event.target.value)}><option value="">Choose an event</option>{eventOptions.filter(event => !highlightRows.some(row => row.event_id === event.id)).map(event => <option key={event.id} value={event.id}>{event.title} · {event.location}</option>)}</select></label><button disabled={saving || !eventToHighlight} onClick={() => void highlightEvent()}>Add event highlight</button></div>}
      </section>
      <section className="community-report-footer"><p>Found incorrect community information?</p><ReportContentAction target={{ type: 'community', id: community.id }} label="Report community information"/></section>
    </div>
  </main>
}
