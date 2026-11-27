import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getModerationAudit, getModerationQueue, reviewPrivateReport } from '../services/privacySafetyService'
import type { NavigateFunction } from './OrganiserApp'
import './PrivacyCentre.css'

type ModerationReport = {
  id: string
  reporter_id: string
  target_type: string
  target_id: string
  community_id: string | null
  reason: string
  description: string | null
  status: string
  created_at: string
}
type AuditAction = {
  id: string
  moderator_id: string
  previous_status: string
  new_status: string
  decision: string
  internal_note: string | null
  created_at: string
}

export function ModerationDashboard({ navigate }: { navigate: NavigateFunction }) {
  const [reports, setReports] = useState<ModerationReport[]>([])
  const [selected, setSelected] = useState('')
  const [actions, setActions] = useState<AuditAction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ status: 'under_review', decision: '', internalNote: '' })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const result = await getModerationQueue()
    setLoading(false)
    if (result.error) {
      setReports([])
      setError('Moderation access is unavailable. The database denies access unless your account is an authorised platform moderator.')
      return
    }
    setReports(result.reports as ModerationReport[])
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (!selected) return
    let active = true
    void getModerationAudit(selected).then(result => {
      if (!active) return
      setActions(result.actions as AuditAction[])
      if (result.error) setError('Audit history could not be loaded.')
    })
    return () => { active = false }
  }, [selected])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    setBusy(true); setError('')
    const result = await reviewPrivateReport({ reportId: selected, ...form })
    setBusy(false)
    if (result.error) setError('The moderation action was denied or could not be saved.')
    else { setForm({ status: 'under_review', decision: '', internalNote: '' }); await load() }
  }

  return <main className="moderation-page">
    <header className="moderation-header"><button onClick={() => navigate('/account/privacy')}>← Privacy centre</button></header>
    <div className="moderation-content">
      <span className="community-page-kicker">RESTRICTED WORKSPACE</span>
      <h1>Private moderation queue</h1>
      <p>Access is enforced by Supabase RLS and the review function. Reporter details and internal notes stay within this restricted workspace.</p>
      {error && <div className="privacy-alert privacy-alert-error" role="alert">{error}<button onClick={() => void load()}>Retry</button></div>}
      {loading ? <p>Loading authorised reports…</p> : reports.length ? reports.map(report => <article className="moderation-report" key={report.id}>
        <small>{report.status.toUpperCase()} · {report.target_type} · {report.reason.replaceAll('_', ' ')}</small>
        <h2>Target record: {report.target_id}</h2>
        {report.community_id && <p>Associated community: {report.community_id}</p>}
        <p>{report.description || 'No additional explanation was provided.'}</p>
        <small>Private reporter account: {report.reporter_id} · Submitted {new Date(report.created_at).toLocaleString()}</small>
        <button type="button" onClick={() => setSelected(selected === report.id ? '' : report.id)}>
          {selected === report.id ? 'Close review' : 'Review report'}
        </button>
        {selected === report.id && <>
          <form onSubmit={event => void submit(event)}>
            <label>Status<select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value }))}>
              <option value="under_review">Under review</option><option value="action_taken">Action taken</option>
              <option value="dismissed">Dismissed</option><option value="resolved">Resolved</option>
            </select></label>
            <label>Decision<textarea required maxLength={1000} value={form.decision} onChange={event => setForm(current => ({ ...current, decision: event.target.value }))}/></label>
            <label>Internal note (moderators only)<textarea maxLength={2000} value={form.internalNote} onChange={event => setForm(current => ({ ...current, internalNote: event.target.value }))}/></label>
            <button disabled={busy}>{busy ? 'Saving…' : 'Record moderation action'}</button>
          </form>
          <div className="moderation-audit"><strong>Audit history</strong>{actions.length ? actions.map(action => <p key={action.id}>
            <small>{action.previous_status} → {action.new_status} · {new Date(action.created_at).toLocaleString()}</small><br/>{action.decision}
            {action.internal_note && <><br/><em>Internal: {action.internal_note}</em></>}
          </p>) : <p>No earlier actions.</p>}</div>
        </>}
      </article>) : <p>No reports are currently available to this moderator account.</p>}
    </div>
  </main>
}
