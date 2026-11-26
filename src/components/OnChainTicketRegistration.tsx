import { useEffect, useState } from 'react'
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'
import { getTicketChainInfo } from '../services/bookingService'
import type { PendingTicketRegistration } from '../services/onChainTicketRegistration'

const pendingKey = (id: string) => `nodara-devnet-registration:${id}`
function loadPending(id: string): PendingTicketRegistration | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingKey(id)) || 'null') as PendingTicketRegistration | null
    return parsed?.ticketId === id && parsed.signature ? parsed : null
  } catch { return null }
}

export function OnChainTicketRegistration({ eventId, ticketId, ticketStatus }: { eventId: string; ticketId: string; ticketStatus: string }) {
  const connected = useConnectedWallet(useClient() as ClientWithWallet)
  const [ownerWallet, setOwnerWallet] = useState('')
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [registered, setRegistered] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingVerification, setPendingVerification] = useState<PendingTicketRegistration | null>(() => loadPending(ticketId))

  useEffect(() => {
    let active = true
    void getTicketChainInfo(eventId, ticketId).then(result => {
      if (!active) return
      if (result.ticket?.blockchain_status === 'verified' && result.ticket.solana_ticket_account) {
        setRegistered(true)
        localStorage.removeItem(pendingKey(ticketId))
        setPendingVerification(null)
      }
      if (result.error) setStatusError(`Could not check the ticket’s registration status: ${result.error}`)
      setLoadingStatus(false)
    })
    return () => { active = false }
  }, [eventId, ticketId])

  const register = async () => {
    if (!connected?.signer) { setError('Connect a Devnet wallet that can sign transactions first.'); return }
    if (ticketStatus !== 'issued') { setError('Only an issued ticket from a confirmed booking can be registered.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const service = await import('../services/onChainTicketRegistration')
      const result = await service.registerExistingTicketOnDevnet({ eventId, ticketId, initialOwner: ownerWallet.trim(), connected: connected as unknown as Parameters<typeof service.registerExistingTicketOnDevnet>[0]['connected'] })
      setRegistered(true)
      setMessage(`Verified on Devnet · transaction ${result.signature} · ticket account ${result.ticketAccount} · event account ${result.eventAccount}`)
    } catch (cause) {
      if (cause instanceof (await import('../services/onChainTicketRegistration')).RegistrationVerificationPendingError) {
        setPendingVerification(cause.registration)
        setError(cause.message)
      } else setError(cause instanceof Error ? cause.message : 'Ticket registration failed.')
    } finally { setBusy(false) }
  }

  const retryVerification = async () => {
    if (!pendingVerification) return
    setBusy(true); setError('')
    const result = await (await import('../services/onChainTicketRegistration')).verifyTicketRegistration(pendingVerification)
    setBusy(false)
    if (!result.verified) { setError(`Still waiting for trusted verification. ${result.error}`); return }
    setRegistered(true)
    localStorage.removeItem(pendingKey(ticketId))
    setMessage(`Verified on Devnet · transaction ${pendingVerification.signature} · ticket account ${pendingVerification.ticketAccount} · event account ${pendingVerification.eventAccount}`)
    setPendingVerification(null)
  }

  if (loadingStatus) return <small>Checking Devnet registration…</small>
  if (registered) return <small className="form-success">Registered and verified on Devnet.</small>
  if (statusError) return <small className="form-error" role="alert">{statusError} Registration is disabled until this check succeeds.</small>
  if (pendingVerification) return <div className="onchain-register-state"><small className="form-error" role="alert">{error}</small><button className="organiser-quiet" type="button" disabled={busy} onClick={() => void retryVerification()}>{busy ? 'Verifying…' : 'Retry server verification'}</button></div>

  return <div className="onchain-register-control">
    <label>Attendee Solana wallet
      <input aria-label={`Attendee wallet for ticket ${ticketId}`} value={ownerWallet} onChange={event => setOwnerWallet(event.target.value)} placeholder="Public wallet address" disabled={busy || registered}/>
    </label>
    <button type="button" className="organiser-quiet" disabled={busy || !connected?.signer || ticketStatus !== 'issued'} onClick={() => void register()}>
      {busy ? 'Waiting for Devnet…' : !connected?.signer ? 'Connect organiser wallet above' : 'Register on Devnet'}
    </button>
    <small>The entered wallet becomes the on-chain owner. NODARA does not yet verify that the attendee controls it. Ask only for a public address; never request a seed phrase or private key.</small>
    {message && <small className="form-success" role="status">{message}</small>}
    {error && <small className="form-error" role="alert">{error}</small>}
  </div>
}
