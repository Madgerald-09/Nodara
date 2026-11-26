import { createClient, type DevnetUrl } from '@solana/kit'
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc'
import { walletSigner } from '@solana/kit-plugin-wallet'
import ticketIdl from '../idl/nodara_tickets.json'

export const solanaTicketIdl = ticketIdl
export const solanaDeployedProgramId = ticketIdl.address

const defaultDevnetRpc = 'https://api.devnet.solana.com'
const configuredRpc = import.meta.env.VITE_SOLANA_RPC_URL?.trim() || defaultDevnetRpc
function validateRpcUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || /mainnet|testnet/i.test(parsed.hostname)) return 'Solana RPC must be an HTTPS Devnet endpoint.'
    return null
  } catch {
    return 'VITE_SOLANA_RPC_URL must be a valid HTTPS Devnet endpoint.'
  }
}

export const solanaConfigurationError = validateRpcUrl(configuredRpc)
const safeRpcUrl = solanaConfigurationError ? defaultDevnetRpc : configuredRpc

export const solanaNetwork = 'devnet' as const
export const solanaRpcUrl = safeRpcUrl
const configuredProgramId = import.meta.env.VITE_SOLANA_PROGRAM_ID?.trim() || solanaDeployedProgramId
export const solanaProgramId = configuredProgramId === solanaDeployedProgramId && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(configuredProgramId)
  ? configuredProgramId
  : null
export const solanaProgramConfigurationError = solanaProgramId
  ? null
  : 'The configured program ID does not match the deployed Devnet program in the bundled IDL.'

// Wallet Standard handles discovery and reconnect for wallets such as Phantom and Solflare.
export const solanaClient = createClient()
  .use(walletSigner({ chain: 'solana:devnet' }))
  .use(solanaDevnetRpc({ rpcUrl: safeRpcUrl as DevnetUrl }))
