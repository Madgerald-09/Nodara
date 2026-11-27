import { createClient } from 'npm:@supabase/supabase-js@2'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const PROGRAM_ID = new PublicKey('CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf')
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
// Anchor 0.30.1 IDL values bundled in src/idl/nodara_tickets.json.
const TRANSFER_TICKET = Uint8Array.from([191, 184, 74, 239, 164, 172, 188, 32])
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' }

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST for transfer verification.' }, 405)
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcUrl = Deno.env.get('SOLANA_DEVNET_RPC_URL') || 'https://api.devnet.solana.com'
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Server verification is not configured.')
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to transfer tickets.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your NODARA session could not be verified. Sign in again.' }, 401)
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const body = await request.json() as { ticketId?: string; signature?: string; senderWallet?: string; recipientWallet?: string }
    const ticketId = body.ticketId || ''
    const signature = body.signature || ''
    if (!isUuid(ticketId) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return respond({ error: 'Ticket ID or transaction signature is invalid.' }, 400)
    const sender = new PublicKey(body.senderWallet || '')
    const recipient = new PublicKey(body.recipientWallet || '')
    if (sender.equals(recipient)) return respond({ error: 'Choose a different recipient wallet.' }, 400)

    const { data: repeated, error: repeatError } = await admin.from('ticket_transfer_history')
      .select('ticket_id,event_id,from_wallet,to_wallet,solana_network').eq('transaction_signature', signature).maybeSingle()
    if (repeatError) throw new Error('Could not check the transfer history for duplicate processing.')
    if (repeated) {
      if (repeated.ticket_id === ticketId && repeated.from_wallet === sender.toBase58() && repeated.to_wallet === recipient.toBase58() && repeated.solana_network === 'devnet') {
        return respond({ verified: true, idempotent: true })
      }
      return respond({ error: 'This transaction signature has already been used for another transfer.' }, 409)
    }

    const { data: ticket, error: ticketError } = await admin.from('tickets')
      .select('id,event_id,status,holder_user_id,blockchain_status,solana_network,solana_program_id,solana_ticket_account,solana_event_account,wallet_address')
      .eq('id', ticketId).maybeSingle()
    if (ticketError) throw new Error('Could not load ticket ownership for transfer verification.')
    if (!ticket) return respond({ error: 'Ticket was not found.' }, 404)
    if (ticket.holder_user_id !== auth.user.id) return respond({ error: 'Only the current NODARA ticket holder can verify this transfer.' }, 403)
    if (ticket.status !== 'issued' || ticket.blockchain_status !== 'verified' || ticket.solana_network !== 'devnet'
      || ticket.solana_program_id !== PROGRAM_ID.toBase58() || !ticket.solana_ticket_account || !ticket.solana_event_account
      || ticket.wallet_address !== sender.toBase58()) {
      return respond({ error: 'This ticket is not eligible for an on-chain transfer from the connected wallet.' }, 409)
    }

    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara-transfer-verify', method, params }) })
      if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`)
      const result = await response.json() as { result?: unknown; error?: { message?: string } }
      if (result.error || result.result === undefined) throw new Error(result.error?.message || 'Devnet RPC did not return a result.')
      return result.result
    }
    if (await rpc('getGenesisHash', []) !== DEVNET_GENESIS_HASH) return respond({ error: 'The configured RPC is not Solana Devnet.' }, 503)

    const eventId = uuidBytes(ticket.event_id)
    const ticketBytes = uuidBytes(ticketId)
    const [eventPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('event'), eventId], PROGRAM_ID)
    const [ticketPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('ticket'), eventPda.toBytes(), ticketBytes], PROGRAM_ID)
    if (ticketPda.toBase58() !== ticket.solana_ticket_account || eventPda.toBase58() !== ticket.solana_event_account) return respond({ error: 'Stored ticket accounts do not match the deployed program PDA seeds.' }, 409)

    const tx = await rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }]) as TransactionResult | null
    if (!tx || tx.meta?.err) return respond({ error: 'The transaction is missing, not finalized or failed on Devnet.' }, 409)
    const keys = tx.transaction.message.accountKeys.map(key => typeof key === 'string' ? { pubkey: key, signer: false } : key)
    if (!keys.some(key => key.pubkey === sender.toBase58() && key.signer)) return respond({ error: 'The current ticket owner did not sign the transfer.' }, 403)
    const programInstructions = tx.transaction.message.instructions.filter(ix => keys[ix.programIdIndex]?.pubkey === PROGRAM_ID.toBase58())
    if (programInstructions.length !== 1) return respond({ error: 'Transaction must contain exactly one NODARA program instruction.' }, 409)
    const instruction = programInstructions[0]
    const instructionData = base58Decode(instruction.data)
    const instructionAccounts = instruction.accounts.map(index => keys[index]?.pubkey)
    if (instructionData.length !== 24 || !equalPrefix(instructionData, TRANSFER_TICKET) || !equalBytes(instructionData.slice(8), ticketBytes)
      || instructionAccounts.length !== 6 || instructionAccounts[0] !== sender.toBase58() || instructionAccounts[1] !== eventPda.toBase58()
      || instructionAccounts[2] !== ticketPda.toBase58() || instructionAccounts[3] !== recipient.toBase58() || instructionAccounts[5] !== SYSTEM_PROGRAM) {
      return respond({ error: 'The signed transaction does not match the requested ticket, sender and recipient.' }, 409)
    }

    const [eventAccount, ticketAccount] = await Promise.all([
      rpc('getAccountInfo', [eventPda.toBase58(), { encoding: 'base64', commitment: 'finalized' }]) as Promise<AccountResult>,
      rpc('getAccountInfo', [ticketPda.toBase58(), { encoding: 'base64', commitment: 'finalized' }]) as Promise<AccountResult>,
    ])
    const eventData = dataBytes(eventAccount)
    const ticketData = dataBytes(ticketAccount)
    if (!eventData || !ticketData || eventAccount.value?.owner !== PROGRAM_ID.toBase58() || ticketAccount.value?.owner !== PROGRAM_ID.toBase58()) return respond({ error: 'The event or ticket account is missing or owned by another program.' }, 409)
    if (eventData.length < 58 || ticketData.length < 127 || !equalBytes(eventData.slice(0, 8), Uint8Array.from([150, 209, 156, 235, 9, 198, 56, 184])) || !equalBytes(ticketData.slice(0, 8), Uint8Array.from([37, 215, 102, 48, 114, 66, 21, 87]))) return respond({ error: 'Devnet account data does not match the generated Anchor IDL.' }, 409)
    if (!equalBytes(eventData.slice(8, 24), eventId) || eventData[56] !== 1) return respond({ error: 'This event does not allow ticket transfers.' }, 409)
    if (!equalBytes(ticketData.slice(8, 24), ticketBytes) || !equalBytes(ticketData.slice(24, 56), eventPda.toBytes())
      || !equalBytes(ticketData.slice(88, 120), recipient.toBytes()) || ticketData[120] !== 1 || ticketData[121] !== 0) {
      return respond({ error: 'The finalized on-chain ticket is invalid or does not belong to the requested recipient.' }, 409)
    }
    const transferCount = new DataView(ticketData.buffer, ticketData.byteOffset + 122, 4).getUint32(0, true)
    if (transferCount < 1) return respond({ error: 'The ticket transfer counter was not incremented.' }, 409)
    const sequence = transferCount - 1
    const sequenceSeed = new Uint8Array(4)
    new DataView(sequenceSeed.buffer).setUint32(0, sequence, true)
    const [expectedReceipt] = PublicKey.findProgramAddressSync([new TextEncoder().encode('transfer'), ticketPda.toBytes(), sequenceSeed], PROGRAM_ID)
    if (instructionAccounts[4] !== expectedReceipt.toBase58()) return respond({ error: 'Transfer receipt PDA does not match the on-chain transfer sequence.' }, 409)
    const receiptAccount = await rpc('getAccountInfo', [expectedReceipt.toBase58(), { encoding: 'base64', commitment: 'finalized' }]) as AccountResult
    const receiptData = dataBytes(receiptAccount)
    if (!receiptData || receiptAccount.value?.owner !== PROGRAM_ID.toBase58() || receiptData.length < 109
      || !equalBytes(receiptData.slice(0, 8), Uint8Array.from([166, 220, 49, 50, 221, 185, 59, 55]))
      || !equalBytes(receiptData.slice(8, 40), ticketPda.toBytes()) || !equalBytes(receiptData.slice(40, 72), sender.toBytes())
      || !equalBytes(receiptData.slice(72, 104), recipient.toBytes()) || new DataView(receiptData.buffer, receiptData.byteOffset + 104, 4).getUint32(0, true) !== sequence) {
      return respond({ error: 'The confirmed transfer receipt does not match the sender and recipient.' }, 409)
    }

    const { data: recorded, error: recordError } = await admin.rpc('record_verified_ticket_transfer', {
      p_ticket_id: ticketId, p_event_id: ticket.event_id, p_current_user_id: auth.user.id,
      p_from_wallet: sender.toBase58(), p_to_wallet: recipient.toBase58(), p_signature: signature,
      p_program_id: PROGRAM_ID.toBase58(), p_ticket_account: ticketPda.toBase58(), p_event_account: eventPda.toBase58(),
      p_transfer_sequence: sequence, p_receipt_account: expectedReceipt.toBase58(),
    })
    if (recordError || !recorded?.recorded) return respond({ error: recordError?.message ?? 'Transfer was verified but ownership synchronization did not complete.' }, 409)
    return respond({ verified: true, signature, ticketAccount: ticketPda.toBase58(), eventAccount: eventPda.toBase58(), recipient: recipient.toBase58() })
  } catch (error) {
    console.error('verify-solana-transfer:', error)
    return respond({ error: error instanceof Error ? error.message : 'Transfer verification failed.' }, 400)
  }
})

type TransactionResult = {
  meta: { err: unknown | null } | null
  transaction: { message: { accountKeys: ({ pubkey: string; signer: boolean } | string)[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } }
}
type AccountResult = { value: { owner: string; data: [string, string] } | null }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function uuidBytes(value: string) { return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => Number.parseInt(byte, 16)) }
function dataBytes(account: AccountResult) { return account.value ? Uint8Array.from(atob(account.value.data[0]), char => char.charCodeAt(0)) : null }
function equalBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]) }
function equalPrefix(a: Uint8Array, b: Uint8Array) { return a.length >= b.length && b.every((value, index) => a[index] === value) }
function base58Decode(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Transaction has invalid base58 instruction data.'); number = number * 58n + BigInt(digit) }
  const bytes: number[] = []
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n }
  for (const char of value) { if (char !== '1') break; bytes.unshift(0) }
  return Uint8Array.from(bytes)
}
