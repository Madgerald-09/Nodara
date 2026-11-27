import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const CHECK_IN = Uint8Array.from([174, 66, 18, 131, 231, 120, 103, 246])
const EVENT_RECORD = Uint8Array.from([150, 209, 156, 235, 9, 198, 56, 184])
const TICKET_RECORD = Uint8Array.from([37, 215, 102, 48, 114, 66, 21, 87])
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

export function assertCheckInAccountState(input: {
  programId: string
  eventAccountOwner: string
  eventData: Uint8Array | null
  ticketAccountOwner: string
  ticketData: Uint8Array | null
  eventId: Uint8Array
  ticketId: Uint8Array
  event: string
  organizer: string
  owner: string
}) {
  const { eventData, ticketData } = input
  if (!eventData || !ticketData || input.eventAccountOwner !== input.programId || input.ticketAccountOwner !== input.programId) {
    throw new Error('The event or ticket account is missing or owned by another program.')
  }
  if (eventData.length !== 58 || ticketData.length !== 127
    || !equalBytes(eventData.slice(0, 8), EVENT_RECORD) || !equalBytes(ticketData.slice(0, 8), TICKET_RECORD)) {
    throw new Error('On-chain account data does not match the deployed Anchor account layout.')
  }
  if (!equalBytes(eventData.slice(8, 24), input.eventId) || !equalBytes(eventData.slice(24, 56), new PublicKey(input.organizer).toBytes())) {
    throw new Error('This organiser wallet is not authorized by the on-chain event account.')
  }
  if (!equalBytes(ticketData.slice(8, 24), input.ticketId) || !equalBytes(ticketData.slice(24, 56), new PublicKey(input.event).toBytes())
    || !equalBytes(ticketData.slice(56, 88), new PublicKey(input.organizer).toBytes())
    || !equalBytes(ticketData.slice(88, 120), new PublicKey(input.owner).toBytes())) {
    throw new Error('The on-chain ticket identity, organiser or current owner does not match the NODARA record.')
  }
  if (ticketData[120] !== 1) throw new Error('The ticket has been invalidated on-chain.')
  if (ticketData[121] !== 1) throw new Error('The ticket has not been checked in on-chain.')
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
