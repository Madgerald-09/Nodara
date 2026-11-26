import { useConnectedWallet, useConnect, useDisconnect, useWalletStatus, useWallets } from '@solana/kit-plugin-wallet/react'
import { useClient } from '@solana/react'
import type { ClientWithWallet } from '@solana/kit-plugin-wallet'

export function SolanaWalletControl() {
  const [actionError, setActionError] = useState('')
  const client = useClient() as ClientWithWallet
  const wallets = useWallets(client)
  const connected = useConnectedWallet(client)
  const status = useWalletStatus(client)
  const connect = useConnect(client)
  const disconnect = useDisconnect(client)

  if (connected) {
    return <div className="solana-wallet-control" aria-live="polite">
      <span title={connected.account.address}>Devnet · {connected.account.address.slice(0, 4)}…{connected.account.address.slice(-4)}</span>
      <button type="button" className="organiser-quiet" disabled={disconnect.isRunning} onClick={() => { setActionError(''); void disconnect.dispatchAsync().catch(() => setActionError('Could not disconnect this wallet. Try again.')) }}>
        {disconnect.isRunning ? 'Disconnecting…' : 'Disconnect wallet'}
      </button>
      {actionError && <small role="alert">{actionError}</small>}
    </div>
  }

  return <div className="solana-wallet-control">
    <label className="sr-only" htmlFor="solana-wallet-select">Choose a Solana wallet</label>
    <select id="solana-wallet-select" aria-label="Choose a Solana wallet" disabled={status === 'pending' || connect.isRunning} defaultValue="" onChange={event => {
      const wallet = wallets.find(item => item.name === event.target.value)
      if (wallet) {
        setActionError('')
        void connect.dispatchAsync(wallet).catch(() => setActionError('Wallet connection was not completed. Check the wallet and try again.'))
      }
      event.currentTarget.value = ''
    }}>
      <option value="">{status === 'pending' ? 'Checking wallet…' : connect.isRunning ? 'Connecting…' : wallets.length ? 'Connect Devnet wallet' : 'No compatible wallet found'}</option>
      {wallets.map(wallet => <option key={wallet.name} value={wallet.name}>{wallet.name}</option>)}
    </select>
    {actionError && <small role="alert">{actionError}</small>}
  </div>
}
import { useState } from 'react'
