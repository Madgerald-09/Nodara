import { AnchorProvider, Program, type Wallet } from '@coral-xyz/anchor'
import { Buffer } from 'buffer'
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { WalletAccount } from '@wallet-standard/base'
import type { UiWallet } from '@wallet-standard/ui-core'
import { getWalletFeature } from '@wallet-standard/ui-features'
import type { NodaraTickets } from '../idl/nodara_tickets'
import { solanaConfigurationError, solanaProgramConfigurationError, solanaProgramId, solanaRpcUrl, solanaTicketIdl } from '../lib/solana'
import { supabase } from '../lib/supabase'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const PROGRAM_ID = new PublicKey(solanaProgramId ?? solanaTicketIdl.address)
export type CheckInWallet = { account: WalletAccount; wallet: UiWallet }
export type PendingOnChainCheckIn = { ticketId: string; eventId: string; signature: string; organizerWallet: string; ticketAccount: string; eventAccount: string }

export class CheckInVerificationPendingError extends Error {
  readonly pending: PendingOnChainCheckIn
  constructor(message: string, pending: PendingOnChainCheckIn) { super(message); this.name = 'CheckInVerificationPendingError'; this.pending = pending }
}

export async function checkInTicketOnDevnet(input: {
  ticketId: string; eventId: string; expectedTicketAccount: string; expectedEventAccount: string;
  eventTitle: string; ticketHolder: string; organizer: CheckInWallet; onStage?: (stage: string) => void
}) {
  if (!supabase) throw new Error('NODARA account services are not configured.')
  if (solanaConfigurationError) throw new Error(solanaConfigurationError)
  if (!solanaProgramId || solanaProgramConfigurationError) throw new Error(solanaProgramConfigurationError ?? 'The Devnet program is not configured.')
  const organizerKey = new PublicKey(input.organizer.account.address)
  const eventId = uuidBytes(input.eventId)
  const ticketId = uuidBytes(input.ticketId)
  const [eventPda] = PublicKey.findProgramAddressSync([Buffer.from('event'), eventId], PROGRAM_ID)
  const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from('ticket'), eventPda.toBuffer(), ticketId], PROGRAM_ID)
  if (eventPda.toBase58() !== input.expectedEventAccount || ticketPda.toBase58() !== input.expectedTicketAccount) throw new Error('Ticket metadata does not match the on-chain event and ticket PDA seeds.')

  const connection = new Connection(solanaRpcUrl, 'confirmed')
  if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('Configured RPC is not Solana Devnet.')
  const [eventInfo, ticketInfo] = await Promise.all([connection.getAccountInfo(eventPda, 'confirmed'), connection.getAccountInfo(ticketPda, 'confirmed')])
  if (!eventInfo || !ticketInfo || !eventInfo.owner.equals(PROGRAM_ID) || !ticketInfo.owner.equals(PROGRAM_ID)) throw new Error('Event or ticket account is missing from the deployed Devnet program.')
  const wallet = makeAnchorWallet(input.organizer, organizerKey)
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' })
  const program = new Program<NodaraTickets>(solanaTicketIdl as NodaraTickets, provider)
  const event = await program.account.eventRecord.fetch(eventPda)
  const ticket = await program.account.ticketRecord.fetch(ticketPda)
  if (!Buffer.from(event.eventId).equals(eventId) || !event.organizer.equals(organizerKey)) throw new Error('Connected wallet is not authorized as the organiser of this on-chain event.')
  if (!Buffer.from(ticket.ticketId).equals(ticketId) || !ticket.event.equals(eventPda)) throw new Error('On-chain ticket identity does not match the scanned NODARA ticket.')
  if (!ticket.valid) throw new Error('This ticket has been invalidated on-chain.')
  if (ticket.checkedIn) throw new Error('This ticket has already been checked in on-chain.')

  const transaction = await program.methods.checkInTicket([...ticketId]).accountsStrict({ organizer: organizerKey, event: eventPda, ticket: ticketPda }).transaction()
  transaction.feePayer = organizerKey
  const lifetime = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = lifetime.blockhash
  const simulation = await connection.simulateTransaction(transaction, [])
  if (simulation.value.err) throw new Error(`Devnet simulation rejected check-in: ${simulation.value.logs?.slice(-4).join(' ') || JSON.stringify(simulation.value.err)}`)
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')
  const feeLabel = fee.value === null ? 'unknown' : `${(fee.value / 1_000_000_000).toFixed(6)} SOL`
  if (!window.confirm(`Simulation passed. Check in ${input.ticketHolder} for “${input.eventTitle}” on Solana Devnet? This is recorded on-chain and cannot be undone. The organiser wallet pays the network fee (estimated ${feeLabel}).`)) throw new Error('Check-in cancelled. No wallet signature was requested.')

  let signature: string
  try {
    input.onStage?.('Awaiting organiser wallet signature…')
    const signed = await provider.wallet.signTransaction(transaction)
    input.onStage?.('Confirming transaction on Solana Devnet…')
    signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
    const confirmation = await connection.confirmTransaction({ signature, blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }, 'confirmed')
    if (confirmation.value.err) throw new Error(`Devnet rejected check-in: ${JSON.stringify(confirmation.value.err)}`)
  } catch (error) { throw new Error(checkInError(error), { cause: error }) }
  const pending: PendingOnChainCheckIn = { ticketId: input.ticketId, eventId: input.eventId, signature, organizerWallet: organizerKey.toBase58(), ticketAccount: ticketPda.toBase58(), eventAccount: eventPda.toBase58() }
  savePending(pending)
  input.onStage?.('Verifying confirmed check-in with NODARA…')
  const result = await verifyOnChainCheckIn(pending)
  if (!result.verified) throw new CheckInVerificationPendingError(`Transaction ${signature} confirmed, but the server has not synchronized attendance. ${result.error}`, pending)
  return pending
}

export async function verifyOnChainCheckIn(pending: PendingOnChainCheckIn) {
  if (!supabase) return { verified: false, error: 'NODARA account services are not configured.' }
  const { data, error } = await supabase.functions.invoke('verify-solana-check-in', { body: pending })
  if (data?.verified === true && !error) { clearPending(pending.ticketId); return { verified: true as const, error: null } }
  return { verified: false as const, error: data?.error ?? error?.message ?? 'Retry check-in verification.' }
}

export function getPendingOnChainCheckIn(ticketId: string): PendingOnChainCheckIn | null {
  try { const row = JSON.parse(localStorage.getItem(storageKey(ticketId)) || 'null') as PendingOnChainCheckIn | null; return row?.ticketId === ticketId && row.signature ? row : null }
  catch { return null }
}
function savePending(row: PendingOnChainCheckIn) { try { localStorage.setItem(storageKey(row.ticketId), JSON.stringify(row)) } catch { /* Retry remains possible during the current page visit. */ } }
function clearPending(ticketId: string) { try { localStorage.removeItem(storageKey(ticketId)) } catch { /* Ignore unavailable storage. */ } }
function storageKey(ticketId: string) { return `nodara-devnet-checkin:${ticketId}` }
function uuidBytes(value: string) {
  const normalized = value.replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error('Ticket or event identifier is invalid.')
  return Buffer.from(normalized, 'hex')
}
function makeAnchorWallet(connected: CheckInWallet, publicKey: PublicKey): Wallet {
  const feature = getWalletFeature(connected.wallet, 'solana:signTransaction') as { signTransaction?: (input: { account: WalletAccount; transaction: Uint8Array; chain: string }) => Promise<readonly { signedTransaction: Uint8Array }[]> }
  if (!feature.signTransaction) throw new Error('Connect a wallet that supports Devnet transaction signing.')
  const sign = async <T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> => {
    if (!(transaction instanceof Transaction)) throw new Error('This Anchor check-in currently accepts legacy transactions only.')
    const [signed] = await feature.signTransaction!({ account: connected.account, transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }), chain: 'solana:devnet' })
    if (!signed) throw new Error('Wallet did not return a signed transaction.')
    return Transaction.from(signed.signedTransaction) as T
  }
  return { publicKey, signTransaction: sign, signAllTransactions: async (transactions: Transaction[]) => Promise.all(transactions.map(sign)) } as unknown as Wallet
}
function checkInError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/reject|declin|cancel/i.test(message)) return 'Wallet signature was rejected. No check-in was submitted.'
  if (/insufficient funds|not enough sol|fee payer|debit an account|insufficient lamports/i.test(message)) return 'The organiser wallet needs more Devnet SOL to pay the check-in fee.'
  if (/alreadycheckedin|already been checked in/i.test(message)) return 'This ticket has already been checked in on-chain.'
  if (/invalidticket/i.test(message)) return 'This ticket has been invalidated on-chain.'
  if (/timeout|blockhash|rpc|failed to fetch|network/i.test(message)) return 'Devnet RPC could not confirm check-in. Check wallet activity before retrying.'
  return `Devnet check-in failed: ${message}`
}
