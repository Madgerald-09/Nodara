import { AnchorProvider, Program, type Wallet } from '@coral-xyz/anchor'
import { Buffer } from 'buffer'
import { Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { WalletAccount } from '@wallet-standard/base'
import type { UiWallet } from '@wallet-standard/ui-core'
import { getWalletFeature } from '@wallet-standard/ui-features'
import type { NodaraTickets } from '../idl/nodara_tickets'
import { solanaConfigurationError, solanaProgramConfigurationError, solanaProgramId, solanaRpcUrl, solanaTicketIdl } from '../lib/solana'
import { supabase } from '../lib/supabase'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const PROGRAM_ID = new PublicKey(solanaProgramId ?? solanaTicketIdl.address)

export type ConnectedSolanaWallet = { account: WalletAccount; wallet: UiWallet }
export type PendingTicketTransfer = { ticketId: string; eventId: string; signature: string; senderWallet: string; recipientWallet: string; ticketAccount: string; eventAccount: string; receiptAccount: string }
export type TicketTransferResult = PendingTicketTransfer & { verified: true }

export class TransferVerificationPendingError extends Error {
  readonly transfer: PendingTicketTransfer
  constructor(message: string, transfer: PendingTicketTransfer) { super(message); this.name = 'TransferVerificationPendingError'; this.transfer = transfer }
}

export async function transferTicketOnDevnet(input: { ticketId: string; eventId: string; ticketAccount: string; eventAccount: string; senderWallet: string; recipientWallet: string; connected: ConnectedSolanaWallet }): Promise<TicketTransferResult> {
  if (!supabase) throw new Error('NODARA account services are not configured.')
  if (solanaConfigurationError) throw new Error(solanaConfigurationError)
  if (!solanaProgramId || solanaProgramConfigurationError) throw new Error(solanaProgramConfigurationError ?? 'The Devnet program is not configured.')
  const sender = parseKey(input.senderWallet, 'Reconnect the wallet that currently owns this ticket.')
  const recipient = parseKey(input.recipientWallet, 'Enter a valid recipient Solana wallet address.')
  if (sender.toBase58() !== input.connected.account.address) throw new Error('Connect the current on-chain ticket owner wallet before transferring.')
  if (recipient.equals(sender) || recipient.equals(PublicKey.default)) throw new Error('Choose a different, valid recipient wallet.')
  const connection = new Connection(solanaRpcUrl, 'confirmed')
  if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('Configured RPC is not Solana Devnet. No transaction was sent.')
  const wallet = makeAnchorWallet(input.connected, sender)
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' })
  const program = new Program<NodaraTickets>(solanaTicketIdl as NodaraTickets, provider)
  const eventId = uuidBytes(input.eventId)
  const ticketId = uuidBytes(input.ticketId)
  const [eventPda] = PublicKey.findProgramAddressSync([Buffer.from('event'), eventId], PROGRAM_ID)
  const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from('ticket'), eventPda.toBuffer(), ticketId], PROGRAM_ID)
  if (eventPda.toBase58() !== input.eventAccount || ticketPda.toBase58() !== input.ticketAccount) throw new Error('Stored event or ticket PDA does not match the Anchor program seeds.')
  const eventInfo = await connection.getAccountInfo(eventPda, 'confirmed')
  const ticketInfo = await connection.getAccountInfo(ticketPda, 'confirmed')
  if (!eventInfo || !ticketInfo || !eventInfo.owner.equals(PROGRAM_ID) || !ticketInfo.owner.equals(PROGRAM_ID)) throw new Error('This ticket is not registered under the deployed Devnet program.')
  const event = await program.account.eventRecord.fetch(eventPda)
  const ticket = await program.account.ticketRecord.fetch(ticketPda)
  if (!ticket.event.equals(eventPda) || !ticket.owner.equals(sender) || !ticket.valid || ticket.checkedIn) throw new Error('Connected wallet is not the owner of a valid, unchecked ticket.')
  if (!event.transfersAllowed) throw new Error('The event organiser has disabled ticket transfers on-chain.')

  const sequence = ticket.transferCount
  const sequenceSeed = Buffer.alloc(4)
  sequenceSeed.writeUInt32LE(sequence)
  const [receiptPda] = PublicKey.findProgramAddressSync([Buffer.from('transfer'), ticketPda.toBuffer(), sequenceSeed], PROGRAM_ID)
  if (await connection.getAccountInfo(receiptPda, 'confirmed')) throw new Error('This transfer sequence already has a receipt. Refresh the ticket before trying again.')
  const transaction = await program.methods.transferTicket([...ticketId])
    .accountsStrict({ currentOwner: sender, event: eventPda, ticket: ticketPda, recipient, receipt: receiptPda, systemProgram: SystemProgram.programId }).transaction()
  transaction.feePayer = sender
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const simulation = await connection.simulateTransaction(transaction, [])
  if (simulation.value.err) throw new Error(`Devnet simulation rejected this transfer: ${simulation.value.logs?.slice(-4).join(' ') || JSON.stringify(simulation.value.err)}`)
  const feeLamports = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')
  const fee = feeLamports.value === null ? 'unknown' : `${(feeLamports.value / 1_000_000_000).toFixed(6)} SOL`
  const approved = window.confirm(`Devnet simulation passed. Transfer ticket ${input.ticketId} from ${sender.toBase58()} to ${recipient.toBase58()}? The transfer is recorded on Solana and may not be reversible. The current owner pays the network fee (estimated ${fee}) and receipt-account rent. NODARA access will move to the recipient after verification and recipient wallet proof.`)
  if (!approved) throw new Error('Transfer cancelled. No wallet signature was requested.')

  let signature: string
  try { signature = await provider.sendAndConfirm(transaction, [], { commitment: 'confirmed', preflightCommitment: 'confirmed' }) }
  catch (error) { throw new Error(transferError(error), { cause: error }) }
  const pending: PendingTicketTransfer = { ticketId: input.ticketId, eventId: input.eventId, signature, senderWallet: sender.toBase58(), recipientWallet: recipient.toBase58(), ticketAccount: ticketPda.toBase58(), eventAccount: eventPda.toBase58(), receiptAccount: receiptPda.toBase58() }
  savePendingTransfer(pending)
  const verification = await verifyTicketTransfer(pending)
  if (!verification.verified) throw new TransferVerificationPendingError(`Transaction ${signature} confirmed, but NODARA has not synchronized ownership. ${verification.error}`, pending)
  return { ...pending, verified: true }
}

export async function verifyTicketTransfer(transfer: PendingTicketTransfer) {
  if (!supabase) return { verified: false, error: 'NODARA account services are not configured.' }
  const { data, error } = await supabase.functions.invoke('verify-solana-transfer', { body: transfer })
  if (data?.verified === true && !error) {
    clearPendingTransfer(transfer.ticketId)
    return { verified: true as const, error: null }
  }
  return { verified: false as const, error: data?.error ?? error?.message ?? 'Retry transfer verification.' }
}

export async function claimTransferredTicket(input: { ticketId: string; userId: string; connected: ConnectedSolanaWallet }) {
  if (!supabase) throw new Error('NODARA account services are not configured.')
  if (solanaConfigurationError) throw new Error(solanaConfigurationError)
  const wallet = input.connected.account.address
  const feature = getWalletFeature(input.connected.wallet, 'solana:signMessage') as { signMessage?: (input: { account: WalletAccount; message: Uint8Array }) => Promise<readonly { signature: Uint8Array; signedMessage: Uint8Array }[]> }
  if (!feature.signMessage) throw new Error('This wallet cannot sign the proof needed to claim a transferred ticket.')
  const message = claimMessage(input.ticketId, wallet, input.userId)
  const messageBytes = new TextEncoder().encode(message)
  const [signed] = await feature.signMessage({ account: input.connected.account, message: messageBytes })
  if (!signed?.signature) throw new Error('Wallet did not return a ticket claim signature.')
  if (!signed.signedMessage || signed.signedMessage.length !== messageBytes.length || signed.signedMessage.some((byte, index) => byte !== messageBytes[index])) throw new Error('Wallet signed a different claim message. No ticket was claimed.')
  const bytes = Array.from(signed.signature, byte => String.fromCharCode(byte)).join('')
  const signature = btoa(bytes)
  const { data, error } = await supabase.functions.invoke('claim-transferred-ticket', { body: { ticketId: input.ticketId, walletAddress: wallet, signature } })
  if (error || data?.claimed !== true) throw new Error(data?.error ?? error?.message ?? 'Ticket claim failed.')
  return true
}

export function loadPendingTransfer(ticketId: string): PendingTicketTransfer | null {
  try {
    const value = JSON.parse(localStorage.getItem(transferKey(ticketId)) || 'null') as PendingTicketTransfer | null
    return value?.ticketId === ticketId && value.signature ? value : null
  } catch { return null }
}
export function savePendingTransfer(transfer: PendingTicketTransfer) { try { localStorage.setItem(transferKey(transfer.ticketId), JSON.stringify(transfer)) } catch { /* Keep retry available on the current page. */ } }
export function clearPendingTransfer(ticketId: string) { try { localStorage.removeItem(transferKey(ticketId)) } catch { /* Ignore unavailable local storage. */ } }
export function buildTicketClaimMessage(ticketId: string, wallet: string, userId: string) { return `NODARA TRANSFER CLAIM v1\nTicket ID: ${ticketId}\nRecipient wallet: ${wallet}\nNODARA account: ${userId}\n` }

function claimMessage(ticketId: string, wallet: string, userId: string) { return buildTicketClaimMessage(ticketId, wallet, userId) }
function transferKey(ticketId: string) { return `nodara-devnet-transfer:${ticketId}` }
function uuidBytes(value: string) {
  const normalized = value.replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error('Ticket or event ID is not a valid UUID.')
  return Buffer.from(normalized, 'hex')
}
function parseKey(value: string, message: string) { try { return new PublicKey(value) } catch { throw new Error(message) } }
function makeAnchorWallet(connected: ConnectedSolanaWallet, publicKey: PublicKey): Wallet {
  const feature = getWalletFeature(connected.wallet, 'solana:signTransaction') as { signTransaction?: (...inputs: { account: WalletAccount; transaction: Uint8Array; chain: string }[]) => Promise<readonly { signedTransaction: Uint8Array }[]> }
  if (!feature.signTransaction) throw new Error('Connect a wallet that supports Devnet transaction signing.')
  const sign = async <T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> => {
    if (!(transaction instanceof Transaction)) throw new Error('This Anchor workflow currently accepts legacy transactions only.')
    const [signed] = await feature.signTransaction!({ account: connected.account, transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }), chain: 'solana:devnet' })
    if (!signed) throw new Error('Wallet did not return a signed transaction.')
    return Transaction.from(signed.signedTransaction) as T
  }
  return { publicKey, signTransaction: sign, signAllTransactions: async (transactions: Transaction[]) => Promise.all(transactions.map(sign)) } as unknown as Wallet
}
function transferError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/reject|declin|cancel/i.test(message)) return 'Wallet signature was rejected. No transfer was submitted.'
  if (/insufficient funds|not enough sol|fee payer|debit an account|insufficient lamports/i.test(message)) return 'This wallet needs more Devnet SOL for the transaction fee and transfer receipt rent.'
  if (/already in use|already been processed|custom program error/i.test(message)) return 'This ticket transfer could not be applied. Refresh the ticket and check its current Devnet owner.'
  if (/timeout|blockhash|rpc|failed to fetch|network/i.test(message)) return 'Devnet RPC could not confirm the transfer. Check wallet activity before retrying.'
  return `Devnet transfer failed: ${message}`
}
