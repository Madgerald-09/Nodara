import { useMemo, useState } from 'react'
import { reconcileSolanaTickets } from '../services/solanaReconciliationService'
import type { ReconciliationClassification, ReconciliationResult } from '../services/solanaReconciliationService'

type DisplayResult = ReconciliationResult & { scanRunId: string }

const labels: Record<ReconciliationClassification, string> = {
  IN_SYNC: 'In sync',
  MISSING_ON_CHAIN: 'Missing on chain',
  MISSING_IN_DATABASE: 'Missing in NODARA',
  OWNER_MISMATCH: 'Owner mismatch',
  STATUS_MISMATCH: 'Status mismatch',
  TRANSFER_HISTORY_MISMATCH: 'Transfer history mismatch',
  CHECKIN_MISMATCH: 'Check-in mismatch',
  INVALID_ACCOUNT: 'Invalid chain account',
  PENDING_CONFIRMATION: 'Pending finality',
  RPC_UNAVAILABLE: 'Devnet RPC unavailable',
  REQUIRES_MANUAL_REVIEW: 'Manual review',
}

export function SolanaReconciliationPanel({ eventId }: { eventId: string }) {
  const [results, setResults] = useState<DisplayResult[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const uniqueResults = useMemo(() => [...new Map(results.map(result => [result.ticketId, result])).values()], [results])
  const pages = useMemo(() => {
    const groups = new Map<string, DisplayResult[]>()
    for (const result of results) groups.set(result.scanRunId, [...(groups.get(result.scanRunId) ?? []), result])
    return [...groups.entries()].reverse()
  }, [results])

  const scan = async (options: { reset?: boolean; cursorAfter?: string | null; ticketId?: string } = {}) => {
    setBusy(true); setError(''); setStatus(options.ticketId ? 'Checking one ticket against finalized Devnet state…' : 'Reconciling ticket records against finalized Devnet state…')
    try {
      const response = await reconcileSolanaTickets({
        eventId,
        mode: 'scan',
        pageSize: 10,
        ticketId: options.ticketId,
        cursorAfter: options.ticketId ? null : options.cursorAfter ?? null,
      })
      const page = response.results.map(result => ({ ...result, scanRunId: response.runId }))
      setResults(current => options.reset ? page : [...current, ...page])
      if (!options.ticketId) {
        setCursor(response.nextCursor)
        setHasMore(response.hasMore)
      }
      setStatus(`Checked ${response.summary.checked} ticket${response.summary.checked === 1 ? '' : 's'}; ${response.summary.discrepancies} discrepancy${response.summary.discrepancies === 1 ? '' : 'ies'}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ticket reconciliation could not be completed.')
      setStatus('')
    } finally { setBusy(false) }
  }

  const repairPage = async (scanRunId: string, pageResults: DisplayResult[]) => {
    const safe = pageResults.filter(result => result.autoRepairSafe && result.classification !== 'IN_SYNC' && result.repairSucceeded !== true)
    if (!safe.length) return
    const confirmed = window.confirm(
      `Apply verified Devnet state to ${safe.length} Supabase ticket record${safe.length === 1 ? '' : 's'}? This will not send or modify any Solana transaction.`,
    )
    if (!confirmed) return
    setBusy(true); setError(''); setStatus(`Re-verifying ${safe.length} discrepancy${safe.length === 1 ? '' : 'ies'} before database repair…`)
    try {
      const response = await reconcileSolanaTickets({
        eventId,
        mode: 'repair',
        pageSize: safe.length,
        sourceRunId: scanRunId,
        items: safe.map(result => ({ ticketId: result.ticketId, sourceRunId: scanRunId })),
      })
      setResults(current => current.map(existing => {
        if (existing.scanRunId !== scanRunId) return existing
        const repaired = response.results.find(result => result.ticketId === existing.ticketId)
        return repaired ? { ...repaired, scanRunId, repairSucceeded: repaired.repairSucceeded } : existing
      }))
      setStatus(`${response.summary.repaired} ticket${response.summary.repaired === 1 ? '' : 's'} repaired; ${response.summary.manualReview} require manual review.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Database repair could not be completed.')
      setStatus('')
    } finally { setBusy(false) }
  }

  return <section className="organiser-panel reconciliation-panel" aria-labelledby="solana-reconciliation-title">
    <div className="panel-heading reconciliation-heading">
      <div><span className="tiny-label">DEVNET AUDIT</span><h2 id="solana-reconciliation-title">Blockchain reconciliation</h2></div>
      <button className="organiser-button" disabled={busy} onClick={() => { setResults([]); setCursor(null); void scan({ reset: true }) }}>
        {busy ? 'Working…' : results.length ? 'Start new scan' : 'Scan event tickets'}
      </button>
    </div>
    <p className="reconciliation-intro">Compare this event’s ticket records with independently verified, finalized Solana Devnet accounts. Scanning is read-only; database repairs require a separate confirmation.</p>
    <div className="reconciliation-stats" aria-live="polite">
      <div><span>Tickets checked</span><strong>{uniqueResults.length}</strong></div>
      <div><span>In sync</span><strong>{uniqueResults.filter(result => result.classification === 'IN_SYNC').length}</strong></div>
      <div><span>Discrepancies</span><strong>{uniqueResults.filter(result => result.classification !== 'IN_SYNC').length}</strong></div>
      <div><span>Repaired</span><strong>{uniqueResults.filter(result => result.repairSucceeded === true).length}</strong></div>
      <div><span>Manual review</span><strong>{uniqueResults.filter(result => result.classification === 'REQUIRES_MANUAL_REVIEW').length}</strong></div>
    </div>
    {status && <div className="reconciliation-status" role="status">{status}</div>}
    {error && <div className="form-error reconciliation-error" role="alert">{error}</div>}
    {!results.length && !busy && <p className="reconciliation-empty">No reconciliation results yet. Start an event scan to review a page of tickets.</p>}
    {pages.map(([runId, pageResults]) => {
      const repairable = pageResults.some(result => result.autoRepairSafe && result.classification !== 'IN_SYNC' && result.repairSucceeded !== true)
      return <div className="reconciliation-page" key={runId}>
        <div className="reconciliation-page-heading">
          <span>{pageResults.length} ticket{pageResults.length === 1 ? '' : 's'} · Scan {runId.slice(0, 8)}</span>
          {repairable && <button className="organiser-button organiser-button-primary" disabled={busy} onClick={() => void repairPage(runId, pageResults)}>Review &amp; repair safe records</button>}
        </div>
        <div className="reconciliation-results">
          {pageResults.map(result => <article className="reconciliation-result" key={`${runId}-${result.ticketId}`}>
            <div className="reconciliation-result-top">
              <span className={`reconciliation-badge reconciliation-${result.classification.toLowerCase()}`}>{labels[result.classification]}</span>
              <button className="reconciliation-recheck" disabled={busy || !result.ticketId} onClick={() => void scan({ ticketId: result.ticketId })}>Recheck ticket</button>
            </div>
            <strong>Ticket {result.ticketId || 'unavailable'}</strong>
            <p>{result.reason}</p>
            <div className="reconciliation-state-grid">
              <span>Database owner <b>{shortAddress(result.databaseState?.walletAddress)}</b></span>
              <span>Devnet owner <b>{shortAddress(result.verifiedChainState?.owner)}</b></span>
              <span>Database status <b>{result.databaseState?.status ?? 'No ticket row'}</b></span>
              <span>Chain state <b>{result.verifiedChainState ? `${result.verifiedChainState.valid ? 'valid' : 'invalid'} · ${result.verifiedChainState.checkedIn ? 'checked in' : 'not checked in'}` : 'Unavailable'}</b></span>
            </div>
            {result.transactionSignature && <small className="reconciliation-signature">Evidence signature: {shortAddress(result.transactionSignature)}</small>}
            {result.repairSucceeded === true && <small className="reconciliation-repaired">Database repair completed; chain state was not modified.</small>}
            {result.repairSucceeded === false && <small className="reconciliation-repair-failed">Database repair failed; no success was recorded.</small>}
          </article>)}
        </div>
      </div>
    })}
    {hasMore && <button className="organiser-button reconciliation-more" disabled={busy} onClick={() => void scan({ cursorAfter: cursor })}>Load next page</button>}
  </section>
}

function shortAddress(value: string | null | undefined) {
  if (!value) return '—'
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}
