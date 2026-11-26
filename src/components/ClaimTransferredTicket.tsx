import { useState } from 'react'
import type { FormEvent } from 'react'
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'

export function ClaimTransferredTicket({ userId, onClaimed }: { userId: string; onClaimed: () => void }) {
  const connected = useConnectedWallet(useClient() as ClientWithWallet)
  const [ticketId, setTicketId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const claim = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage('')
    if (!connected?.signer) { setError('Connect the recipient wallet first.'); return }
    setBusy(true)
    try {
      await (await import('../services/onChainTicketTransfer')).claimTransferredTicket({
        ticketId: ticketId.trim(), userId,
        connected: connected as unknown as Parameters<(typeof import('../services/onChainTicketTransfer'))['claimTransferredTicket']>[0]['connected'],
      })
      setMessage('Ticket claimed. It will appear in your ticket list after refresh.')
      setTicketId('')
      onClaimed()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ticket claim failed.') }
    finally { setBusy(false) }
  }
  return <section className="organiser-panel transferred-ticket-claim">
    <span className="tiny-label">CLAIM A TRANSFER</span><h2>Ticket sent to your wallet?</h2>
    <p>Enter the ticket ID shared by its sender, connect the recipient wallet and sign a message proving you control it. Message signing does not pay a network fee.</p>
    <form onSubmit={event => void claim(event)}>
      <label>Ticket ID<input value={ticketId} onChange={event => setTicketId(event.target.value)} placeholder="Ticket UUID" required disabled={busy}/></label>
      <button className="organiser-button organiser-button-primary" disabled={busy || !connected?.signer}>{busy ? 'Checking transfer…' : !connected?.signer ? 'Connect recipient wallet' : 'Sign and claim ticket'}</button>
    </form>
    {message && <div className="form-success" role="status">{message}</div>}{error && <div className="form-error" role="alert">{error}</div>}
  </section>
}
