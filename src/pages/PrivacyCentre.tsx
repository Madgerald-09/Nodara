import { useCallback, useEffect, useState } from 'react'
import './PrivacyCentre.css'
import { supabase } from '../lib/supabase'
import { fetchOwnProfile } from '../services/accountProfileService'
import { defaultProfilePrivacyPreferences, readProfilePrivacyPreferences } from '../services/profilePrivacyPreferences'
import { cancelOwnDeletion, getOwnDeletionRequests, getOwnReports, isCurrentUserPlatformModerator, requestOwnDeletion } from '../services/privacySafetyService'
import type { NavigateFunction } from './OrganiserApp'

type DeletionRequest = { id: string; status: string; requested_at: string; cancelled_at: string | null }
type PrivateReport = { id: string; target_type: string; target_id: string; reason: string; status: string; created_at: string }
function privacySchemaUnavailable(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown }
  return value.code === '42P01' || value.code === 'PGRST205'
    || (typeof value.message === 'string' && /relation .* does not exist/i.test(value.message))
}

export function PrivacyCentre({ navigate }: { navigate: NavigateFunction }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [account, setAccount] = useState<{ email: string; name: string; interests: string[]; location: string; privacy: typeof defaultProfilePrivacyPreferences } | null>(null)
  const [requests, setRequests] = useState<DeletionRequest[]>([])
  const [reports, setReports] = useState<PrivateReport[]>([])
  const [isModerator, setIsModerator] = useState(false)
  const [migrationWarning, setMigrationWarning] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePhrase, setDeletePhrase] = useState('')
  const [password, setPassword] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [{ data: auth, error: authError }, profileResult, reportResult, deletionResult, moderatorResult] = await Promise.all([
        supabase.auth.getUser(), fetchOwnProfile(), getOwnReports(), getOwnDeletionRequests(), isCurrentUserPlatformModerator(),
      ])
      if (authError || !auth.user) throw new Error('Sign in to review your privacy centre.')
      if (profileResult.error) throw profileResult.error
      const reportsTableMissing = privacySchemaUnavailable(reportResult.error)
      const deletionsTableMissing = privacySchemaUnavailable(deletionResult.error)
      const missingPrivacyTables = reportsTableMissing || deletionsTableMissing
      if (reportResult.error && !reportsTableMissing) throw reportResult.error
      if (deletionResult.error && !deletionsTableMissing) throw deletionResult.error
      setMigrationWarning(missingPrivacyTables
        ? 'Private reporting and deletion requests need the new account-safety migration before they can be used.'
        : '')
      setAccount({
        email: auth.user.email ?? '', name: profileResult.profile?.full_name ?? '',
        interests: profileResult.profile?.interest_categories ?? [], location: profileResult.profile?.location ?? '',
        privacy: readProfilePrivacyPreferences(auth.user.user_metadata?.profile_privacy_preferences),
      })
      setReports((reportsTableMissing ? [] : reportResult.reports) as PrivateReport[])
      setRequests((deletionsTableMissing ? [] : deletionResult.requests) as DeletionRequest[])
      setIsModerator(moderatorResult.moderator)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Privacy information could not be loaded.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const exportData = async () => {
    if (!supabase) return
    setExporting(true); setError(''); setExportNotice('')
    const { data, error: invokeError } = await supabase.functions.invoke('export-my-data', { body: {} })
    setExporting(false)
    if (invokeError || !data) { setError(invokeError?.message || 'Your export could not be generated. Try again later.'); return }
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob); const link = document.createElement('a')
      link.href = url; link.download = `nodara-personal-data-${new Date().toISOString().slice(0, 10)}.json`
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportNotice('Your private export was downloaded. It was generated for this request and was not stored.')
    } catch { setError('The export was received but could not be downloaded by this browser.') }
  }

  const submitDeletion = async () => {
    if (!supabase || !account?.email) { setError('Your account could not be reauthenticated.'); return }
    setDeleteBusy(true); setError(''); setNotice('')
    const { error: authError } = await supabase.auth.signInWithPassword({ email: account.email, password })
    if (authError) { setDeleteBusy(false); setError('Password check failed. Your request was not submitted.'); return }
    const result = await requestOwnDeletion(deletePhrase)
    setDeleteBusy(false)
    if (result.error) { setError(result.error.message || 'Deletion request could not be submitted.'); return }
    setDeleteOpen(false); setPassword(''); setDeletePhrase('')
    setNotice('Your request was recorded for review. This does not delete your account or records.'); void load()
  }

  const cancelDeletion = async (id: string) => {
    const result = await cancelOwnDeletion(id)
    if (result.error || !result.cancelled) setError(result.error?.message || 'That request can no longer be cancelled.')
    else { setNotice('Your pending request was cancelled.'); void load() }
  }

  return <main className="privacy-centre-page">
    <header className="privacy-centre-header"><button className="privacy-wordmark" onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><button className="privacy-back" onClick={() => navigate('/')}>Back to discovery</button></header>
    <div className="privacy-centre-content">
      <div className="privacy-centre-heading"><span>YOUR ACCOUNT · PRIVATE</span><h1>Privacy centre<span>.</span></h1><p>Review your information and choose what to do with your account data.</p></div>
      {error && <div className="privacy-alert privacy-alert-error" role="alert">{error}<button onClick={() => void load()}>Retry</button></div>}
      {notice && <div className="privacy-alert privacy-alert-success" role="status">{notice}</div>}
      {migrationWarning && <div className="privacy-alert privacy-alert-warning" role="status">{migrationWarning}</div>}
      {loading ? <div className="privacy-loading" aria-live="polite">Loading your privacy information…</div> : <>
        <section className="privacy-panel"><div className="privacy-panel-heading"><div><span>ACCOUNT CONTROLS</span><h2>Your information and preferences</h2><p>Only your signed-in account can access this summary.</p></div></div>
          <div className="privacy-link-grid"><button onClick={() => navigate('/account/profile')}><strong>Private profile settings</strong><span>Edit your name, profile fields and interests →</span></button><button onClick={() => navigate('/account/profile')}><strong>Recommendation preferences</strong><span>{account?.privacy.useInterestsForRecommendations ? 'Interests are used' : 'Interests are not used'} · {account?.privacy.useLocationForNearbyDiscovery ? 'location is used' : 'location is not used'} →</span></button><button onClick={() => navigate('/account/activity')}><strong>Personal activity</strong><span>Review your own bookings, tickets and saved activity →</span></button><button onClick={() => navigate('/notifications')}><strong>Notification preferences</strong><span>Choose in-app and email updates for your account →</span></button></div>
          {account && <div className="privacy-data-summary"><h3>Personal data held for your account</h3><dl><div><dt>Account email</dt><dd>{account.email || 'Not available'}</dd></div><div><dt>Display name</dt><dd>{account.name || 'Not set'}</dd></div><div><dt>Saved interests</dt><dd>{account.interests.length ? account.interests.join(', ') : 'None selected'}</dd></div><div><dt>Saved location</dt><dd>{account.location || 'Not set'} <small>(used only when nearby discovery is enabled)</small></dd></div></dl></div>}
          {isModerator && <button className="privacy-moderator-link" onClick={() => navigate('/moderation')}>Open restricted moderation workspace →</button>}
        </section>

        <section className="privacy-panel"><div className="privacy-panel-heading"><div><span>DATA EXPORT</span><h2>Download your supported account data</h2><p>Includes your profile, saved items, collections when available, booking and ticket summaries, memberships and preferences. It excludes QR secrets, payment-provider data, other people's information and internal moderation notes.</p></div></div><button className="privacy-primary" onClick={() => void exportData()} disabled={exporting}>{exporting ? 'Preparing private export…' : 'Download JSON export'}</button>{exportNotice && <p className="privacy-inline-success" role="status">{exportNotice}</p>}</section>

        <section className="privacy-panel"><div className="privacy-panel-heading"><div><span>ACCOUNT DELETION REQUEST</span><h2>Ask us to review an account deletion</h2><p>A request does not immediately delete your account. A future trusted review process must consider booking, ticket, payment and legal record-retention needs. No deletion worker is enabled in this development implementation.</p></div></div>
          {requests.length ? <ul className="privacy-request-list">{requests.map(request => <li key={request.id}><span><strong>{request.status.replaceAll('_', ' ')}</strong><small>Requested {new Date(request.requested_at).toLocaleString()}</small></span>{request.status === 'pending' && <button onClick={() => void cancelDeletion(request.id)}>Cancel request</button>}</li>)}</ul> : <p className="privacy-muted">You have no deletion requests.</p>}
          <button className="privacy-danger" onClick={() => { setDeleteOpen(true); setError('') }}>Request account deletion</button>
          {deleteOpen && <div className="privacy-delete-form"><h3>Confirm this request</h3><p>To protect your account, re-enter your password and type <strong>DELETE MY ACCOUNT</strong>. This records a request only; it does not remove your account.</p><label>Account password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label><label>Confirmation phrase<input value={deletePhrase} onChange={event => setDeletePhrase(event.target.value)} autoComplete="off"/></label><div><button className="privacy-danger" disabled={deleteBusy || !password || deletePhrase !== 'DELETE MY ACCOUNT'} onClick={() => void submitDeletion()}>{deleteBusy ? 'Verifying…' : 'Confirm request'}</button><button onClick={() => { setDeleteOpen(false); setPassword(''); setDeletePhrase('') }}>Keep my account</button></div></div>}
        </section>

        <section className="privacy-panel"><div className="privacy-panel-heading"><div><span>PRIVATE REPORTING</span><h2>Your submitted reports</h2><p>Reports about events and community information are private. Reporters are not identified publicly. Announcement reports are not available because the permitted database migrations do not include an announcement system.</p></div></div>
          {reports.length ? <ul className="privacy-report-list">{reports.map(report => <li key={report.id}><span><strong>{report.target_type} · {report.reason.replaceAll('_', ' ')}</strong><small>{new Date(report.created_at).toLocaleString()}</small></span><span className="privacy-status">{report.status.replaceAll('_', ' ')}</span></li>)}</ul> : <p className="privacy-muted">No reports submitted. Report controls are available on supported event and community information.</p>}
        </section>
      </>}
      <footer className="privacy-footnote">Your data is scoped to your signed-in account. Requests and reports are protected by database permissions; moderator access is separately restricted and audited.</footer>
    </div>
  </main>
}
