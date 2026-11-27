import { assertCheckInAccountState, assertCheckInInstruction, deriveCheckInPdas } from './verification.ts'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const program = new PublicKey('CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf')
const organizer = new PublicKey('11111111111111111111111111111111')
const eventId = '01234567-89ab-cdef-0123-456789abcdef'
const ticketId = 'fedcba98-7654-3210-fedc-ba9876543210'

Deno.test('accepts the exact deployed check-in instruction and derived PDAs', () => {
  const { event, ticket } = deriveCheckInPdas(program, eventId, ticketId)
  const discriminator = [174, 66, 18, 131, 231, 120, 103, 246]
  const args = Uint8Array.from(ticketId.replaceAll('-', '').match(/.{2}/g)!, value => Number.parseInt(value, 16))
  const data = base58Encode(Uint8Array.from([...discriminator, ...args]))
  assertCheckInInstruction({
    accountKeys: [
      { pubkey: organizer.toBase58(), signer: true },
      { pubkey: event.toBase58(), signer: false },
      { pubkey: ticket.toBase58(), signer: false },
      { pubkey: program.toBase58(), signer: false },
    ],
    instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data }],
  }, program.toBase58(), organizer.toBase58(), event.toBase58(), ticket.toBase58(), ticketId)
})

Deno.test('rejects a transaction without the authorised organiser signature', () => {
  const { event, ticket } = deriveCheckInPdas(program, eventId, ticketId)
  const data = base58Encode(Uint8Array.from([174, 66, 18, 131, 231, 120, 103, 246, ...new Uint8Array(16)]))
  let rejected = false
  try {
    assertCheckInInstruction({
      accountKeys: [{ pubkey: organizer.toBase58(), signer: false }, { pubkey: event.toBase58(), signer: false }, { pubkey: ticket.toBase58(), signer: false }, { pubkey: program.toBase58(), signer: false }],
      instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data }],
    }, program.toBase58(), organizer.toBase58(), event.toBase58(), ticket.toBase58(), ticketId)
  } catch { rejected = true }
  if (!rejected) throw new Error('Expected unauthorised organiser instruction to be rejected')
})

Deno.test('rejects mismatched ticket IDs and account addresses', () => {
  const { event, ticket } = deriveCheckInPdas(program, eventId, ticketId)
  const data = base58Encode(Uint8Array.from([174, 66, 18, 131, 231, 120, 103, 246, ...new Uint8Array(16)]))
  let rejected = false
  try {
    assertCheckInInstruction({
      accountKeys: [{ pubkey: organizer.toBase58(), signer: true }, { pubkey: event.toBase58(), signer: false }, { pubkey: ticket.toBase58(), signer: false }, { pubkey: program.toBase58(), signer: false }],
      instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data }],
    }, program.toBase58(), organizer.toBase58(), event.toBase58(), ticket.toBase58(), ticketId)
  } catch { rejected = true }
  if (!rejected) throw new Error('Expected mismatched ticket instruction to be rejected')
})

Deno.test('accepts only the exact registered ticket and checked-in account state', () => {
  const accounts = checkedInAccounts()
  assertCheckInAccountState(accounts.input)
})

Deno.test('rejects an invalidated ticket', () => {
  const accounts = checkedInAccounts()
  accounts.input.ticketData![120] = 0
  expectRejected(() => assertCheckInAccountState(accounts.input), 'invalidated')
})

Deno.test('rejects a ticket that does not contain the resulting checked-in state', () => {
  const accounts = checkedInAccounts()
  accounts.input.ticketData![121] = 0
  expectRejected(() => assertCheckInAccountState(accounts.input), 'not been checked in')
})

Deno.test('rejects an on-chain ticket with a different ticket identity', () => {
  const accounts = checkedInAccounts()
  accounts.input.ticketData![8] ^= 1
  expectRejected(() => assertCheckInAccountState(accounts.input), 'ticket identity')
})

Deno.test('rejects an on-chain owner different from the current NODARA wallet', () => {
  const accounts = checkedInAccounts()
  accounts.input.owner = accounts.input.event
  expectRejected(() => assertCheckInAccountState(accounts.input), 'current owner')
})

Deno.test('rejects event or ticket accounts owned by a different program', () => {
  const accounts = checkedInAccounts()
  accounts.input.ticketAccountOwner = PublicKey.default.toBase58()
  expectRejected(() => assertCheckInAccountState(accounts.input), 'owned by another program')
})

function checkedInAccounts() {
  const { event, eventBytes, ticketBytes } = deriveCheckInPdas(program, eventId, ticketId)
  const eventData = new Uint8Array(58)
  eventData.set([150, 209, 156, 235, 9, 198, 56, 184], 0)
  eventData.set(eventBytes, 8)
  eventData.set(organizer.toBytes(), 24)
  const ticketData = new Uint8Array(127)
  ticketData.set([37, 215, 102, 48, 114, 66, 21, 87], 0)
  ticketData.set(ticketBytes, 8)
  ticketData.set(event.toBytes(), 24)
  ticketData.set(organizer.toBytes(), 56)
  ticketData.set(organizer.toBytes(), 88)
  ticketData[120] = 1
  ticketData[121] = 1
  return {
    input: {
      programId: program.toBase58(),
      eventAccountOwner: program.toBase58(),
      eventData,
      ticketAccountOwner: program.toBase58(),
      ticketData,
      eventId: eventBytes,
      ticketId: ticketBytes,
      event: event.toBase58(),
      organizer: organizer.toBase58(),
      owner: organizer.toBase58(),
    },
  }
}

function expectRejected(action: () => void, message: string) {
  try {
    action()
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return
    throw error
  }
  throw new Error(`Expected rejection containing "${message}"`)
}

function base58Encode(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let encoded = ''
  while (value > 0n) { const remainder = Number(value % 58n); encoded = alphabet[remainder] + encoded; value /= 58n }
  for (const byte of bytes) { if (byte !== 0) break; encoded = `1${encoded}` }
  return encoded || '1'
}
