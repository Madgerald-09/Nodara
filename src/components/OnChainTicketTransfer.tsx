import { useState } from 'react'
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'
import type { TicketView } from '../services/bookingService'
import type { PendingTicketTransfer } from '../services/onChainTicketTransfer'

export function OnChainTicketTransfer({ ticket, onTransferred }: { ticket: TicketView; onTransferred: (notice: string) => void }) {
  const connected = useConnectedWallet(useClient() as ClientWithWallet)
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<PendingTicketTransfer | null>(() => readPending(ticket.ticket_id))
  if (ticket.blockchain_status !== 'verified' || ticket.ticket_status !== 'issued' || !ticket.wallet_address) return null

  const transfer = async () => {
    if (!connected?.signer) { setError('Connect the current ticket owner wallet first.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const service = await import('../services/onChainTicketTransfer')
      const result = await service.transferTicketOnDevnet({
        ticketId: ticket.ticket_id, eventId: ticket.event_id, ticketAccount: ticket.solana_ticket_account ?? '',
        eventAccount: ticket.solana_event_account ?? '', senderWallet: ticket.wallet_address!, recipientWallet: recipient.trim(),
        connected: connected as unknown as Parameters<typeof service.transferTicketOnDevnet>[0]['connected'],
      })
      onTransferred(`Transfer verified on Devnet · ${result.signature}. Share ticket ID ${ticket.ticket_id} with the recipient so they can claim it in My tickets.`)
      setPending(null)
    } catch (cause) {
      if (cause instanceof (await import('../services/onChainTicketTransfer')).TransferVerificationPendingError) {
        setPending(cause.transfer)
        setError(cause.message)
      } else setError(cause instanceof Error ? cause.message : 'Ticket transfer failed.')
    } finally { setBusy(false) }
  }

  const retry = async () => {
    if (!pending) return
    setBusy(true); setError('')
    const result = await (await import('../services/onChainTicketTransfer')).verifyTicketTransfer(pending)
    setBusy(false)
    if (!result.verified) { setError(result.error ?? 'Transfer verification is still pending.'); return }
    setPending(null)
    onTransferred(`Transfer verified. Share ticket ID ${ticket.ticket_id} with the recipient to claim it.`)
  }

  if (pending) return <div className="chain-transfer-control"><small className="form-error" role="alert">{error || `Devnet transaction ${pending.signature} is awaiting server verification.`}</small><button type="button" className="organiser-quiet" disabled={busy} onClick={() => void retry()}>{busy ? 'Verifying…' : 'Retry transfer verification'}</button></div>
  return <div className="chain-transfer-control">
    <label>Recipient public Solana wallet<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="Recipient wallet address" disabled={busy}/></label>
    <small>Transfers are recorded on Solana and may not be reversible. Only the current on-chain owner can sign.</small>
    <button type="button" className="organiser-quiet" disabled={busy || !connected?.signer} onClick={() => void transfer()}>{busy ? 'Simulating / confirming…' : !connected?.signer ? 'Connect current owner wallet' : 'Transfer ticket'}</button>
    {message && <small className="form-success" role="status">{message}</small>}
    {error && <small className="form-error" role="alert">{error}</small>}
  </div>
}

function readPending(ticketId: string): PendingTicketTransfer | null {
  try {
    const pending = JSON.parse(localStorage.getItem(`nodara-devnet-transfer:${ticketId}`) || 'null') as PendingTicketTransfer | null
    return pending?.ticketId === ticketId && pending.signature ? pending : null
  } catch { return null }
}
