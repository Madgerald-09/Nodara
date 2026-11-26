import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const CHECK_IN = Uint8Array.from([174, 66, 18, 131, 231, 120, 103, 246])
export type CheckInInstructionMessage = {
  accountKeys: ({ pubkey: string; signer: boolean } | string)[]
  instructions: { programIdIndex: number; accounts: number[]; data: string }[]
}

export function deriveCheckInPdas(programId: PublicKey, eventId: string, ticketId: string) {
  const eventBytes = uuidBytes(eventId)
  const ticketBytes = uuidBytes(ticketId)
  const [event] = PublicKey.findProgramAddressSync([new TextEncoder().encode('event'), eventBytes], programId)
  const [ticket] = PublicKey.findProgramAddressSync([new TextEncoder().encode('ticket'), event.toBytes(), ticketBytes], programId)
  return { event, ticket, eventBytes, ticketBytes }
}

export function assertCheckInInstruction(message: CheckInInstructionMessage, programId: string, organizer: string, event: string, ticket: string, ticketId: string) {
  const keys = message.accountKeys.map(key => typeof key === 'string' ? { pubkey: key, signer: false } : key)
  if (!keys.some(key => key.pubkey === organizer && key.signer)) throw new Error('The authorised organiser wallet did not sign the transaction.')
  const instructions = message.instructions.filter(ix => keys[ix.programIdIndex]?.pubkey === programId)
  if (instructions.length !== 1) throw new Error('Transaction must contain exactly one NODARA check-in instruction.')
  const instruction = instructions[0]
  const data = base58Decode(instruction.data)
  const accounts = instruction.accounts.map(index => keys[index]?.pubkey)
  if (data.length !== 24 || !equalBytes(data.slice(0, 8), CHECK_IN) || !equalBytes(data.slice(8), uuidBytes(ticketId))
    || accounts.length !== 3 || accounts[0] !== organizer || accounts[1] !== event || accounts[2] !== ticket) {
    throw new Error('The confirmed transaction does not match this event, ticket and organiser.')
  }
}

function uuidBytes(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid UUID')
  return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => Number.parseInt(byte, 16))
}
function equalBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]) }
function base58Decode(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid base58 instruction data.'); number = number * 58n + BigInt(digit) }
  const bytes: number[] = []
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n }
  for (const char of value) { if (char !== '1') break; bytes.unshift(0) }
  return Uint8Array.from(bytes)
}
