import { assertCheckInInstruction, deriveCheckInPdas } from './verification.ts'
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

function base58Encode(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let encoded = ''
  while (value > 0n) { const remainder = Number(value % 58n); encoded = alphabet[remainder] + encoded; value /= 58n }
  for (const byte of bytes) { if (byte !== 0) break; encoded = `1${encoded}` }
  return encoded || '1'
}
