import { useState } from 'react'
import { supabase } from '../lib/supabase'

type ImportedDraft = {
  title: string; short_description: string; description: string; category: string; country: string; location: string;
  venue: string; address: string; start_date: string; end_date: string; free: boolean; price: string; currency: string;
  capacity: string; cover_image: string; source_url: string; registration_url: string
}

function localDateTime(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
}

export function EventWebpageImporter({ onDraft }: { onDraft: (draft: ImportedDraft) => void }) {
  const [sourceUrl, setSourceUrl] = useState('')
  const [draft, setDraft] = useState<ImportedDraft | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [duplicate, setDuplicate] = useState<{ title: string; location: string; start_date: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)

  const importPage = async () => {
    setError(''); setDraft(null); setDuplicate(null); setWarnings([]); setApplied(false)
    if (!/^https:\/\//i.test(sourceUrl.trim())) { setError('Enter a secure HTTPS event webpage URL.'); return }
    if (!supabase) { setError('Event import is not configured.'); return }
    setBusy(true)
    const { data, error: invokeError } = await supabase.functions.invoke('import-event-webpage', { body: { sourceUrl: sourceUrl.trim() } })
    setBusy(false)
    if (invokeError || data?.error) { setError(data?.error ?? 'The event page could not be imported. Try again.'); return }
    if (!data?.draft || typeof data.draft !== 'object') { setError('The importer returned incomplete information.'); return }
    const normalized = { ...data.draft, start_date: localDateTime(data.draft.start_date), end_date: localDateTime(data.draft.end_date) }
    setDraft(normalized as ImportedDraft)
    setWarnings(Array.isArray(data.warnings) ? data.warnings.filter((value: unknown): value is string => typeof value === 'string') : [])
    setDuplicate(data.possibleDuplicate ?? null)
  }

  return <section className="event-importer" aria-labelledby="event-import-title">
    <div><span className="tiny-label">OPTIONAL ORGANISER TOOL</span><h2 id="event-import-title">Start from a public event page</h2><p>We’ll extract a draft for you to review. Nothing is saved or published until you use the event form and choose an action.</p></div>
    <div className="event-import-controls"><label htmlFor="event-import-url">Event webpage URL</label><div><input id="event-import-url" type="url" inputMode="url" autoComplete="url" maxLength={2048} placeholder="https://events.example.com/experience" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)}/><button type="button" onClick={() => void importPage()} disabled={busy}>{busy ? 'Reading page…' : 'Extract draft'}</button></div></div>
    {busy && <p className="event-import-status" role="status">Reading the public page and checking your own event list…</p>}
    {error && <p className="event-import-error" role="alert">{error}</p>}
    {draft && <div className="event-import-preview"><h3>Review extracted details</h3><p><strong>{draft.title || 'Title needed'}</strong> · {draft.category || 'Category needed'}</p><p>{draft.start_date || 'Start time not found'} · {draft.location || 'City needed'}, {draft.country || 'Country needed'}</p><p>{draft.short_description || 'Description not found'}</p>
      {warnings.map(warning => <p className="event-import-warning" key={warning}>{warning}</p>)}
      {duplicate && <p className="event-import-warning">Possible duplicate in your events: “{duplicate.title}” · {duplicate.location} · {new Date(duplicate.start_date).toLocaleDateString()}.</p>}
      <div className="event-import-actions"><button type="button" onClick={() => { onDraft(draft); setApplied(true) }}>Use these details in the form</button><button type="button" className="event-import-secondary" onClick={() => { setDraft(null); setApplied(false) }}>Discard</button></div>
      {applied && <p role="status" className="event-import-status">Details copied into the editable event form. Review every field before saving.</p>}
    </div>}
    <small>Only publicly accessible pages on the configured organiser import allowlist can be requested. Imported details may be incomplete or inaccurate; verify them before saving.</small>
  </section>
}
