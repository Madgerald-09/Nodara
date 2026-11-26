import { solanaConfigurationError, solanaProgramConfigurationError, solanaProgramId, solanaRpcUrl } from '../lib/solana'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'

export type ChainTicketResult = {
  verified: boolean
  owner?: string
  valid?: boolean
  checkedIn?: boolean
  error?: string
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(solanaRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara', method, params }),
  })
  if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`)
  const result = await response.json() as { result?: T; error?: { message?: string } }
  if (result.error || result.result === undefined) throw new Error(result.error?.message || 'Devnet RPC returned no result.')
  return result.result
}

export async function checkDevnetConnection() {
  if (solanaConfigurationError) throw new Error(solanaConfigurationError)
  const genesis = await rpc<string>('getGenesisHash')
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error('Configured RPC is not Solana Devnet.')
  return true
}

export async function verifyChainTicket(input: {
  ticketId: string
  eventId: string
  accountAddress: string | null
  eventAccountAddress: string | null
  connectedWallet: string | null
  expectedOwner?: string | null
}): Promise<ChainTicketResult> {
  if (solanaProgramConfigurationError) return { verified: false, error: solanaProgramConfigurationError }
  if (!solanaProgramId || !input.accountAddress || !input.eventAccountAddress) return { verified: false, error: 'This ticket or event has not been registered on the configured program.' }
  try {
    await checkDevnetConnection()
    const account = await rpc<{ value: { owner: string; data: [string, string] } | null }>(
      'getAccountInfo', [input.accountAddress, { encoding: 'base64', commitment: 'confirmed' }],
    )
    if (!account.value) return { verified: false, error: 'Ticket account was not found on Devnet.' }
    if (account.value.owner !== solanaProgramId) return { verified: false, error: 'Ticket account is owned by a different program.' }
    const bytes = Uint8Array.from(atob(account.value.data[0]), character => character.charCodeAt(0))
    const expectedDiscriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:TicketRecord'))).slice(0, 8)
    if (bytes.length < 127 || !expectedDiscriminator.every((byte, index) => bytes[index] === byte)) {
      return { verified: false, error: 'On-chain account data does not match the ticket program layout.' }
    }
    const uuid = input.ticketId.replaceAll('-', '')
    if (!/^[0-9a-f]{32}$/i.test(uuid)) return { verified: false, error: 'The NODARA ticket identifier is invalid.' }
    const expectedId = Uint8Array.from(uuid.match(/.{2}/g)!, byte => Number.parseInt(byte, 16))
    if (!expectedId.every((byte, index) => bytes[8 + index] === byte)) {
      return { verified: false, error: 'On-chain ticket identifier does not match this NODARA ticket.' }
    }
    if (encodeBase58(bytes.slice(8 + 16, 8 + 16 + 32)) !== input.eventAccountAddress) {
      return { verified: false, error: 'On-chain event does not match this NODARA event.' }
    }
    const eventAccount = await rpc<{ value: { owner: string; data: [string, string] } | null }>(
      'getAccountInfo', [input.eventAccountAddress, { encoding: 'base64', commitment: 'confirmed' }],
    )
    if (!eventAccount.value || eventAccount.value.owner !== solanaProgramId) return { verified: false, error: 'On-chain event account was not found under the configured program.' }
    const eventBytes = Uint8Array.from(atob(eventAccount.value.data[0]), character => character.charCodeAt(0))
    const expectedEventDiscriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:EventRecord'))).slice(0, 8)
    const eventUuid = input.eventId.replaceAll('-', '')
    if (!/^[0-9a-f]{32}$/i.test(eventUuid) || eventBytes.length < 58 || !expectedEventDiscriminator.every((byte, index) => eventBytes[index] === byte)) {
      return { verified: false, error: 'On-chain event account data does not match the event program layout.' }
    }
    const expectedEventId = Uint8Array.from(eventUuid.match(/.{2}/g)!, byte => Number.parseInt(byte, 16))
    if (!expectedEventId.every((byte, index) => eventBytes[8 + index] === byte)) return { verified: false, error: 'On-chain event identifier does not match this NODARA event.' }
    const owner = encodeBase58(bytes.slice(8 + 16 + 32 + 32, 8 + 16 + 32 + 32 + 32))
    const valid = bytes[8 + 16 + 32 + 32 + 32] === 1
    const checkedIn = bytes[8 + 16 + 32 + 32 + 32 + 1] === 1
    const expectedOwner = input.connectedWallet ?? input.expectedOwner ?? null
    return {
      verified: Boolean(valid && !checkedIn && expectedOwner && owner === expectedOwner),
      owner,
      valid,
      checkedIn,
      error: !valid ? 'This ticket is invalid on-chain.' : !expectedOwner ? 'No trusted wallet is linked to this ticket for an ownership check.' : owner !== expectedOwner ? 'On-chain owner does not match the trusted ticket wallet.' : checkedIn ? 'This ticket has already been checked in on-chain.' : undefined,
    }
  } catch (error) {
    return { verified: false, error: error instanceof Error ? error.message : 'Could not verify this ticket on Devnet.' }
  }
}

function encodeBase58(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let output = ''
  while (value > 0n) {
    const remainder = Number(value % 58n)
    output = alphabet[remainder] + output
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    output = `1${output}`
  }
  return output || '1'
}
