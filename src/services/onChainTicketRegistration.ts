import { AnchorProvider, Program, type Wallet } from '@coral-xyz/anchor'
import { Buffer } from 'buffer'
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { VersionedTransaction } from '@solana/web3.js'
import type { WalletAccount } from '@wallet-standard/base'
import type { UiWallet } from '@wallet-standard/ui-core'
import { getWalletFeature } from '@wallet-standard/ui-features'
import type { NodaraTickets } from '../idl/nodara_tickets'
import { solanaConfigurationError, solanaProgramConfigurationError, solanaProgramId, solanaRpcUrl, solanaTicketIdl } from '../lib/solana'
import { supabase } from '../lib/supabase'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const PROGRAM_ID = new PublicKey(solanaProgramId ?? solanaTicketIdl.address)

export type ChainRegistrationResult = {
  signature: string
  eventAccount: string
  ticketAccount: string
  verified: true
}
export type PendingTicketRegistration = Omit<ChainRegistrationResult, 'verified'> & { eventId: string; ticketId: string; organizerWallet: string; ownerWallet: string }

export class RegistrationVerificationPendingError extends Error {
  readonly registration: PendingTicketRegistration
  constructor(message: string, registration: PendingTicketRegistration) {
    super(message)
    this.name = 'RegistrationVerificationPendingError'
    this.registration = registration
  }
}

export async function registerExistingTicketOnDevnet(input: {
  eventId: string
  ticketId: string
  initialOwner: string
  connected: {
    account: WalletAccount
    wallet: UiWallet
  }
}): Promise<ChainRegistrationResult> {
  if (!supabase) throw new Error('NODARA account services are not configured.')
  if (solanaConfigurationError) throw new Error(solanaConfigurationError)
  if (solanaProgramConfigurationError || !solanaProgramId) throw new Error(solanaProgramConfigurationError ?? 'The Devnet program is not configured.')
  const owner = parsePublicKey(input.initialOwner, 'Enter the attendee’s valid Solana wallet address.')
  const organizer = parsePublicKey(input.connected.account.address, 'Reconnect your Solana wallet and try again.')
  const connection = new Connection(solanaRpcUrl, 'confirmed')
  if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('The RPC endpoint is not Solana Devnet. No transaction was sent.')

  const signFeature = getWalletFeature(input.connected.wallet, 'solana:signTransaction') as {
    signTransaction?: (...args: { account: WalletAccount; transaction: Uint8Array; chain: string }[]) => Promise<readonly { signedTransaction: Uint8Array }[]>
  }
  if (!signFeature?.signTransaction) throw new Error('This wallet cannot sign transactions. Connect a transaction-signing Devnet wallet.')
  const signLegacy = async <T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> => {
    if (!(transaction instanceof Transaction)) throw new Error('This wallet workflow currently supports legacy transactions only.')
    const sign = signFeature.signTransaction
    if (!sign) throw new Error('This wallet cannot sign transactions.')
    const [signed] = await sign({
      account: input.connected.account,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
      chain: 'solana:devnet',
    })
    if (!signed) throw new Error('The wallet did not return a signed transaction.')
    return Transaction.from(signed.signedTransaction) as T
  }
  const wallet = {
    publicKey: organizer,
    signTransaction: signLegacy,
    signAllTransactions: async (transactions: Transaction[]) => Promise.all(transactions.map(signLegacy)),
  } as unknown as Wallet
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' })
  const program = new Program<NodaraTickets>(solanaTicketIdl as NodaraTickets, provider)
  const eventId = uuidBytes(input.eventId)
  const ticketId = uuidBytes(input.ticketId)
  const [eventPda] = PublicKey.findProgramAddressSync([Buffer.from('event'), eventId], PROGRAM_ID)
  const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from('ticket'), eventPda.toBuffer(), ticketId], PROGRAM_ID)
  const existingTicket = await connection.getAccountInfo(ticketPda, 'confirmed')
  if (existingTicket) throw new Error('This ticket already has an on-chain registration. Refresh the attendee list.')

  const transaction = new Transaction()
  const existingEvent = await connection.getAccountInfo(eventPda, 'confirmed')
  if (existingEvent) {
    if (!existingEvent.owner.equals(PROGRAM_ID)) throw new Error('The event PDA is owned by an unexpected program.')
    const eventRecord = await program.account.eventRecord.fetch(eventPda)
    if (!eventRecord.organizer.equals(organizer)) throw new Error('This event is already registered by a different Solana wallet.')
  } else {
    const approved = window.confirm(`Register this ticket on Devnet? The ticket will be assigned to ${owner.toBase58()}. This NODARA release does not provide ticket transfers. This is also the first registration for this event, so the connected organiser wallet will be permanently recorded as its on-chain organiser. Devnet fees apply.`)
    if (!approved) throw new Error('Registration cancelled. No wallet request was sent.')
    transaction.add(await program.methods.createEvent([...eventId], false)
      .accountsStrict({ organizer, event: eventPda, systemProgram: SystemProgram.programId }).instruction())
  }
  if (existingEvent && !window.confirm(`Register this ticket on Devnet? It will be assigned to ${owner.toBase58()}. This NODARA release does not provide ticket transfers. Devnet fees apply.`)) {
    throw new Error('Registration cancelled. No wallet request was sent.')
  }
  transaction.add(await program.methods.registerTicket([...ticketId])
    .accountsStrict({ organizer, event: eventPda, initialOwner: owner, ticket: ticketPda, systemProgram: SystemProgram.programId }).instruction())

  let signature: string
  try {
    signature = await provider.sendAndConfirm(transaction, [], { commitment: 'confirmed', preflightCommitment: 'confirmed' })
  } catch (error) {
    throw new Error(walletTransactionError(error), { cause: error })
  }

  const registration = { signature, eventAccount: eventPda.toBase58(), ticketAccount: ticketPda.toBase58(), eventId: input.eventId, ticketId: input.ticketId, organizerWallet: organizer.toBase58(), ownerWallet: owner.toBase58() }
  savePendingTicketRegistration(registration)
  const verification = await verifyTicketRegistration(registration)
  if (!verification.verified) throw new RegistrationVerificationPendingError(`The transaction was confirmed (${signature}), but server verification did not complete. It remains unregistered in NODARA. ${verification.error}`, registration)
  return { signature, eventAccount: eventPda.toBase58(), ticketAccount: ticketPda.toBase58(), verified: true }
}

export async function verifyTicketRegistration(registration: PendingTicketRegistration) {
  if (!supabase) return { verified: false, error: 'NODARA account services are not configured.' }
  const { data, error } = await supabase.functions.invoke('verify-solana-ticket', {
    body: { eventId: registration.eventId, ticketId: registration.ticketId, ownerWallet: registration.ownerWallet, organizerWallet: registration.organizerWallet, signature: registration.signature },
  })
  if (data?.verified === true && !error) {
    clearPendingTicketRegistration(registration.ticketId)
    return { verified: true as const, error: null }
  }
  return { verified: false as const, error: data?.error ?? error?.message ?? 'Retry verification from this ticket.' }
}

const pendingStorageKey = (ticketId: string) => `nodara-devnet-registration:${ticketId}`
export function savePendingTicketRegistration(registration: PendingTicketRegistration) {
  try { localStorage.setItem(pendingStorageKey(registration.ticketId), JSON.stringify(registration)) } catch { /* Verification remains retryable while this page is open. */ }
}
export function loadPendingTicketRegistration(ticketId: string): PendingTicketRegistration | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingStorageKey(ticketId)) || 'null') as PendingTicketRegistration | null
    return parsed?.eventId === undefined || parsed.ticketId !== ticketId || !parsed.signature ? null : parsed
  } catch { return null }
}
export function clearPendingTicketRegistration(ticketId: string) {
  try { localStorage.removeItem(pendingStorageKey(ticketId)) } catch { /* Ignore unavailable local storage. */ }
}

function uuidBytes(value: string) {
  const normalized = value.replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error('The ticket or event ID is not a valid UUID.')
  return Buffer.from(normalized, 'hex')
}

function parsePublicKey(value: string, message: string) {
  try { return new PublicKey(value) } catch { throw new Error(message) }
}

function walletTransactionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/reject|declin|cancel/i.test(message)) return 'Wallet signature was rejected. No registration was submitted.'
  if (/insufficient funds|not enough sol|fee payer/i.test(message)) return 'This organiser wallet needs Devnet SOL to pay the network fee and create the ticket account.'
  if (/already in use|custom program error/i.test(message)) return 'The ticket may already be registered. Refresh the attendee list and check Devnet before retrying.'
  if (/timeout|blockhash|rpc|failed to fetch|network/i.test(message)) return 'Devnet RPC could not confirm the transaction. Check the wallet activity before retrying.'
  return `Devnet registration failed: ${message}`
}
