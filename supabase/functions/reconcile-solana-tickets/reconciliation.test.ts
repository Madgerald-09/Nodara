import { PublicKey } from 'npm:@solana/web3.js@1.98.4'
import {
  assertProgramOwner,
  assertExpectedPda,
  assertRegistrationTransaction,
  assertTransferTransaction,
  assertCheckInTransaction,
  classifyReconciliation,
  confirmationFinality,
  createDevnetRpc,
  decodeTicketAccount,
  DEVNET_GENESIS_HASH,
  deriveTicketPdas,
  deriveTransferReceipt,
  INSTRUCTION_DISCRIMINATORS,
  isAuthorizedEventOwner,
  mergePageIds,
  PROGRAM_ID,
  RpcUnavailableError,
  uuidBytes,
  type DatabaseTicketState,
  type FinalizedTransaction,
  type VerifiedChainState,
} from './reconciliation.ts'

const ticketId = '12345678-1234-4234-8234-123456789abc'
const eventId = 'abcdefab-cdef-4abc-8def-abcdefabcdef'

function database(overrides: Partial<DatabaseTicketState> = {}): DatabaseTicketState {
  return {
    status: 'issued',
    blockchainStatus: 'verified',
    network: 'devnet',
    programId: PROGRAM_ID,
    ticketAccount: 'ticket-pda',
    eventAccount: 'event-pda',
    registrationSignature: 'registration-signature',
    walletAddress: 'owner-a',
    ticketValid: true,
    checkedIn: false,
    transferCount: 0,
    checkedInAt: null,
    checkedInBy: null,
    checkInSignature: null,
    transferHistory: [],
    ...overrides,
  }
}

function chain(overrides: Partial<VerifiedChainState> = {}): VerifiedChainState {
  return {
    network: 'devnet',
    programId: PROGRAM_ID,
    eventAccount: 'event-pda',
    ticketAccount: 'ticket-pda',
    eventId,
    ticketId,
    organizer: 'organizer',
    issuer: 'organizer',
    initialOwner: 'owner-a',
    owner: 'owner-a',
    valid: true,
    checkedIn: false,
    transferCount: 0,
    transferHistory: [],
    registrationSignature: 'registration-signature',
    checkInSignature: null,
    checkInBlockTime: null,
    checkInOrganizerWallet: null,
    lastTransferSignature: null,
    finalizedSlot: 100,
    ...overrides,
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertThrows(action: () => unknown, message: string) {
  let threw = false
  try { action() } catch { threw = true }
  assert(threw, message)
}

Deno.test('classifies synchronized and missing ticket records without repairing missing rows', () => {
  assert(classifyReconciliation({ ticketId, eventId, databaseState: database(), verifiedChainState: chain() }).classification === 'IN_SYNC', 'expected in-sync classification')
  const missingDatabase = classifyReconciliation({ ticketId, eventId, databaseState: null, verifiedChainState: chain() })
  assert(missingDatabase.classification === 'MISSING_IN_DATABASE' && !missingDatabase.autoRepairSafe, 'missing database tickets must not be automatically created')
  assert(classifyReconciliation({ ticketId, eventId, databaseState: database(), verifiedChainState: null }).classification === 'MISSING_ON_CHAIN', 'expected missing-on-chain classification')
})

Deno.test('classifies owner, status, transfer and check-in discrepancies', () => {
  const transfer = { sequence: 0, receiptAccount: 'receipt', fromWallet: 'owner-a', toWallet: 'owner-b', signature: 'transfer-signature' }
  const transferChain = chain({ owner: 'owner-b', transferCount: 1, transferHistory: [transfer], lastTransferSignature: transfer.signature })
  const transferDatabase = database({
    walletAddress: 'owner-a',
    transferCount: 1,
    transferHistory: [{ sequence: 0, receiptAccount: 'receipt', fromWallet: 'owner-a', toWallet: 'owner-b', signature: 'transfer-signature' }],
  })
  const ownerMismatch = classifyReconciliation({ ticketId, eventId, databaseState: transferDatabase, verifiedChainState: transferChain })
  assert(ownerMismatch.classification === 'OWNER_MISMATCH' && ownerMismatch.autoRepairSafe, 'verified full transfer history should support owner synchronization')

  const statusMismatch = classifyReconciliation({
    ticketId, eventId, databaseState: database({ ticketValid: false }), verifiedChainState: chain(),
  })
  assert(statusMismatch.classification === 'STATUS_MISMATCH' && statusMismatch.autoRepairSafe, 'a stale chain snapshot should be safely repairable')

  const missingTransfer = classifyReconciliation({
    ticketId, eventId, databaseState: database(), verifiedChainState: chain({ transferCount: 1, transferHistory: [transfer], owner: 'owner-b' }),
  })
  assert(missingTransfer.classification === 'TRANSFER_HISTORY_MISMATCH' && missingTransfer.autoRepairSafe, 'missing database transfer history should use verified receipts')

  const checkInMismatch = classifyReconciliation({
    ticketId,
    eventId,
    databaseState: database(),
    verifiedChainState: chain({
      checkedIn: true,
      checkInSignature: 'checkin-signature',
      checkInBlockTime: 1_800_000_000,
      checkInOrganizerWallet: 'organizer',
    }),
  })
  assert(checkInMismatch.classification === 'CHECKIN_MISMATCH' && checkInMismatch.autoRepairSafe, 'a finalized check-in needs independently verified evidence before repair')

  const conflictingCheckIn = classifyReconciliation({
    ticketId,
    eventId,
    eventOrganizerUserId: 'organizer-user',
    databaseState: database({
      status: 'checked_in',
      checkedIn: true,
      checkedInAt: new Date(1_800_000_000 * 1000).toISOString(),
      checkedInBy: 'different-organizer',
      checkInSignature: 'different-signature',
    }),
    verifiedChainState: chain({
      checkedIn: true,
      checkInSignature: 'checkin-signature',
      checkInBlockTime: 1_800_000_000,
      checkInOrganizerWallet: 'organizer',
    }),
  })
  assert(conflictingCheckIn.classification === 'CHECKIN_MISMATCH' && !conflictingCheckIn.autoRepairSafe, 'conflicting attendance evidence must require review')
})

Deno.test('transient and invalid evidence never becomes a missing-account repair', () => {
  const rpcFailure = classifyReconciliation({ ticketId, eventId, databaseState: null, verifiedChainState: null, failure: 'rpc' })
  assert(rpcFailure.classification === 'RPC_UNAVAILABLE' && !rpcFailure.autoRepairSafe, 'RPC failure must not imply account absence')
  assert(classifyReconciliation({ ticketId, eventId, databaseState: database(), verifiedChainState: null, failure: 'pending' }).classification === 'PENDING_CONFIRMATION', 'unfinalized transactions remain pending')
  assert(classifyReconciliation({ ticketId, eventId, databaseState: database(), verifiedChainState: null, failure: 'invalid' }).classification === 'INVALID_ACCOUNT', 'invalid accounts must be distinguished')
  assert(classifyReconciliation({ ticketId, eventId, databaseState: database(), verifiedChainState: null, failure: 'manual' }).classification === 'REQUIRES_MANUAL_REVIEW', 'ambiguous evidence requires review')
})

Deno.test('rejects malformed accounts and unexpected program owners', () => {
  assertThrows(() => decodeTicketAccount(new Uint8Array(127)), 'malformed ticket account was accepted')
  assertThrows(() => assertProgramOwner('11111111111111111111111111111111', 'Ticket PDA'), 'wrong program owner was accepted')
  assertThrows(() => assertExpectedPda('wrong-pda', 'derived-pda', 'Ticket PDA'), 'incorrect ticket PDA was accepted')
  assertProgramOwner(PROGRAM_ID, 'Ticket PDA')
})

Deno.test('distinguishes finalized, pending and unknown transaction confirmation', () => {
  assert(confirmationFinality('finalized') === 'finalized', 'finalized status was not recognized')
  assert(confirmationFinality('confirmed') === 'pending', 'confirmed status must not be treated as finalized')
  assert(confirmationFinality('processed') === 'pending', 'processed status must not be treated as finalized')
  assert(confirmationFinality(null) === 'unknown', 'missing status must remain unknown')
})

Deno.test('verifies registration, transfer and check-in transaction identities and signers', () => {
  const organizer = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toBase58()
  const recipient = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 33)).toBase58()
  const pdas = deriveTicketPdas(eventId, ticketId)
  const encodedTicketId = uuidBytes(ticketId)

  const registration = transaction(
    [organizer, pdas.event.toBase58(), recipient, pdas.ticket.toBase58(), '11111111111111111111111111111111', PROGRAM_ID],
    [0, 1, 2, 3, 4],
    [...INSTRUCTION_DISCRIMINATORS.registerTicket, ...encodedTicketId],
  )
  assert(
    assertRegistrationTransaction(registration, 'signature', eventId, ticketId, pdas.event, pdas.ticket, organizer) === recipient,
    'registration verifier did not extract the transaction owner',
  )
  const badSigner = {
    ...registration,
    transaction: {
      ...registration.transaction,
      message: {
        ...registration.transaction.message,
        accountKeys: registration.transaction.message.accountKeys.map((key, index) =>
          index === 0 && typeof key === 'object' && 'pubkey' in key ? { ...key, signer: false } : key
        ),
        header: { numRequiredSignatures: 0 },
      },
    },
  }
  assertThrows(
    () => assertRegistrationTransaction(badSigner, 'signature', eventId, ticketId, pdas.event, pdas.ticket, organizer),
    'registration without organiser signature was accepted',
  )

  const sender = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 65)).toBase58()
  const { receipt } = deriveTransferReceipt(pdas.ticket, 0)
  const transfer = transaction(
    [sender, pdas.event.toBase58(), pdas.ticket.toBase58(), recipient, receipt.toBase58(), '11111111111111111111111111111111', PROGRAM_ID],
    [0, 1, 2, 3, 4, 5],
    [...INSTRUCTION_DISCRIMINATORS.transfer, ...encodedTicketId],
  )
  assertTransferTransaction(transfer, 'signature', ticketId, 0, pdas.event.toBase58(), pdas.ticket.toBase58(), receipt.toBase58(), sender, recipient)

  const checkIn = transaction(
    [organizer, pdas.event.toBase58(), pdas.ticket.toBase58(), PROGRAM_ID],
    [0, 1, 2],
    [...INSTRUCTION_DISCRIMINATORS.checkIn, ...encodedTicketId],
  )
  assertCheckInTransaction(checkIn, 'signature', ticketId, pdas.event.toBase58(), pdas.ticket.toBase58(), organizer)
})

Deno.test('normalizes RPC timeouts and unavailable responses', async () => {
  const timeoutRpc = createDevnetRpc('https://devnet.example', async () => {
    throw new DOMException('request timed out', 'TimeoutError')
  })
  let timeoutError: unknown
  try { await timeoutRpc<string>('getGenesisHash', []) } catch (error) { timeoutError = error }
  assert(timeoutError instanceof RpcUnavailableError, 'RPC timeout was not classified as unavailable')

  const unavailableRpc = createDevnetRpc('https://devnet.example', async () => new Response('unavailable', { status: 503 }))
  let unavailableError: unknown
  try { await unavailableRpc<string>('getGenesisHash', []) } catch (error) { unavailableError = error }
  assert(unavailableError instanceof RpcUnavailableError, 'HTTP RPC failure was not classified as unavailable')

  const validRpc = createDevnetRpc('https://devnet.example', async () => Response.json({ result: DEVNET_GENESIS_HASH }))
  assert(await validRpc<string>('getGenesisHash', []) === DEVNET_GENESIS_HASH, 'valid JSON-RPC response was not returned')
})

Deno.test('does not trust a transaction whose signature does not match the requested evidence', () => {
  const pdas = deriveTicketPdas(eventId, ticketId)
  const organizer = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toBase58()
  const transactionResult = transaction(
    [organizer, pdas.event.toBase58(), organizer, pdas.ticket.toBase58(), '11111111111111111111111111111111', PROGRAM_ID],
    [0, 1, 2, 3, 4],
    [...INSTRUCTION_DISCRIMINATORS.registerTicket, ...uuidBytes(ticketId)],
  )
  assertThrows(
    () => assertRegistrationTransaction(transactionResult, 'different-signature', eventId, ticketId, pdas.event, pdas.ticket, organizer),
    'registration verifier accepted a mismatched signature',
  )
})

Deno.test('authorizes only the event owner and pages a stable union of database and chain IDs', () => {
  assert(isAuthorizedEventOwner('organizer-id', 'organizer-id'), 'event owner should be authorized')
  assert(!isAuthorizedEventOwner('different-user', 'organizer-id'), 'another user must not be authorized')
  assert(!isAuthorizedEventOwner(null, 'organizer-id'), 'ownerless event must not be authorized')
  const first = mergePageIds(['a', 'c'], ['b', 'd'], null, 2)
  const second = mergePageIds(['c', 'e'], ['d', 'f'], first.nextCursor, 2)
  assert(first.ticketIds.join(',') === 'a,b' && first.nextCursor === 'b', 'first page did not merge IDs deterministically')
  assert(second.ticketIds.join(',') === 'c,d' && second.nextCursor === 'd', 'cursor caused IDs to be repeated or skipped')
})

function transaction(
  accountKeys: string[],
  accounts: number[],
  instructionBytes: number[],
): FinalizedTransaction {
  return {
    slot: 1,
    blockTime: 1_800_000_000,
    meta: { err: null, loadedAddresses: null },
    transaction: {
      signatures: ['signature'],
      message: {
        accountKeys: accountKeys.map((pubkey, index) => ({ pubkey, signer: index === 0 })),
        header: { numRequiredSignatures: 1 },
        instructions: [{
          programIdIndex: accountKeys.length - 1,
          accounts,
          data: encodeBase58(Uint8Array.from(instructionBytes)),
        }],
      },
    },
  }
}

function encodeBase58(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let encoded = ''
  while (value > 0n) {
    const digit = Number(value % 58n)
    encoded = alphabet[digit] + encoded
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    encoded = `1${encoded}`
  }
  return encoded || '1'
}
