import { useState } from 'react'
import type { FormEvent } from 'react'
import { submitPrivateReport, type ReportReason, type ReportTarget } from '../services/privacySafetyService'
import './ReportContentAction.css'

const choices: { value: ReportReason; label: string }[] = [
  { value: 'misleading_information', label: 'Misleading information' },
  { value: 'incorrect_details', label: 'Incorrect details' },
  { value: 'inappropriate_content', label: 'Inappropriate content' },
  { value: 'impersonation', label: 'Impersonation or misrepresentation' },
  { value: 'other', label: 'Other' },
]

export function ReportContentAction({ target, label = 'Report' }: { target: ReportTarget; label?: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason>('incorrect_details')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    const result = await submitPrivateReport(target, reason, description)
    setBusy(false)
    if (result.error) setError(result.error.message || 'Report could not be submitted. Sign in and try again.')
    else { setMessage('Your report was sent privately to the NODARA moderation team.'); setDescription('') }
  }

  return <>
    <button className="report-content-trigger" type="button" onClick={() => { setOpen(value => !value); setError(''); setMessage('') }}>{label}</button>
    {open && <div className="report-content-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="report-content-dialog" role="dialog" aria-modal="true" aria-labelledby="report-content-title">
        <button className="report-content-close" type="button" onClick={() => setOpen(false)} aria-label="Close report">×</button>
        <span className="report-content-kicker">PRIVATE REPORT</span><h2 id="report-content-title">Tell us what needs review</h2>
        <p>Your report is visible only to you and authorised platform moderators. It will not be shown publicly.</p>
        {error && <p className="report-content-error" role="alert">{error}</p>}{message && <p className="report-content-success" role="status">{message}</p>}
        {!message && <form onSubmit={event => void send(event)}>
          <label>Reason<select value={reason} onChange={event => setReason(event.target.value as ReportReason)}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
          <label>Additional detail <span>(optional)</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} rows={4} placeholder="Share details that can help the team review this item."/></label>
          <small>{description.length}/1,000</small><button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send private report'}</button>
        </form>}
      </section>
    </div>}
  </>
}
