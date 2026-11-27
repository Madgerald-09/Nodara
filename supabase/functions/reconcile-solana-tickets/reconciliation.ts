import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const PROGRAM_ID = 'CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf'
export const ACCOUNT_DISCRIMINATORS = {
  event: Uint8Array.from([150, 209, 156, 235, 9, 198, 56, 184]),
  ticket: Uint8Array.from([37, 215, 102, 48, 114, 66, 21, 87]),
  receipt: Uint8Array.from([166, 220, 49, 50, 221, 185, 59, 55]),
}
export const INSTRUCTION_DISCRIMINATORS = {
  createEvent: Uint8Array.from([49, 219, 29, 203, 22, 98, 100, 87]),
  registerTicket: Uint8Array.from([109, 13, 236, 88, 213, 108, 159, 122]),
  checkIn: Uint8Array.from([174, 66, 18, 131, 231, 120, 103, 246]),
  transfer: Uint8Array.from([191, 184, 74, 239, 164, 172, 188, 32]),
  invalidate: Uint8Array.from([198, 216, 170, 163, 66, 251, 2, 51]),
}
export const EVENT_ACCOUNT_SIZE = 58
export const TICKET_ACCOUNT_SIZE = 127
export const TRANSFER_RECEIPT_ACCOUNT_SIZE = 109
export const MAX_TRANSFER_HISTORY = 64
export const RPC_TIMEOUT_MS = 8_000

export type DiscrepancyClassification =
  | 'IN_SYNC'
  | 'MISSING_ON_CHAIN'
  | 'MISSING_IN_DATABASE'
  | 'OWNER_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'TRANSFER_HISTORY_MISMATCH'
  | 'CHECKIN_MISMATCH'
  | 'INVALID_ACCOUNT'
  | 'PENDING_CONFIRMATION'
  | 'RPC_UNAVAILABLE'
  | 'REQUIRES_MANUAL_REVIEW'

export type TransferState = {
  sequence: number
  receiptAccount: string
  fromWallet: string
  toWallet: string
  signature: string
}

export type DatabaseTicketState = {
  status: string
  blockchainStatus: string
  network: string | null
  programId: string | null
  ticketAccount: string | null
  eventAccount: string | null
  registrationSignature: string | null
  walletAddress: string | null
  ticketValid: boolean | null
  checkedIn: boolean | null
  transferCount: number | null
  checkedInAt: string | null
  checkedInBy: string | null
  checkInSignature: string | null
  transferHistory: {
    sequence: number | null
    receiptAccount: string | null
    fromWallet: string
    toWallet: string
    signature: string
  }[]
}

export type VerifiedChainState = {
  network: 'devnet'
  programId: string
  eventAccount: string
  ticketAccount: string
  eventId: string
  ticketId: string
  organizer: string
  issuer: string
  initialOwner: string
  owner: string
  valid: boolean
  checkedIn: boolean
  transferCount: number
  transferHistory: TransferState[]
  registrationSignature: string
  checkInSignature: string | null
  checkInBlockTime: number | null
  checkInOrganizerWallet: string | null
  lastTransferSignature: string | null
  finalizedSlot: number
}

export type ReconciliationResult = {
  ticketId: string
  eventId: string
  databaseState: DatabaseTicketState | null
  verifiedChainState: VerifiedChainState | null
  classification: DiscrepancyClassification
  autoRepairSafe: boolean
  reason: string
  timestamp: string
  transactionSignature: string | null
  repairAction: string | null
  repairSucceeded: boolean | null
}

export type DecodedEvent = {
  eventId: Uint8Array
  organizer: string
  transfersAllowed: boolean
  bump: number
}

export type DecodedTicket = {
  ticketId: Uint8Array
  event: string
  issuer: string
  owner: string
  valid: boolean
  checkedIn: boolean
  transferCount: number
  bump: number
}

export type DecodedReceipt = {
  ticket: string
  from: string
  to: string
  sequence: number
  bump: number
}

export class RpcUnavailableError extends Error {}

export type DevnetRpc = <T>(method: string, params: unknown[]) => Promise<T>

export function createDevnetRpc(url: string, fetcher: typeof fetch = fetch): DevnetRpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara-reconciliation', method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
    } catch (error) {
      throw new RpcUnavailableError(error instanceof Error ? `Devnet RPC request failed: ${error.message}` : 'Devnet RPC request failed.')
    }
    if (!response.ok) throw new RpcUnavailableError(`Devnet RPC returned HTTP ${response.status}.`)
    let payload: { result?: T; error?: { message?: string } }
    try { payload = await response.json() as { result?: T; error?: { message?: string } } }
    catch { throw new RpcUnavailableError('Devnet RPC returned malformed JSON.') }
    if (payload.error || payload.result === undefined) throw new RpcUnavailableError(payload.error?.message ?? 'Devnet RPC returned no result.')
    return payload.result
  }
}

export function assertProgramOwner(actualOwner: string, accountName: string) {
  if (actualOwner !== PROGRAM_ID) throw new Error(`${accountName} is owned by a different Solana program.`)
}

export function assertExpectedPda(actualAddress: string, expectedAddress: string, accountName: string) {
  if (actualAddress !== expectedAddress) throw new Error(`${accountName} does not match the derived Anchor PDA.`)
}

export function confirmationFinality(status: string | null): 'finalized' | 'pending' | 'unknown' {
  if (status === 'finalized') return 'finalized'
  if (status === 'processed' || status === 'confirmed') return 'pending'
  return 'unknown'
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function uuidBytes(value: string) {
  if (!isUuid(value)) throw new Error('Invalid ticket or event UUID.')
  return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => Number.parseInt(byte, 16))
}

export function bytesUuid(value: Uint8Array) {
  if (value.length !== 16) throw new Error('On-chain ticket identifier is malformed.')
  const hex = Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function deriveTicketPdas(eventId: string, ticketId: string) {
  const program = new PublicKey(PROGRAM_ID)
  const eventBytes = uuidBytes(eventId)
  const ticketBytes = uuidBytes(ticketId)
  const [event, eventBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('event'), eventBytes], program)
  const [ticket, ticketBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('ticket'), event.toBytes(), ticketBytes], program)
  return { event, ticket, eventBytes, ticketBytes, eventBump, ticketBump }
}

export function deriveTransferReceipt(ticket: PublicKey, sequence: number) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error('Transfer sequence is outside the Anchor u32 range.')
  const seed = new Uint8Array(4)
  new DataView(seed.buffer).setUint32(0, sequence, true)
  const [receipt, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('transfer'), ticket.toBytes(), seed], new PublicKey(PROGRAM_ID))
  return { receipt, bump }
}

export function decodeEventAccount(data: Uint8Array): DecodedEvent {
  assertAccount(data, EVENT_ACCOUNT_SIZE, ACCOUNT_DISCRIMINATORS.event, 'EventRecord')
  const transfersAllowed = decodeBool(data[56], 'event transfers_allowed')
  return { eventId: data.slice(8, 24), organizer: new PublicKey(data.slice(24, 56)).toBase58(), transfersAllowed, bump: data[57] }
}

export function decodeTicketAccount(data: Uint8Array): DecodedTicket {
  assertAccount(data, TICKET_ACCOUNT_SIZE, ACCOUNT_DISCRIMINATORS.ticket, 'TicketRecord')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    ticketId: data.slice(8, 24),
    event: new PublicKey(data.slice(24, 56)).toBase58(),
    issuer: new PublicKey(data.slice(56, 88)).toBase58(),
    owner: new PublicKey(data.slice(88, 120)).toBase58(),
    valid: decodeBool(data[120], 'ticket valid'),
    checkedIn: decodeBool(data[121], 'ticket checked_in'),
    transferCount: view.getUint32(122, true),
    bump: data[126],
  }
}

export function decodeTransferReceipt(data: Uint8Array): DecodedReceipt {
  assertAccount(data, TRANSFER_RECEIPT_ACCOUNT_SIZE, ACCOUNT_DISCRIMINATORS.receipt, 'TransferReceipt')
  return {
    ticket: new PublicKey(data.slice(8, 40)).toBase58(),
    from: new PublicKey(data.slice(40, 72)).toBase58(),
    to: new PublicKey(data.slice(72, 104)).toBase58(),
    sequence: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(104, true),
    bump: data[108],
  }
}

export type TransactionMessage = {
  accountKeys: ({ pubkey: string | { toBase58(): string }; signer?: boolean } | string | { toBase58(): string })[]
  header?: { numRequiredSignatures?: number }
  instructions: { programIdIndex: number; accounts: number[]; data: string }[]
}

export type FinalizedTransaction = {
  slot: number
  blockTime: number | null
  meta: { err: unknown | null; loadedAddresses?: { writable: string[]; readonly: string[] } | null } | null
  transaction: { signatures: string[]; message: TransactionMessage }
}

export function assertRegistrationTransaction(tx: FinalizedTransaction, signature: string, eventId: string, ticketId: string, eventPda: PublicKey, ticketPda: PublicKey, organizer: string) {
  const { keys, signers, instructions } = transactionParts(tx)
  if (!tx.transaction.signatures.includes(signature)) throw new Error('Registration signature does not match the finalized transaction.')
  if (!signers.has(organizer)) throw new Error('Registration transaction was not signed by the event organiser.')
  const programInstructions = instructions.filter(instruction => keys[instruction.programIdIndex] === PROGRAM_ID)
  const registrations = programInstructions.filter(instruction => equalPrefix(decodeBase58(instruction.data), INSTRUCTION_DISCRIMINATORS.registerTicket))
  const creates = programInstructions.filter(instruction => equalPrefix(decodeBase58(instruction.data), INSTRUCTION_DISCRIMINATORS.createEvent))
  const ticketBytes = uuidBytes(ticketId)
  const eventBytes = uuidBytes(eventId)
  if (registrations.length !== 1 || creates.length > 1 || programInstructions.length !== registrations.length + creates.length) {
    throw new Error('Registration transaction does not contain exactly one registration instruction.')
  }
  const register = registrations[0]
  const data = decodeBase58(register.data)
  const accounts = register.accounts.map(index => keys[index])
  if (data.length !== 24 || !equalBytes(data.slice(8), ticketBytes)
    || accounts.length !== 5 || accounts[0] !== organizer || accounts[1] !== eventPda.toBase58()
    || !accounts[2] || accounts[3] !== ticketPda.toBase58()
    || accounts[4] !== '11111111111111111111111111111111') {
    throw new Error('Registration instruction does not match the derived ticket, event and owner.')
  }
  if (creates.length === 1) {
    const create = creates[0]
    const createData = decodeBase58(create.data)
    const createAccounts = create.accounts.map(index => keys[index])
    if (createData.length !== 25 || !equalBytes(createData.slice(8, 24), eventBytes) || createData[24] !== 0
      || createAccounts.length !== 3 || createAccounts[0] !== organizer
      || createAccounts[1] !== eventPda.toBase58() || createAccounts[2] !== '11111111111111111111111111111111') {
      throw new Error('Event creation instruction does not match the registered event.')
    }
  }
  return accounts[2]
}

export function assertTransferTransaction(tx: FinalizedTransaction, signature: string, ticketId: string, sequence: number, eventPda: string, ticketPda: string, receiptPda: string, from: string, to: string) {
  const { keys, signers, instructions } = transactionParts(tx)
  if (!tx.transaction.signatures.includes(signature)) throw new Error('Transfer signature does not match the finalized transaction.')
  if (!signers.has(from)) throw new Error('Transfer was not signed by the previous ticket owner.')
  const programInstructions = instructions.filter(instruction => keys[instruction.programIdIndex] === PROGRAM_ID)
  if (programInstructions.length !== 1) throw new Error('Transfer transaction must contain exactly one ticket instruction.')
  const instruction = programInstructions[0]
  const data = decodeBase58(instruction.data)
  const accounts = instruction.accounts.map(index => keys[index])
  if (data.length !== 24 || !equalPrefix(data, INSTRUCTION_DISCRIMINATORS.transfer)
    || !equalBytes(data.slice(8), uuidBytes(ticketId))
    || accounts.length !== 6 || accounts[0] !== from || accounts[1] !== eventPda
    || accounts[2] !== ticketPda || accounts[3] !== to || accounts[4] !== receiptPda
    || accounts[5] !== '11111111111111111111111111111111') {
    throw new Error('Transfer instruction does not match its verified receipt and ticket owner change.')
  }
}

export function assertCheckInTransaction(tx: FinalizedTransaction, signature: string, ticketId: string, eventPda: string, ticketPda: string, organizer: string) {
  const { keys, signers, instructions } = transactionParts(tx)
  if (!tx.transaction.signatures.includes(signature)) throw new Error('Check-in signature does not match the finalized transaction.')
  if (!signers.has(organizer)) throw new Error('Check-in was not signed by the event organiser.')
  const instructionsForProgram = instructions.filter(instruction => keys[instruction.programIdIndex] === PROGRAM_ID)
  if (instructionsForProgram.length !== 1) throw new Error('Check-in transaction must contain exactly one NODARA instruction.')
  const instruction = instructionsForProgram[0]
  const data = decodeBase58(instruction.data)
  const accounts = instruction.accounts.map(index => keys[index])
  if (data.length !== 24 || !equalPrefix(data, INSTRUCTION_DISCRIMINATORS.checkIn)
    || !equalBytes(data.slice(8), uuidBytes(ticketId))
    || accounts.length !== 3 || accounts[0] !== organizer || accounts[1] !== eventPda || accounts[2] !== ticketPda) {
    throw new Error('Check-in instruction does not match the derived ticket, event and organiser.')
  }
}

export function classifyReconciliation(input: {
  ticketId: string
  eventId: string
  databaseState: DatabaseTicketState | null
  verifiedChainState: VerifiedChainState | null
  failure?: 'rpc' | 'pending' | 'invalid' | 'manual'
  reason?: string
  eventOrganizerUserId?: string
  now?: string
}): ReconciliationResult {
  const { ticketId, eventId, databaseState: database, verifiedChainState: chain } = input
  const base = {
    ticketId, eventId, databaseState: database, verifiedChainState: chain,
    timestamp: input.now ?? new Date().toISOString(), transactionSignature: null as string | null,
    repairAction: null, repairSucceeded: null,
  }
  if (input.failure === 'rpc') return { ...base, classification: 'RPC_UNAVAILABLE', autoRepairSafe: false, reason: input.reason ?? 'Devnet RPC was unavailable; no on-chain absence was inferred.' }
  if (input.failure === 'pending') return { ...base, classification: 'PENDING_CONFIRMATION', autoRepairSafe: false, reason: input.reason ?? 'Relevant transaction has not reached finalized commitment.' }
  if (input.failure === 'invalid') return { ...base, classification: 'INVALID_ACCOUNT', autoRepairSafe: false, reason: input.reason ?? 'On-chain account owner, PDA, discriminator or data layout is invalid.' }
  if (input.failure === 'manual') return { ...base, classification: 'REQUIRES_MANUAL_REVIEW', autoRepairSafe: false, reason: input.reason ?? 'The verified state is ambiguous and requires review.' }
  if (!database) return { ...base, classification: 'MISSING_IN_DATABASE', autoRepairSafe: false, reason: 'A valid finalized ticket PDA exists on Devnet, but no matching NODARA ticket record exists.' }
  if (!chain) return { ...base, classification: 'MISSING_ON_CHAIN', autoRepairSafe: false, reason: 'The derived ticket PDA was absent at finalized commitment; database records were not changed.' }

  const transferComparison = compareTransferHistory(database.transferHistory, chain.transferHistory, chain.transferCount)
  if (!transferComparison.matches) {
    return {
      ...base, classification: 'TRANSFER_HISTORY_MISMATCH',
      autoRepairSafe: transferComparison.repairable && !hasConflictingMetadata(database, chain)
        && !(chain.valid && database.status === 'cancelled'),
      reason: transferComparison.reason,
      transactionSignature: chain.lastTransferSignature,
      repairAction: transferComparison.repairable ? 'synchronize verified transfer receipts' : null,
    }
  }

  const expectedCheckInTime = chain.checkInBlockTime === null
    ? null
    : new Date(chain.checkInBlockTime * 1000).toISOString()
  const checkInTimeMatches = Boolean(database.checkedInAt && expectedCheckInTime
    && Date.parse(database.checkedInAt) === Date.parse(expectedCheckInTime))
  const checkInHistoryMismatch = chain.checkedIn && (
    database.status !== 'checked_in'
    || database.checkedIn !== true
    || database.checkInSignature !== chain.checkInSignature
    || !checkInTimeMatches
  )
  if (checkInHistoryMismatch) {
    const canRepair = (database.status === 'issued' || database.status === 'checked_in')
      && Boolean(chain.checkInSignature && chain.checkInBlockTime !== null && chain.checkInOrganizerWallet)
      && !(database.checkInSignature && database.checkInSignature !== chain.checkInSignature)
      && !(database.checkedInBy && input.eventOrganizerUserId && database.checkedInBy !== input.eventOrganizerUserId)
      && !hasConflictingMetadata(database, chain)
    return {
      ...base, classification: 'CHECKIN_MISMATCH', autoRepairSafe: canRepair,
      reason: canRepair
        ? 'Finalized on-chain check-in is verified, but attendance synchronization is incomplete.'
        : 'On-chain and database check-in state differ; existing attendance, organiser or transaction evidence is ambiguous.',
      transactionSignature: chain.checkInSignature,
      repairAction: canRepair ? 'synchronize finalized check-in and attendance history' : null,
    }
  }
  if (!chain.checkedIn && database.status === 'checked_in') {
    return { ...base, classification: 'CHECKIN_MISMATCH', autoRepairSafe: false, reason: 'Database records attendance but the finalized ticket account is not checked in; do not clear attendance automatically.', transactionSignature: database.checkInSignature }
  }
  if (!chain.checkedIn && database.checkInSignature) {
    return { ...base, classification: 'CHECKIN_MISMATCH', autoRepairSafe: false, reason: 'Database contains a finalized check-in history entry but the current ticket account is not checked in; preserve attendance for manual review.', transactionSignature: database.checkInSignature }
  }

  const ownerMismatch = database.walletAddress !== chain.owner
  if (ownerMismatch) {
    const canRepair = !hasConflictingMetadata(database, chain)
      && chain.transferHistory.length === chain.transferCount
      && (chain.transferCount === 0 || transferComparison.complete)
      && !(chain.valid && database.status === 'cancelled')
    return {
      ...base, classification: 'OWNER_MISMATCH', autoRepairSafe: canRepair,
      reason: canRepair
        ? 'Finalized Devnet ticket owner differs from the stored wallet; wallet synchronization is safe, but holder access will be cleared for a new claim.'
        : 'Current owner differs and complete, conflict-free transfer evidence is unavailable.',
      transactionSignature: chain.lastTransferSignature ?? chain.registrationSignature,
      repairAction: canRepair ? 'synchronize verified chain owner and clear stale holder access' : null,
    }
  }

  const snapshotMismatch = database.blockchainStatus !== 'verified'
    || database.network !== 'devnet'
    || database.programId !== chain.programId
    || database.ticketAccount !== chain.ticketAccount
    || database.eventAccount !== chain.eventAccount
    || database.registrationSignature !== chain.registrationSignature
    || database.ticketValid !== chain.valid
    || database.checkedIn !== chain.checkedIn
    || database.transferCount !== chain.transferCount
  const appStatusMismatch = (chain.checkedIn && database.status !== 'checked_in')
    || (!chain.checkedIn && database.status === 'checked_in')
    || (!chain.valid && database.status === 'issued')
    || (chain.valid && database.status === 'cancelled')
  if (snapshotMismatch || appStatusMismatch) {
    const canRepair = !hasConflictingMetadata(database, chain)
      && (chain.checkedIn
        ? (database.status === 'issued' || database.status === 'checked_in') && Boolean(chain.checkInSignature && chain.checkInBlockTime !== null && chain.checkInOrganizerWallet)
        : chain.valid ? database.status === 'issued' : database.status === 'issued' || database.status === 'checked_in')
    const classification = chain.checkedIn !== database.checkedIn || appStatusMismatch && chain.checkedIn
      ? 'CHECKIN_MISMATCH'
      : 'STATUS_MISMATCH'
    return {
      ...base, classification, autoRepairSafe: canRepair,
      reason: canRepair
        ? 'Finalized ticket state is valid, but the stored blockchain snapshot or corresponding ticket status is stale.'
        : 'Ticket status or blockchain metadata conflicts with the finalized account and cannot be changed safely without review.',
      transactionSignature: chain.checkInSignature ?? chain.lastTransferSignature ?? chain.registrationSignature,
      repairAction: canRepair ? 'synchronize verified ticket state and history' : null,
    }
  }

  return { ...base, classification: 'IN_SYNC', autoRepairSafe: false, reason: 'Ticket ownership, validity, check-in state and verified transfer history match finalized Devnet state.' }
}

export function mergePageIds(databaseIds: string[], onChainIds: string[], cursor: string | null, limit: number) {
  const candidates = new Set([...databaseIds, ...onChainIds])
  const ordered = [...candidates].filter(id => !cursor || id > cursor).sort()
  return { ticketIds: ordered.slice(0, limit), hasMore: ordered.length > limit, nextCursor: ordered.length > limit ? ordered[limit - 1] : null }
}

export function isAuthorizedEventOwner(eventOrganizerId: string | null | undefined, authenticatedUserId: string) {
  return Boolean(eventOrganizerId && eventOrganizerId === authenticatedUserId)
}

function assertAccount(data: Uint8Array, size: number, discriminator: Uint8Array, name: string) {
  if (data.length !== size || !equalBytes(data.slice(0, 8), discriminator)) throw new Error(`${name} data does not match the bundled Anchor IDL.`)
}

function decodeBool(value: number, name: string) {
  if (value !== 0 && value !== 1) throw new Error(`${name} is not a valid Anchor boolean.`)
  return value === 1
}

function transactionParts(tx: FinalizedTransaction) {
  if (!tx.meta || tx.meta.err !== null) throw new Error('The Devnet transaction did not finalize successfully.')
  const staticKeys = tx.transaction.message.accountKeys.map(accountKey)
  const loaded = tx.meta.loadedAddresses
  const keys = [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]
  const requiredSignatures = tx.transaction.message.header?.numRequiredSignatures ?? 0
  const signers = new Set<string>()
  tx.transaction.message.accountKeys.forEach((key, index) => {
    const name = accountKey(key)
    if ((typeof key === 'object' && 'signer' in key && key.signer === true) || index < requiredSignatures) signers.add(name)
  })
  return { keys, signers, instructions: tx.transaction.message.instructions }
}

function accountKey(value: string | { pubkey: string | { toBase58(): string }; signer?: boolean } | { toBase58(): string }) {
  if (typeof value === 'string') return value
  if ('pubkey' in value) return typeof value.pubkey === 'string' ? value.pubkey : value.pubkey.toBase58()
  return value.toBase58()
}

function compareTransferHistory(databaseHistory: DatabaseTicketState['transferHistory'], chainHistory: TransferState[], transferCount: number) {
  if (chainHistory.length !== transferCount) {
    return { matches: false, complete: false, repairable: false, reason: 'Finalized transfer receipt history could not be completely verified.' }
  }
  const chainBySignature = new Map(chainHistory.map(transfer => [transfer.signature, transfer]))
  const seenSequences = new Set<number>()
  for (const row of databaseHistory) {
    const transfer = chainBySignature.get(row.signature)
    if (!transfer || transfer.fromWallet !== row.fromWallet || transfer.toWallet !== row.toWallet
      || (row.sequence !== null && row.sequence !== transfer.sequence)
      || (row.receiptAccount !== null && row.receiptAccount !== transfer.receiptAccount)
      || seenSequences.has(transfer.sequence)) {
      return { matches: false, complete: false, repairable: false, reason: 'Database transfer history contains an entry that conflicts with finalized receipt PDAs or transaction signatures.' }
    }
    seenSequences.add(transfer.sequence)
  }
  if (databaseHistory.length !== chainHistory.length) {
    return {
      matches: false, complete: databaseHistory.length === chainHistory.length,
      repairable: databaseHistory.length < chainHistory.length,
      reason: databaseHistory.length < chainHistory.length
        ? 'One or more finalized transfer receipts are missing from the database history.'
        : 'Database transfer history contains entries without matching finalized receipt PDAs.',
    }
  }
  if (databaseHistory.some(row => row.sequence === null || row.receiptAccount === null)) {
    return { matches: false, complete: true, repairable: true, reason: 'Transfer records are verified but missing their on-chain receipt sequence metadata.' }
  }
  return { matches: true, complete: true, repairable: false, reason: '' }
}

function hasConflictingMetadata(database: DatabaseTicketState, chain: VerifiedChainState) {
  return (database.network !== null && database.network !== chain.network)
    || (database.programId !== null && database.programId !== chain.programId)
    || (database.ticketAccount !== null && database.ticketAccount !== chain.ticketAccount)
    || (database.eventAccount !== null && database.eventAccount !== chain.eventAccount)
}

export function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function equalPrefix(value: Uint8Array, prefix: Uint8Array) {
  return value.length >= prefix.length && prefix.every((byte, index) => value[index] === byte)
}

function decodeBase58(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const character of value) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('Transaction contains invalid base58 instruction data.')
    number = number * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (number > 0n) {
    bytes.unshift(Number(number & 255n))
    number >>= 8n
  }
  for (const character of value) {
    if (character !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}
