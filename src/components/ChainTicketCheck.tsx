import { useState } from 'react'
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'
import { verifyChainTicket, type ChainTicketResult } from '../services/solanaService'

export function ChainTicketCheck({ ticketId, eventId, accountAddress, eventAccountAddress }: { ticketId: string; eventId: string; accountAddress: string | null; eventAccountAddress: string | null }) {
  const connected = useConnectedWallet(useClient() as ClientWithWallet)
  const [result, setResult] = useState<ChainTicketResult | null>(null)
  const [checking, setChecking] = useState(false)
  const verify = async () => {
    setChecking(true)
    setResult(await verifyChainTicket({ ticketId, eventId, accountAddress, eventAccountAddress, connectedWallet: connected?.account.address ?? null }))
    setChecking(false)
  }
  return <div className="chain-ticket-check">
    <button type="button" className="organiser-quiet" onClick={() => void verify()} disabled={checking}>
      {checking ? 'Checking Devnet…' : result?.verified ? 'Verified on Devnet' : 'Check on Devnet'}
    </button>
    {result && <small className={result.verified ? 'form-success' : 'form-error'} role="status">
      {result.verified ? `Verified · owner ${result.owner}${result.checkedIn ? ' · checked in' : ''}` : result.error}
    </small>}
  </div>
}
